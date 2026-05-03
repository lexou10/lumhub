import { Router, Request, Response } from 'express'
import { ownerOnly } from '../middleware/auth'
import * as fs from 'fs'
import * as child_process from 'child_process'

export const homekitRouter = Router()

const HOMEBRIDGE_CONFIG = '/home/pi/.homebridge/config.json'

function getConfig(): any {
  return JSON.parse(fs.readFileSync(HOMEBRIDGE_CONFIG, 'utf8'))
}

function saveConfig(config: any): void {
  fs.writeFileSync(HOMEBRIDGE_CONFIG, JSON.stringify(config, null, 4))
}

function generatePin(): string {
  // Format XXX-XX-XXX, évite 000-00-000 et séquences invalides HomeKit
  const a = String(Math.floor(Math.random() * 900) + 100)
  const b = String(Math.floor(Math.random() * 90) + 10)
  const c = String(Math.floor(Math.random() * 900) + 100)
  return `${a}-${b}-${c}`
}

// GET /api/v1/homekit
homekitRouter.get('/', ownerOnly, (req: Request, res: Response) => {
  try {
    const config = getConfig()
    const pin = config.bridge?.pin || '000-00-000'
    const username = config.bridge?.username || ''
    const port = config.bridge?.port || 51828
    res.json({ pin, username, port })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/v1/homekit/regenerate
homekitRouter.post('/regenerate', ownerOnly, (req: Request, res: Response) => {
  try {
    const config = getConfig()
    const newPin = generatePin()
    config.bridge.pin = newPin
    saveConfig(config)

    // Redémarre Homebridge pour appliquer le nouveau PIN
    child_process.exec('sudo systemctl restart homebridge', (err: any) => {
      if (err) console.error('[HomeKit] Erreur restart homebridge:', err.message)
    })

    res.json({ pin: newPin, message: 'PIN régénéré, Homebridge redémarre...' })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/v1/homekit/reset — réinitialise le cache Homebridge + recrée le token
homekitRouter.post('/reset', async (req, res) => {
  try {
    const { exec } = require('child_process')
    const { getDb } = require('../../database')
    const crypto = require('crypto')
    const db = getDb()

    // Recréer le token Homebridge
    const newToken = 'hb_' + crypto.randomBytes(32).toString('hex')
    db.prepare("DELETE FROM api_tokens WHERE name = 'homebridge'").run()
    db.prepare("INSERT INTO api_tokens (name, token) VALUES ('homebridge', ?)").run(newToken)

    // Mettre à jour le token dans config.json Homebridge
    const configPath = '/home/pi/.homebridge/config.json'
    const config = JSON.parse(require('fs').readFileSync(configPath, 'utf8'))
    if (config.platforms) {
      config.platforms = config.platforms.map((p: any) => {
        if (p.platform === 'LumHub') { p.token = newToken }
        return p
      })
    }
    require('fs').writeFileSync(configPath, JSON.stringify(config, null, 4))

    // Reset cache et redémarrage
    exec('sudo systemctl stop homebridge && rm -f /home/pi/.homebridge/accessories/cachedAccessories /home/pi/.homebridge/persist/*.json && sudo systemctl start homebridge', (err: any) => {
      if (err) console.error('[HomeKit Reset]', err.message)
    })

    res.json({ success: true, message: 'Réinitialisation en cours, token Homebridge recréé...' })
  } catch(e: any) {
    res.status(500).json({ error: e.message })
  }
})
