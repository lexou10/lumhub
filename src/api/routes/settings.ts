import { Router, Request, Response } from 'express'
import { getDb } from '../../database'
import { getAllProfiles, getProfilesByCategory } from '../../services/deviceProfiles'

export const settingsRouter = Router()

// GET /api/v1/settings
settingsRouter.get('/', (_req: Request, res: Response) => {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as any[]
  const settings = Object.fromEntries(rows.map(r => [r.key, r.value]))
  res.json(settings)
})

// PATCH /api/v1/settings
settingsRouter.patch('/', (req: Request, res: Response) => {
  const db = getDb()
  const allowed = ['box_name', 'timezone', 'language', 'zigbee_channel']

  const update = db.prepare(`
    UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?
  `)

  db.transaction(() => {
    for (const [key, value] of Object.entries(req.body)) {
      if (allowed.includes(key)) {
        update.run(String(value), key)
      }
    }
  })()

  res.json({ success: true })
})


// POST /api/v1/settings/restart
settingsRouter.post('/restart', (_req: Request, res: Response) => {
  res.json({ success: true, message: 'Redémarrage du serveur...' })
  setTimeout(() => {
    const net = require('net')
    const sock = net.createConnection('/run/lumhub-leds.sock')
    sock.on('connect', () => { sock.write('warning'); sock.end() })
    sock.on('error', () => {})
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 300)
  }, 500)
})

// POST /api/v1/settings/reboot
settingsRouter.post('/reboot', (_req: Request, res: Response) => {
  res.json({ success: true, message: 'Redémarrage de la box...' })
  setTimeout(() => {
    require('child_process').exec('sudo reboot')
  }, 500)
})

// ——————————————————————————————————————

export const profilesRouter = Router()

// GET /api/v1/profiles
profilesRouter.get('/', (_req: Request, res: Response) => {
  res.json(getAllProfiles())
})

// GET /api/v1/profiles/category/:category
profilesRouter.get('/category/:category', (req: Request, res: Response) => {
  res.json(getProfilesByCategory(req.params.category))
})

// GET /api/v1/settings/sun — lever et coucher du soleil
settingsRouter.get('/sun', (req: Request, res: Response) => {
  const db = getDb()
  const latSetting = db.prepare("SELECT value FROM settings WHERE key = 'latitude'").get() as any
  const lonSetting = db.prepare("SELECT value FROM settings WHERE key = 'longitude'").get() as any
  const lat = parseFloat(latSetting?.value || '44.8378')
  const lon = parseFloat(lonSetting?.value || '-0.5792')

  const now = new Date()
  const rad = Math.PI / 180
  const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000)
  const B = (360 / 365) * (dayOfYear - 81) * rad
  const eqTime = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B)
  const decl = 23.45 * Math.sin(B) * rad
  const hourAngle = Math.acos(-Math.tan(lat * rad) * Math.tan(decl)) / rad
  const noon = 12 - (lon / 15) - (eqTime / 60)
  const offsetH = hourAngle / 15

  const toTime = (decimal: number) => {
    const d = new Date(now)
    d.setUTCHours(Math.floor(decimal), Math.round((decimal - Math.floor(decimal)) * 60), 0, 0)
    return d.toISOString()
  }

  res.json({
    sunrise: toTime(noon - offsetH),
    sunset: toTime(noon + offsetH),
    latitude: lat,
    longitude: lon
  })
})
