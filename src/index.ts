import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { createServer } from 'http'
import { exec } from 'child_process'
import { initDb, closeDb } from './database'
import { loadProfiles } from './services/deviceProfiles'
import { initWebSocket } from './websocket'
import { router } from './api/router'
import updateRoutes from './api/routes/update'
import { authMiddleware } from './api/middleware/auth'
import path from 'path'

const { startZigbeeService, stopZigbeeService } = require('../dist/services/zigbee')
const { startThermostatService, stopThermostatService } = require('../dist/services/thermostat')
const { startAutomationService, stopAutomationService } = require('./services/automations')
const { startPoolService, stopPoolService } = require('./services/pool')
const { startIrrigationService, stopIrrigationService } = require('./services/irrigation')
const { startFeederService, stopFeederService } = require('./services/feeder')

const PORT = parseInt(process.env.PORT || '3000', 10)
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000  // 6 heures

function scheduleUpdateCheck() {
  const check = () => {
    exec('sudo /usr/local/bin/lumhub-updater.sh check', (err) => {
      if (err) console.error('[update] Vérification auto échouée:', err.message)
      else console.log('[update] Vérification auto effectuée')
    })
  }
  setTimeout(check, 60_000)          // 1 min après démarrage
  setInterval(check, CHECK_INTERVAL_MS)
}

async function start() {
  console.log('╔══════════════════════════════╗')
  console.log('║       LumHub Server v1.0     ║')
  console.log('╚══════════════════════════════╝')

  initDb()
  loadProfiles()
  await startZigbeeService()
  startThermostatService()
  startAutomationService()
  startPoolService()
  startIrrigationService()
  startFeederService()

  const app = express()
  app.use(helmet({
    contentSecurityPolicy: false
  }))
  app.use(cors({ origin: '*' }))
  app.use(express.json())

  app.use('/api/v1', router)
  app.use('/api/v1/update', authMiddleware, updateRoutes)

  app.get('/health', (_, res) => res.json({ status: 'ok', version: '1.0.0', uptime: process.uptime() }))
app.use(express.static(path.join(__dirname, '../public')))
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'))
})
  const httpServer = createServer(app)
  initWebSocket(httpServer)

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] En écoute sur le port ${PORT}`)
    scheduleUpdateCheck()
  })

  const shutdown = () => {
    console.log('\n[Server] Arrêt en cours...')
    stopThermostatService()
    stopIrrigationService()
    stopFeederService()
    stopZigbeeService()
    httpServer.close(() => { closeDb(); process.exit(0) })
  }

  // Signal LED : serveur prêt
  httpServer.on('listening', () => {
    setTimeout(() => {
      const net = require('net')
      const sock = net.createConnection('/run/lumhub-leds.sock')
      sock.on('connect', () => { sock.write('ok'); sock.end() })
      sock.on('error', () => {}) // ignorer si leds pas dispo
    }, 1000)
  })

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  process.on('uncaughtException', (err) => console.error('[Server] Erreur non gérée:', err))
  process.on('unhandledRejection', (reason) => console.error('[Server] Promise rejetée:', reason))
}

start()
