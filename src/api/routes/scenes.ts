import { Router, Request, Response } from 'express'
import { getDb } from '../../database'
import { ownerOrUser } from '../middleware/auth'

export const scenesRouter = Router()

// GET /api/v1/scenes
scenesRouter.get('/', (req: Request, res: Response) => {
  const db = getDb()
  const scenes = db.prepare('SELECT * FROM scenes ORDER BY name').all()
  const actions = db.prepare(`
    SELECT sa.*, d.name as device_name, d.type as device_type
    FROM scene_actions sa
    JOIN devices d ON d.id = sa.device_id
    ORDER BY sa.sort_order
  `).all()

  const result = scenes.map((s: any) => ({
    ...s,
    actions: actions.filter((a: any) => a.scene_id === s.id)
  }))
  res.json(result)
})

// POST /api/v1/scenes
scenesRouter.post('/', ownerOrUser, (req: Request, res: Response) => {
  const { name, icon = 'scene', color = '#FF6B35', actions = [] } = req.body
  if (!name) { res.status(400).json({ error: 'Nom requis' }); return }

  const db = getDb()
  const scene = db.prepare(
    'INSERT INTO scenes (name, icon, color, created_by) VALUES (?, ?, ?, ?)'
  ).run(name, icon, color, req.user!.id)

  const insertAction = db.prepare(`
    INSERT INTO scene_actions (scene_id, device_id, action, delay_ms, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `)

  db.transaction(() => {
    actions.forEach((a: any, i: number) => {
      insertAction.run(scene.lastInsertRowid, a.device_id, JSON.stringify(a.action), a.delay_ms || 0, i)
    })
  })()

  res.status(201).json({ id: scene.lastInsertRowid })
})

// POST /api/v1/scenes/:id/activate
scenesRouter.post('/:id/activate', (req: Request, res: Response) => {
  const db = getDb()
  const actions = db.prepare(`
    SELECT sa.*, d.ieee_address, d.id as device_id
    FROM scene_actions sa
    JOIN devices d ON d.id = sa.device_id
    WHERE sa.scene_id = ?
    ORDER BY sa.sort_order
  `).all(req.params.id) as any[]

  if (!actions.length) { res.status(404).json({ error: 'Scène non trouvée ou vide' }); return }

  // Exécuter chaque action avec le délai optionnel
  for (const a of actions) {
    const action = JSON.parse(a.action)
    setTimeout(() => {
      db.prepare(`
        INSERT INTO device_states (device_id, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(device_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(a.device_id, action.key, String(action.value))

      // TODO: broadcastDeviceState + zigbeeService.sendCommand
    }, a.delay_ms)
  }

  res.json({ success: true, actions_count: actions.length })
})

// DELETE /api/v1/scenes/:id
scenesRouter.delete('/:id', ownerOrUser, (req: Request, res: Response) => {
  getDb().prepare('DELETE FROM scenes WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})
