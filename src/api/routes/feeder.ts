import { Router, Request, Response } from 'express'
import { getDb } from '../../database'
import { sendCommand } from '../../services/zigbee'

export const feederRouter = Router()

// ── GET /api/v1/feeder
feederRouter.get('/', (req: Request, res: Response) => {
  const db = getDb()
  const feeder = db.prepare(`
    SELECT f.*, d.name as device_name, d.ieee_address as device_ieee
    FROM feeders f
    LEFT JOIN devices d ON d.id = f.device_id
  `).get() as any

  if (!feeder) { res.json(null); return }

  const schedules = db.prepare(`
    SELECT * FROM feeder_schedules WHERE feeder_id = ? ORDER BY time
  `).all(feeder.id)

  const logs = db.prepare(`
    SELECT * FROM feeder_logs WHERE feeder_id = ? ORDER BY distributed_at DESC LIMIT 20
  `).all(feeder.id)

  const now = new Date()
  const nowStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`
  const enabledSchedules = (schedules as any[]).filter(s => s.enabled)
  const nextSchedule = enabledSchedules.find(s => s.time > nowStr) || enabledSchedules[0] || null

  const todayStr = now.toISOString().slice(0, 10)
  const todayLogs = (logs as any[]).filter(l => l.distributed_at.startsWith(todayStr))
  const todayDoses = todayLogs.reduce((sum: number, l: any) => sum + l.doses, 0)

  res.json({ ...feeder, schedules, logs, next_schedule: nextSchedule, today_doses: todayDoses, today_meals: todayLogs.length })
})

// ── POST /api/v1/feeder — créer
feederRouter.post('/', (req: Request, res: Response) => {
  const db = getDb()
  const { name, device_id, doses_per_meal } = req.body
  const result = db.prepare(`
    INSERT INTO feeders (name, device_id, doses_per_meal) VALUES (?, ?, ?)
  `).run(name || 'Gamelle', device_id || null, doses_per_meal || 1)
  res.json({ id: result.lastInsertRowid })
})

// ── PATCH /api/v1/feeder — modifier
feederRouter.patch('/', (req: Request, res: Response) => {
  const db = getDb()
  const feeder = db.prepare('SELECT * FROM feeders').get() as any
  if (!feeder) { res.status(404).json({ error: 'Gamelle non configurée' }); return }
  const { name, device_id, doses_per_meal } = req.body
  db.prepare(`
    UPDATE feeders SET
      name = COALESCE(?, name),
      device_id = COALESCE(?, device_id),
      doses_per_meal = COALESCE(?, doses_per_meal)
    WHERE id = ?
  `).run(name ?? null, device_id ?? null, doses_per_meal ?? null, feeder.id)
  res.json({ success: true })
})

// ── DELETE /api/v1/feeder — supprimer
feederRouter.delete('/', (req: Request, res: Response) => {
  const db = getDb()
  const feeder = db.prepare('SELECT id FROM feeders').get() as any
  if (!feeder) { res.status(404).json({ error: 'Gamelle non configurée' }); return }
  db.prepare('DELETE FROM feeders WHERE id = ?').run(feeder.id)
  res.json({ success: true })
})

// ── POST /api/v1/feeder/feed — distribuer une dose
feederRouter.post('/feed', async (req: Request, res: Response) => {
  const db = getDb()
  const feeder = db.prepare(`
    SELECT f.*, d.ieee_address FROM feeders f
    LEFT JOIN devices d ON d.id = f.device_id
  `).get() as any
  if (!feeder) { res.status(404).json({ error: 'Gamelle non configurée' }); return }
  if (!feeder.ieee_address) { res.status(400).json({ error: 'Aucun appareil configuré' }); return }

  const doses = feeder.doses_per_meal || 1
  const trigger = req.body.trigger || 'manual'

  try {
    for (let i = 0; i < doses; i++) {
      await sendCommand(feeder.ieee_address, 'state', 'ON')
      await new Promise(resolve => setTimeout(resolve, 1000))
      await sendCommand(feeder.ieee_address, 'state', 'OFF')
      if (i < doses - 1) await new Promise(resolve => setTimeout(resolve, 10000))
    }
    db.prepare(`
      INSERT INTO feeder_logs (feeder_id, doses, trigger) VALUES (?, ?, ?)
    `).run(feeder.id, doses, trigger)
    res.json({ success: true, doses })
  } catch (e) {
    res.status(500).json({ error: 'Erreur lors de la distribution' })
  }
})

// ── POST /api/v1/feeder/schedules — ajouter horaire
feederRouter.post('/schedules', (req: Request, res: Response) => {
  const db = getDb()
  const feeder = db.prepare('SELECT id FROM feeders').get() as any
  if (!feeder) { res.status(404).json({ error: 'Gamelle non configurée' }); return }
  const { time, enabled } = req.body
  if (!time) { res.status(400).json({ error: 'time requis (HH:MM)' }); return }
  const result = db.prepare(`
    INSERT INTO feeder_schedules (feeder_id, time, enabled) VALUES (?, ?, ?)
  `).run(feeder.id, time, enabled !== false ? 1 : 0)
  res.json({ id: result.lastInsertRowid })
})

// ── PATCH /api/v1/feeder/schedules/:id — modifier horaire
feederRouter.patch('/schedules/:id', (req: Request, res: Response) => {
  const db = getDb()
  const { time, enabled } = req.body
  db.prepare(`
    UPDATE feeder_schedules SET
      time = COALESCE(?, time),
      enabled = COALESCE(?, enabled)
    WHERE id = ?
  `).run(time ?? null, enabled !== undefined ? (enabled ? 1 : 0) : null, req.params.id)
  res.json({ success: true })
})

// ── DELETE /api/v1/feeder/schedules/:id — supprimer horaire
feederRouter.delete('/schedules/:id', (req: Request, res: Response) => {
  const db = getDb()
  db.prepare('DELETE FROM feeder_schedules WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})
