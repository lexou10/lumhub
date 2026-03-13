import { Router, Request, Response } from 'express'
import { getDb } from '../../database'
import { triggerCycle } from '../../services/thermostat'

export const thermostatsRouter = Router()

thermostatsRouter.get('/', (req: Request, res: Response) => {
  const db = getDb()
  const thermostats = db.prepare(`
    SELECT t.*, r.name as room_name
    FROM thermostats t
    LEFT JOIN rooms r ON r.id = t.room_id
    ORDER BY t.id
  `).all() as any[]

  const result = thermostats.map(t => {
    const schedules = db.prepare('SELECT * FROM thermostat_schedules WHERE thermostat_id = ?').all(t.id)
    return {
      id: t.id, room_id: t.room_id, room_name: t.room_name, name: t.name,
      enabled: t.enabled === 1 || t.enabled === true,
      mode: t.mode, target_temp: t.target_temp, away_temp: t.away_temp,
      hysteresis: t.hysteresis, schedules,
      current_temp: getCurrentTemp(db, t.room_id)
    }
  })
  res.json(result)
})

thermostatsRouter.get('/:id', (req: Request, res: Response) => {
  const db = getDb()
  const t = db.prepare(`SELECT t.*, r.name as room_name FROM thermostats t LEFT JOIN rooms r ON r.id = t.room_id WHERE t.id = ?`).get(req.params.id) as any
  if (!t) { res.status(404).json({ error: 'Thermostat non trouvé' }); return }
  const schedules = db.prepare('SELECT * FROM thermostat_schedules WHERE thermostat_id = ?').all(t.id)
  res.json({
    id: t.id, room_id: t.room_id, room_name: t.room_name, name: t.name,
    enabled: t.enabled === 1 || t.enabled === true,
    mode: t.mode, target_temp: t.target_temp, away_temp: t.away_temp,
    hysteresis: t.hysteresis, schedules,
    current_temp: getCurrentTemp(db, t.room_id)
  })
})

thermostatsRouter.post('/', (req: Request, res: Response) => {
  const db = getDb()
  const { room_id, name, target_temp = 19.0 } = req.body
  if (!room_id || !name) { res.status(400).json({ error: 'room_id et name requis' }); return }
  const result = db.prepare(`INSERT INTO thermostats (room_id, name, target_temp) VALUES (?, ?, ?)`).run(room_id, name, target_temp)
  const t = db.prepare('SELECT * FROM thermostats WHERE id = ?').get(result.lastInsertRowid) as any
  res.status(201).json({ ...t, enabled: t.enabled === 1, schedules: [] })
})

const updateThermostat = (req: Request, res: Response) => {
  const db = getDb()
  const t = db.prepare('SELECT * FROM thermostats WHERE id = ?').get(req.params.id) as any
  if (!t) { res.status(404).json({ error: 'Thermostat non trouvé' }); return }
  const { name, enabled, mode, target_temp, away_temp, hysteresis } = req.body
  db.prepare(`UPDATE thermostats SET name=COALESCE(?,name), enabled=COALESCE(?,enabled), mode=COALESCE(?,mode), target_temp=COALESCE(?,target_temp), away_temp=COALESCE(?,away_temp), hysteresis=COALESCE(?,hysteresis) WHERE id=?`)
    .run(name??null, enabled!==undefined?(enabled?1:0):null, mode??null, target_temp??null, away_temp??null, hysteresis??null, t.id)
  triggerCycle()
  res.json({ success: true })
}

thermostatsRouter.patch('/:id', updateThermostat)
thermostatsRouter.put('/:id', updateThermostat)

thermostatsRouter.delete('/:id', (req: Request, res: Response) => {
  const db = getDb()
  db.prepare('DELETE FROM thermostat_schedules WHERE thermostat_id = ?').run(req.params.id)
  db.prepare('DELETE FROM thermostats WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})

thermostatsRouter.post('/:id/schedules', (req: Request, res: Response) => {
  const db = getDb()
  const { day_of_week, time_start, time_end, target_temp, label } = req.body
  const result = db.prepare(`INSERT INTO thermostat_schedules (thermostat_id, day_of_week, time_start, time_end, target_temp, label) VALUES (?, ?, ?, ?, ?, ?)`).run(req.params.id, day_of_week, time_start, time_end, target_temp, label??null)
  res.status(201).json({ id: result.lastInsertRowid, thermostat_id: Number(req.params.id), day_of_week, time_start, time_end, target_temp, label })
})

thermostatsRouter.delete('/:thermostatId/schedules/:scheduleId', (req: Request, res: Response) => {
  const db = getDb()
  db.prepare('DELETE FROM thermostat_schedules WHERE id = ? AND thermostat_id = ?').run(req.params.scheduleId, req.params.thermostatId)
  res.json({ success: true })
})

function getCurrentTemp(db: any, roomId: number): number | null {
  const sensor = db.prepare(`SELECT ds.value FROM devices d JOIN device_states ds ON ds.device_id = d.id WHERE d.room_id = ? AND d.type = 'temperature_sensor' AND ds.key = 'temperature' LIMIT 1`).get(roomId) as any
  if (!sensor) return null
  const raw = parseFloat(sensor.value)
  if (isNaN(raw)) return null
  return raw > 100 ? raw / 100 : raw
}
