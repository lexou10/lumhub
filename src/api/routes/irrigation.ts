import { Router, Request, Response } from 'express'
import { getDb } from '../../database'
import { sendCommand } from '../../services/zigbee'

export const irrigationRouter = Router()

// ── GET /api/v1/irrigation
irrigationRouter.get('/', (req: Request, res: Response) => {
  const db = getDb()
  const irrigation = db.prepare('SELECT * FROM irrigation').get() as any
  if (!irrigation) { res.json(null); return }

  const zones = db.prepare(`
    SELECT z.*, d.name as device_name, d.ieee_address as device_ieee
    FROM irrigation_zones z
    LEFT JOIN devices d ON d.id = z.device_id
    WHERE z.irrigation_id = ? ORDER BY z.sort_order
  `).all(irrigation.id) as any[]

  for (const zone of zones) {
    zone.schedules = db.prepare(`
      SELECT * FROM irrigation_schedules WHERE zone_id = ? ORDER BY time_start
    `).all(zone.id)
    zone.logs = db.prepare(`
      SELECT * FROM irrigation_logs WHERE zone_id = ? ORDER BY started_at DESC LIMIT 10
    `).all(zone.id)
    // État actuel
    const state = db.prepare(`
      SELECT value FROM device_states WHERE device_id = ? AND key = 'state'
    `).get(zone.device_id) as any
    zone.is_active = state?.value === 'ON' || state?.value === 'on'
  }

  const conditions = db.prepare(`
    SELECT c.*, d.name as device_name FROM irrigation_conditions c
    LEFT JOIN devices d ON d.id = c.device_id
    WHERE c.irrigation_id = ?
  `).all(irrigation.id)

  res.json({ ...irrigation, zones, conditions })
})

// ── POST /api/v1/irrigation — créer
irrigationRouter.post('/', (req: Request, res: Response) => {
  const db = getDb()
  const { name } = req.body
  const result = db.prepare('INSERT INTO irrigation (name) VALUES (?)').run(name || 'Arrosage')
  res.json({ id: result.lastInsertRowid })
})

// ── PATCH /api/v1/irrigation — modifier
irrigationRouter.patch('/', (req: Request, res: Response) => {
  const db = getDb()
  const irrigation = db.prepare('SELECT * FROM irrigation').get() as any
  if (!irrigation) { res.status(404).json({ error: 'Arrosage non configuré' }); return }
  const { name, enabled } = req.body
  db.prepare(`UPDATE irrigation SET name = COALESCE(?, name), enabled = COALESCE(?, enabled) WHERE id = ?`)
    .run(name ?? null, enabled !== undefined ? (enabled ? 1 : 0) : null, irrigation.id)
  res.json({ success: true })
})

// ── DELETE /api/v1/irrigation
irrigationRouter.delete('/', (req: Request, res: Response) => {
  const db = getDb()
  const irrigation = db.prepare('SELECT id FROM irrigation').get() as any
  if (!irrigation) { res.status(404).json({ error: 'Arrosage non configuré' }); return }
  db.prepare('DELETE FROM irrigation WHERE id = ?').run(irrigation.id)
  res.json({ success: true })
})

// ── POST /api/v1/irrigation/zones — ajouter zone
irrigationRouter.post('/zones', (req: Request, res: Response) => {
  const db = getDb()
  const irrigation = db.prepare('SELECT id FROM irrigation').get() as any
  if (!irrigation) { res.status(404).json({ error: 'Arrosage non configuré' }); return }
  const { name, device_id, sort_order } = req.body
  const result = db.prepare(`
    INSERT INTO irrigation_zones (irrigation_id, name, device_id, sort_order) VALUES (?, ?, ?, ?)
  `).run(irrigation.id, name || 'Zone', device_id || null, sort_order || 0)
  res.json({ id: result.lastInsertRowid })
})

// ── PATCH /api/v1/irrigation/zones/:id
irrigationRouter.patch('/zones/:id', (req: Request, res: Response) => {
  const db = getDb()
  const { name, device_id, sort_order } = req.body
  db.prepare(`UPDATE irrigation_zones SET name = COALESCE(?, name), device_id = COALESCE(?, device_id), sort_order = COALESCE(?, sort_order) WHERE id = ?`)
    .run(name ?? null, device_id ?? null, sort_order ?? null, req.params.id)
  res.json({ success: true })
})

// ── DELETE /api/v1/irrigation/zones/:id
irrigationRouter.delete('/zones/:id', (req: Request, res: Response) => {
  const db = getDb()
  db.prepare('DELETE FROM irrigation_zones WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})

// ── POST /api/v1/irrigation/zones/:id/trigger — activer manuellement
irrigationRouter.post('/zones/:id/trigger', async (req: Request, res: Response) => {
  const db = getDb()
  const zone = db.prepare(`
    SELECT z.*, d.ieee_address FROM irrigation_zones z
    LEFT JOIN devices d ON d.id = z.device_id WHERE z.id = ?
  `).get(req.params.id) as any
  if (!zone) { res.status(404).json({ error: 'Zone introuvable' }); return }
  if (!zone.ieee_address) { res.status(400).json({ error: 'Aucun appareil configuré' }); return }

  const { action } = req.body // 'on' ou 'off'
  try {
    await sendCommand(zone.ieee_address, 'state', action === 'off' ? 'OFF' : 'ON')
    if (action === 'off') {
      db.prepare(`UPDATE irrigation_logs SET ended_at = CURRENT_TIMESTAMP WHERE zone_id = ? AND ended_at IS NULL`)
        .run(zone.id)
    } else {
      db.prepare(`INSERT INTO irrigation_logs (zone_id, trigger) VALUES (?, 'manual')`).run(zone.id)
    }
    res.json({ success: true })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
})

// ── POST /api/v1/irrigation/zones/:id/schedules
irrigationRouter.post('/zones/:id/schedules', (req: Request, res: Response) => {
  const db = getDb()
  const { days_of_week, time_start, time_end, enabled } = req.body
  if (!time_start || !time_end) { res.status(400).json({ error: 'time_start et time_end requis' }); return }
  const result = db.prepare(`
    INSERT INTO irrigation_schedules (zone_id, days_of_week, time_start, time_end, enabled) VALUES (?, ?, ?, ?, ?)
  `).run(req.params.id, days_of_week || '1,2,3,4,5,6,7', time_start, time_end, enabled !== false ? 1 : 0)
  res.json({ id: result.lastInsertRowid })
})

// ── PATCH /api/v1/irrigation/schedules/:id
irrigationRouter.patch('/schedules/:id', (req: Request, res: Response) => {
  const db = getDb()
  const { days_of_week, time_start, time_end, enabled } = req.body
  db.prepare(`UPDATE irrigation_schedules SET
    days_of_week = COALESCE(?, days_of_week),
    time_start = COALESCE(?, time_start),
    time_end = COALESCE(?, time_end),
    enabled = COALESCE(?, enabled)
    WHERE id = ?`).run(days_of_week ?? null, time_start ?? null, time_end ?? null,
    enabled !== undefined ? (enabled ? 1 : 0) : null, req.params.id)
  res.json({ success: true })
})

// ── DELETE /api/v1/irrigation/schedules/:id
irrigationRouter.delete('/schedules/:id', (req: Request, res: Response) => {
  const db = getDb()
  db.prepare('DELETE FROM irrigation_schedules WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})

// ── POST /api/v1/irrigation/conditions — ajouter condition
irrigationRouter.post('/conditions', (req: Request, res: Response) => {
  const db = getDb()
  const irrigation = db.prepare('SELECT id FROM irrigation').get() as any
  if (!irrigation) { res.status(404).json({ error: 'Arrosage non configuré' }); return }
  const { type, device_id, operator, value, enabled } = req.body
  const result = db.prepare(`
    INSERT INTO irrigation_conditions (irrigation_id, type, device_id, operator, value, enabled) VALUES (?, ?, ?, ?, ?, ?)
  `).run(irrigation.id, type, device_id || null, operator || 'lt', value || null, enabled !== false ? 1 : 0)
  res.json({ id: result.lastInsertRowid })
})

// ── PATCH /api/v1/irrigation/conditions/:id
irrigationRouter.patch('/conditions/:id', (req: Request, res: Response) => {
  const db = getDb()
  const { type, device_id, operator, value, enabled } = req.body
  db.prepare(`UPDATE irrigation_conditions SET
    type = COALESCE(?, type), device_id = COALESCE(?, device_id),
    operator = COALESCE(?, operator), value = COALESCE(?, value),
    enabled = COALESCE(?, enabled) WHERE id = ?`)
    .run(type ?? null, device_id ?? null, operator ?? null, value ?? null,
    enabled !== undefined ? (enabled ? 1 : 0) : null, req.params.id)
  res.json({ success: true })
})

// ── DELETE /api/v1/irrigation/conditions/:id
irrigationRouter.delete('/conditions/:id', (req: Request, res: Response) => {
  const db = getDb()
  db.prepare('DELETE FROM irrigation_conditions WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})
