import { Router, Request, Response } from 'express'
import { getDb } from '../../database'
import { findProfile, getProfile } from '../../services/deviceProfiles'
import { ownerOrUser } from '../middleware/auth'
import { broadcastDeviceState } from '../../websocket'
const { sendCommand, startPairing, stopPairing } = require('../../services/zigbee')

export const devicesRouter = Router()

// GET /api/v1/devices
devicesRouter.get('/', (req: Request, res: Response) => {
  const db = getDb()
  const devices = db.prepare(`
    SELECT d.*, r.name as room_name,
      (SELECT json_group_object(key, value) FROM device_states WHERE device_id = d.id) as states,
      (SELECT MAX(updated_at) FROM device_states WHERE device_id = d.id) as last_seen
    FROM devices d
    LEFT JOIN rooms r ON r.id = d.room_id
    WHERE d.is_hidden = 0
    ORDER BY r.floor, r.sort_order, d.name
  `).all()

  const result = devices.map((d: any) => ({
    ...d,
    states: d.states ? JSON.parse(d.states) : {},
    profile: d.profile_id ? getProfile(d.profile_id) : null
  }))

  res.json(result)
})

// GET /api/v1/devices/:id
devicesRouter.get('/:id', (req: Request, res: Response) => {
  const db = getDb()
  const device = db.prepare(`
    SELECT d.*, r.name as room_name
    FROM devices d
    LEFT JOIN rooms r ON r.id = d.room_id
    WHERE d.id = ?
  `).get(req.params.id) as any

  if (!device) { res.status(404).json({ error: 'Device non trouvé' }); return }

  const states = db.prepare('SELECT key, value, updated_at FROM device_states WHERE device_id = ?')
    .all(device.id)

  const statesMap = Object.fromEntries(states.map((s: any) => [s.key, s.value]))
  const lastSeen = states.reduce((max: string | null, s: any) => {
    if (!max || s.updated_at > max) return s.updated_at
    return max
  }, null)

  res.json({
    ...device,
    states: statesMap,
    last_seen: lastSeen,
    profile: device.profile_id ? getProfile(device.profile_id) : null
  })
})

// PATCH /api/v1/devices/:id — renommer, changer de pièce, notes
devicesRouter.patch('/:id', ownerOrUser, (req: Request, res: Response) => {
  const db = getDb()
  const { name, room_id, notes } = req.body

  const device = db.prepare('SELECT id FROM devices WHERE id = ?').get(req.params.id)
  if (!device) { res.status(404).json({ error: 'Device non trouvé' }); return }

  db.prepare(`
    UPDATE devices SET
      name    = COALESCE(?, name),
      room_id = COALESCE(?, room_id),
      notes   = COALESCE(?, notes)
    WHERE id = ?
  `).run(name, room_id, notes, req.params.id)

  res.json({ success: true })
})

// PATCH /api/v1/devices/:id/mode — changer le mode relay/pilot
devicesRouter.patch('/:id/mode', ownerOrUser, async (req: Request, res: Response) => {
  const db = getDb()
  const { device_mode } = req.body

  if (!device_mode || !['relay', 'pilot'].includes(device_mode)) {
    res.status(400).json({ error: 'device_mode doit être "relay" ou "pilot"' }); return
  }

  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id) as any
  if (!device) { res.status(404).json({ error: 'Device non trouvé' }); return }

  const isLegrand = device.manufacturer === 'Legrand' || (device.model && device.model.includes('Cable'))
  if (!isLegrand) {
    res.status(400).json({ error: 'Ce device ne supporte pas le mode fil pilote' }); return
  }

  db.prepare('UPDATE devices SET device_mode = ? WHERE id = ?').run(device_mode, device.id)

  const zigbeeMode = device_mode === 'pilot' ? 'pilot_on' : 'pilot_off'
  try {
    await sendCommand(device.ieee_address, 'device_mode', zigbeeMode)
    console.log(`[Devices] device_mode=${zigbeeMode} envoyé à ${device.ieee_address}`)
  } catch (e: any) {
    console.error('[Devices] Erreur device_mode:', e.message)
  }

  res.json({ success: true, device_id: device.id, device_mode })
})

// DELETE /api/v1/devices/:id — supprimer (owner uniquement)
devicesRouter.delete('/:id', (req: Request, res: Response) => {
  if (req.user?.role !== 'owner') {
    res.status(403).json({ error: 'Owner requis' }); return
  }

  const db = getDb()
  const device = db.prepare('SELECT id FROM devices WHERE id = ?').get(req.params.id)
  if (!device) { res.status(404).json({ error: 'Device non trouvé' }); return }

  db.prepare('DELETE FROM devices WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})

// POST /api/v1/devices/:id/control — envoyer une commande
devicesRouter.post('/:id/control', async (req: Request, res: Response) => {
  const db = getDb()
  const { key, value } = req.body

  if (!key || value === undefined) {
    res.status(400).json({ error: 'key et value requis' }); return
  }

  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id) as any
  if (!device) { res.status(404).json({ error: 'Device non trouvé' }); return }

  if (req.user?.role === 'guest') {
    const perm = db.prepare(`
      SELECT can_control FROM user_device_permissions
      WHERE user_id = ? AND device_id = ?
    `).get(req.user.id, device.id) as any

    if (!perm?.can_control) {
      res.status(403).json({ error: 'Permission refusée' }); return
    }
  }

  const isLegrand = device.manufacturer === 'Legrand' || (device.model && device.model.includes('Cable'))
  if (isLegrand && (key === 'mode' || key === 'pilot_wire_mode')) {
    if (device.device_mode !== 'pilot') {
      db.prepare('UPDATE devices SET device_mode = ? WHERE id = ?').run('pilot', device.id)
      await sendCommand(device.ieee_address, 'device_mode', 'pilot_on')
        .catch((e: any) => console.error('[Control] Erreur activation pilot_on:', e.message))
    }
  }

  db.prepare(`
    INSERT INTO device_states (device_id, key, value, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(device_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(device.id, key, String(value))

  db.prepare(`
    INSERT INTO device_history (device_id, key, value) VALUES (?, ?, ?)
  `).run(device.id, key, String(value))

  broadcastDeviceState(device.id, key, value)

  try {
    await sendCommand(device.ieee_address, key, value)
  } catch(e: any) {
    console.error('[Control] Zigbee erreur:', e.message)
  }

  res.json({ success: true, device_id: device.id, key, value })
})

// GET /api/v1/devices/:id/history
devicesRouter.get('/:id/history', (req: Request, res: Response) => {
  const { key, limit = '100', from, to } = req.query

  let query = 'SELECT key, value, recorded_at FROM device_history WHERE device_id = ?'
  const params: any[] = [req.params.id]

  if (key)  { query += ' AND key = ?';           params.push(key) }
  if (from) { query += ' AND recorded_at >= ?';  params.push(from) }
  if (to)   { query += ' AND recorded_at <= ?';  params.push(to) }

  query += ' ORDER BY recorded_at DESC LIMIT ?'
  params.push(parseInt(limit as string, 10))

  const history = getDb().prepare(query).all(...params)
  res.json(history)
})

const net = require('net')
function sendLed(state: string) { try { const s = net.createConnection('/run/lumhub-leds.sock'); s.on('connect', () => { s.write(state); s.end() }); s.on('error', () => {}) } catch {} }


// POST /api/v1/devices/pairing/start — activer le pairing (owner uniquement)
devicesRouter.post('/pairing/start', (req: Request, res: Response) => {
  if (req.user?.role !== 'owner') { res.status(403).json({ error: 'Owner requis' }); return }
  const { duration = 120 } = req.body
  sendLed('pairing')
  Promise.resolve().then(() => startPairing(duration))
  res.json({ success: true, duration })
})

// POST /api/v1/devices/pairing/stop
devicesRouter.post('/pairing/stop', (req: Request, res: Response) => {
  if (req.user?.role !== 'owner') { res.status(403).json({ error: 'Owner requis' }); return }
  sendLed('ok')
  Promise.resolve().then(() => stopPairing())
  res.json({ success: true })
})
