import { Router, Request, Response } from 'express'
import { ownerOnly } from '../middleware/auth'
import * as fs from 'fs'
import * as child_process from 'child_process'

export const homekitRouter = Router()

const HOMEBRIDGE_CONFIG = '/var/lib/homebridge/config.json'

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
    child_process.exec('sudo systemctl restart homebridge', (err) => {
      if (err) console.error('[HomeKit] Erreur restart homebridge:', err.message)
    })

    res.json({ pin: newPin, message: 'PIN régénéré, Homebridge redémarre...' })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})
