import { Router, Request, Response } from 'express'
import { getDb } from '../../database'
import { sendCommand } from '../../services/zigbee'

export const poolRouter = Router()

// ── GET /api/v1/pool — état complet de la piscine
poolRouter.get('/', (req: Request, res: Response) => {
  const db = getDb()
  const pool = db.prepare(`
    SELECT p.*,
      d1.name as pump_name, d1.ieee_address as pump_ieee,
      d2.name as temp_name, d2.ieee_address as temp_ieee
    FROM pools p
    LEFT JOIN devices d1 ON d1.id = p.pump_device_id
    LEFT JOIN devices d2 ON d2.id = p.temp_device_id
  `).get() as any

  if (!pool) { res.json(null); return }

  const programs = db.prepare(`
    SELECT * FROM pool_programs WHERE pool_id = ? ORDER BY sort_order
  `).all(pool.id) as any[]

  for (const prog of programs) {
    prog.slots = db.prepare(`
      SELECT * FROM pool_slots WHERE program_id = ? ORDER BY time_start
    `).all(prog.id)
  }

  // Température actuelle
  let currentTemp: number | null = null
  if (pool.temp_device_id) {
    const tempState = db.prepare(`
      SELECT value FROM device_states WHERE device_id = ? AND key = 'temperature'
    `).get(pool.temp_device_id) as any
    if (tempState) {
      const raw = parseFloat(tempState.value)
      currentTemp = raw > 100 ? raw / 100 : raw
    }
  }

  // État pompe
  let pumpOn = false
  if (pool.pump_device_id) {
    const pumpState = db.prepare(`
      SELECT value FROM device_states WHERE device_id = ? AND key = 'state'
    `).get(pool.pump_device_id) as any
    pumpOn = pumpState?.value === 'on'
  }

  // Programme actif
  let activeProgram = null
  if (currentTemp !== null) {
    activeProgram = programs.find(p => {
      const aboveMin = p.temp_min === null || currentTemp! >= p.temp_min
      const belowMax = p.temp_max === null || currentTemp! < p.temp_max
      return aboveMin && belowMax
    }) || null
  }

  // Prochain créneau
  const now = new Date()
  const nowStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`
  let nextSlot = null
  if (activeProgram?.slots) {
    nextSlot = activeProgram.slots.find((s: any) => s.time_start > nowStr) ||
               activeProgram.slots[0] || null
  }

  res.json({
    ...pool,
    programs,
    current_temp: currentTemp,
    pump_on: pumpOn,
    active_program: activeProgram,
    next_slot: nextSlot
  })
})

// ── POST /api/v1/pool — créer la piscine
poolRouter.post('/', (req: Request, res: Response) => {
  const db = getDb()
  const { name, pump_device_id, temp_device_id } = req.body
  const result = db.prepare(`
    INSERT INTO pools (name, pump_device_id, temp_device_id) VALUES (?, ?, ?)
  `).run(name || 'Piscine', pump_device_id || null, temp_device_id || null)
  res.json({ id: result.lastInsertRowid })
})

// ── PATCH /api/v1/pool — modifier (mode, devices)
poolRouter.patch('/', async (req: Request, res: Response) => {
  const db = getDb()
  const pool = db.prepare('SELECT * FROM pools').get() as any
  if (!pool) { res.status(404).json({ error: 'Piscine non configurée' }); return }

  const { mode, pump_device_id, temp_device_id, name } = req.body

  db.prepare(`
    UPDATE pools SET
      mode = COALESCE(?, mode),
      pump_device_id = COALESCE(?, pump_device_id),
      temp_device_id = COALESCE(?, temp_device_id),
      name = COALESCE(?, name)
    WHERE id = ?
  `).run(mode ?? null, pump_device_id ?? null, temp_device_id ?? null, name ?? null, pool.id)

  // Si mode forcé, agir immédiatement sur la pompe
  if (mode && pool.pump_device_id) {
    const device = db.prepare('SELECT ieee_address FROM devices WHERE id = ?').get(pool.pump_device_id) as any
    if (device) {
      if (mode === 'forced_on')  await sendCommand(device.ieee_address, 'state', 'ON').catch(() => {})
      if (mode === 'forced_off') await sendCommand(device.ieee_address, 'state', 'OFF').catch(() => {})
    }
  }

  res.json({ success: true })
})

// ── POST /api/v1/pool/programs — ajouter un programme
poolRouter.post('/programs', (req: Request, res: Response) => {
  const db = getDb()
  const pool = db.prepare('SELECT id FROM pools').get() as any
  if (!pool) { res.status(404).json({ error: 'Piscine non configurée' }); return }

  const { name, temp_min, temp_max, sort_order } = req.body
  const result = db.prepare(`
    INSERT INTO pool_programs (pool_id, name, temp_min, temp_max, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `).run(pool.id, name, temp_min ?? null, temp_max ?? null, sort_order ?? 0)

  res.json({ id: result.lastInsertRowid })
})

// ── PATCH /api/v1/pool/programs/:id — modifier un programme
poolRouter.patch('/programs/:id', (req: Request, res: Response) => {
  const db = getDb()
  const { name, temp_min, temp_max, sort_order } = req.body
  db.prepare(`
    UPDATE pool_programs SET
      name = COALESCE(?, name),
      temp_min = ?,
      temp_max = ?,
      sort_order = COALESCE(?, sort_order)
    WHERE id = ?
  `).run(name ?? null, temp_min ?? null, temp_max ?? null, sort_order ?? null, req.params.id)
  res.json({ success: true })
})

// ── DELETE /api/v1/pool/programs/:id — supprimer un programme
poolRouter.delete('/programs/:id', (req: Request, res: Response) => {
  const db = getDb()
  db.prepare('DELETE FROM pool_programs WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})

// ── POST /api/v1/pool/programs/:id/slots — ajouter un créneau
poolRouter.post('/programs/:id/slots', (req: Request, res: Response) => {
  const db = getDb()
  const { time_start, time_end } = req.body
  if (!time_start || !time_end) { res.status(400).json({ error: 'time_start et time_end requis' }); return }
  const result = db.prepare(`
    INSERT INTO pool_slots (program_id, time_start, time_end) VALUES (?, ?, ?)
  `).run(req.params.id, time_start, time_end)
  res.json({ id: result.lastInsertRowid })
})

// ── DELETE /api/v1/pool/slots/:id — supprimer un créneau
poolRouter.delete('/slots/:id', (req: Request, res: Response) => {
  const db = getDb()
  db.prepare('DELETE FROM pool_slots WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})

// DELETE /api/v1/pool — supprimer la piscine
poolRouter.delete('/', (req: Request, res: Response) => {
  const db = getDb()
  const pool = db.prepare('SELECT id FROM pools').get() as any
  if (!pool) { res.status(404).json({ error: 'Piscine non configurée' }); return }
  db.prepare('DELETE FROM pools WHERE id = ?').run(pool.id)
  res.json({ success: true })
})
