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
