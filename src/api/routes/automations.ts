import { Router, Request, Response } from 'express'
import { getDb } from '../../database'
import { ownerOrUser } from '../middleware/auth'

export const automationsRouter = Router()

// GET /api/v1/automations
automationsRouter.get('/', (req: Request, res: Response) => {
  const db = getDb()
  const automations = db.prepare('SELECT * FROM automations ORDER BY name').all()
  const actions = db.prepare(`
    SELECT aa.*, d.name as device_name
    FROM automation_actions aa
    JOIN devices d ON d.id = aa.device_id
    ORDER BY aa.sort_order
  `).all()

  const result = automations.map((a: any) => ({
    ...a,
    trigger_config: JSON.parse(a.trigger_config),
    condition: a.condition ? JSON.parse(a.condition) : null,
    actions: actions.filter((ac: any) => ac.automation_id === a.id).map((ac: any) => ({
      ...ac,
      action: JSON.parse(ac.action)
    }))
  }))
  res.json(result)
})

// POST /api/v1/automations
automationsRouter.post('/', ownerOrUser, (req: Request, res: Response) => {
  const { name, trigger_type, trigger_config, condition, actions = [] } = req.body
  if (!name || !trigger_type) {
    res.status(400).json({ error: 'Nom et type de déclencheur requis' }); return
  }

  const db = getDb()
  const auto = db.prepare(`
    INSERT INTO automations (name, trigger_type, trigger_config, condition, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, trigger_type, JSON.stringify(trigger_config || {}), condition ? JSON.stringify(condition) : null, req.user!.id)

  const insertAction = db.prepare(`
    INSERT INTO automation_actions (automation_id, device_id, action, delay_ms, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `)

  db.transaction(() => {
    actions.forEach((a: any, i: number) => {
      insertAction.run(auto.lastInsertRowid, a.device_id, JSON.stringify(a.action), a.delay_ms || 0, i)
    })
  })()

  res.status(201).json({ id: auto.lastInsertRowid })
})

// PATCH /api/v1/automations/:id/toggle
automationsRouter.patch('/:id/toggle', ownerOrUser, (req: Request, res: Response) => {
  const db = getDb()
  const auto = db.prepare('SELECT id, enabled FROM automations WHERE id = ?').get(req.params.id) as any
  if (!auto) { res.status(404).json({ error: 'Automation non trouvée' }); return }

  db.prepare('UPDATE automations SET enabled = ? WHERE id = ?').run(auto.enabled ? 0 : 1, auto.id)
  res.json({ enabled: !auto.enabled })
})

// DELETE /api/v1/automations/:id
automationsRouter.delete('/:id', ownerOrUser, (req: Request, res: Response) => {
  getDb().prepare('DELETE FROM automations WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})
