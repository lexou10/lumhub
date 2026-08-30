import { Router, Request, Response } from 'express'
import { getDb } from '../../database'
import { sendCommand } from '../../services/zigbee'

export const gateRouter = Router()

gateRouter.get('/', (req: Request, res: Response) => {
  const db = getDb()
  const gate = db.prepare(`
    SELECT g.*,
      d1.name as device_name, d1.ieee_address as device_ieee,
      d2.name as sensor_name, d2.ieee_address as sensor_ieee
    FROM gates g
    LEFT JOIN devices d1 ON d1.id = g.device_id
    LEFT JOIN devices d2 ON d2.id = g.sensor_device_id
  `).get() as any

  if (!gate) { res.json(null); return }

  const logs = db.prepare(`
    SELECT * FROM gate_logs WHERE gate_id = ? ORDER BY triggered_at DESC LIMIT 20
  `).all(gate.id)

  let isOpen: boolean | null = null
  if (gate.type === 'garage' && gate.sensor_device_id) {
    const state = db.prepare(`
      SELECT value FROM device_states WHERE device_id = ? AND key = 'contact'
    `).get(gate.sensor_device_id) as any
    if (state) isOpen = state.value === 'false'
  }

  res.json({ ...gate, logs, is_open: isOpen })
})

gateRouter.post('/', (req: Request, res: Response) => {
  const db = getDb()
  const { name, type, device_id, sensor_device_id } = req.body
  const result = db.prepare(`
    INSERT INTO gates (name, type, device_id, sensor_device_id) VALUES (?, ?, ?, ?)
  `).run(name || 'Portail', type || 'residence', device_id || null, sensor_device_id || null)
  res.json({ id: result.lastInsertRowid })
})

gateRouter.patch('/', (req: Request, res: Response) => {
  const db = getDb()
  const gate = db.prepare('SELECT * FROM gates').get() as any
  if (!gate) { res.status(404).json({ error: 'Portail non configuré' }); return }
  const { name, type, device_id, sensor_device_id } = req.body
  db.prepare(`
    UPDATE gates SET
      name = COALESCE(?, name),
      type = COALESCE(?, type),
      device_id = COALESCE(?, device_id),
      sensor_device_id = COALESCE(?, sensor_device_id)
    WHERE id = ?
  `).run(name ?? null, type ?? null, device_id ?? null, sensor_device_id ?? null, gate.id)
  res.json({ success: true })
})

gateRouter.delete('/', (req: Request, res: Response) => {
  const db = getDb()
  const gate = db.prepare('SELECT id FROM gates').get() as any
  if (!gate) { res.status(404).json({ error: 'Portail non configuré' }); return }
  db.prepare('DELETE FROM gates WHERE id = ?').run(gate.id)
  res.json({ success: true })
})

gateRouter.post('/trigger', async (req: Request, res: Response) => {
  const db = getDb()
  const gate = db.prepare(`
    SELECT g.*, d.ieee_address FROM gates g
    LEFT JOIN devices d ON d.id = g.device_id
  `).get() as any
  if (!gate) { res.status(404).json({ error: 'Portail non configuré' }); return }
  if (!gate.ieee_address) { res.status(400).json({ error: 'Aucun appareil configuré' }); return }

  const trigger = req.body.trigger || 'manual'

  try {
    await sendCommand(gate.ieee_address, 'state', 'ON')
    await new Promise(resolve => setTimeout(resolve, 1000))
    await sendCommand(gate.ieee_address, 'state', 'OFF')

    db.prepare(`
      INSERT INTO gate_logs (gate_id, trigger) VALUES (?, ?)
    `).run(gate.id, trigger)

    res.json({ success: true })
  } catch (e: any) {
    res.status(500).json({ error: 'Erreur déclenchement: ' + e.message })
  }
})
