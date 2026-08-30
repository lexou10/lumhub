import { getDb } from '../database'
import { sendCommand } from './zigbee'

let irrigationInterval: NodeJS.Timeout | null = null
const activeZones = new Set<number>() // zone_id en cours d'arrosage
const firedToday = new Set<string>() // "zone_id:time_start"

export function startIrrigationService() {
  console.log('[Irrigation] Service démarré')
  irrigationInterval = setInterval(checkIrrigation, 30 * 1000)
  checkIrrigation()

  // Reset à minuit
  const now = new Date()
  const msUntilMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime()
  setTimeout(() => {
    firedToday.clear()
    setInterval(() => firedToday.clear(), 24 * 60 * 60 * 1000)
  }, msUntilMidnight)
}

export function stopIrrigationService() {
  if (irrigationInterval) { clearInterval(irrigationInterval); irrigationInterval = null }
}

async function checkConditions(irrigationId: number): Promise<{ ok: boolean, reason?: string }> {
  const db = getDb()
  const conditions = db.prepare(`
    SELECT c.*, d.id as did FROM irrigation_conditions c
    LEFT JOIN devices d ON d.id = c.device_id
    WHERE c.irrigation_id = ? AND c.enabled = 1
  `).all(irrigationId) as any[]

  for (const cond of conditions) {
    if (cond.type === 'rain_sensor' && cond.device_id) {
      const state = db.prepare(`SELECT value FROM device_states WHERE device_id = ? AND key = 'contact'`).get(cond.device_id) as any
      if (state && state.value === 'false') return { ok: false, reason: 'Pluie détectée' }
    }

    if (cond.type === 'temperature' && cond.device_id) {
      const state = db.prepare(`SELECT value FROM device_states WHERE device_id = ? AND key = 'temperature'`).get(cond.device_id) as any
      if (state) {
        const temp = parseFloat(state.value) / 100
        if (cond.operator === 'lt' && temp < cond.value) return { ok: false, reason: `Température trop basse (${temp}°C)` }
        if (cond.operator === 'gt' && temp > cond.value) return { ok: false, reason: `Température trop haute (${temp}°C)` }
      }
    }

    if (cond.type === 'humidity' && cond.device_id) {
      const state = db.prepare(`SELECT value FROM device_states WHERE device_id = ? AND key = 'humidity'`).get(cond.device_id) as any
      if (state) {
        const hum = parseFloat(state.value) / 100
        if (cond.operator === 'gt' && hum > cond.value) return { ok: false, reason: `Humidité trop élevée (${hum}%)` }
      }
    }
  }

  return { ok: true }
}

async function checkIrrigation() {
  const db = getDb()
  const irrigation = db.prepare('SELECT * FROM irrigation WHERE enabled = 1').get() as any
  if (!irrigation) return

  const now = new Date()
  const dayOfWeek = now.getDay() === 0 ? 7 : now.getDay()
  const nowStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`

  const zones = db.prepare(`
    SELECT z.*, d.ieee_address FROM irrigation_zones z
    LEFT JOIN devices d ON d.id = z.device_id
    WHERE z.irrigation_id = ? ORDER BY z.sort_order
  `).all(irrigation.id) as any[]

  for (const zone of zones) {
    if (!zone.ieee_address) continue

    const schedules = db.prepare(`
      SELECT * FROM irrigation_schedules WHERE zone_id = ? AND enabled = 1
    `).all(zone.id) as any[]

    for (const schedule of schedules) {
      const days = schedule.days_of_week.split(',').map(Number)
      if (!days.includes(dayOfWeek)) continue

      const key = `${zone.id}:${schedule.time_start}`

      // Début d'arrosage
      if (nowStr === schedule.time_start && !firedToday.has(key)) {
        firedToday.add(key)
        const check = await checkConditions(irrigation.id)
        if (!check.ok) {
          console.log(`[Irrigation] Zone ${zone.name} skippée: ${check.reason}`)
          db.prepare(`INSERT INTO irrigation_logs (zone_id, trigger, skipped, skip_reason) VALUES (?, 'auto', 1, ?)`).run(zone.id, check.reason)
          continue
        }
        console.log(`[Irrigation] Zone ${zone.name} → ON`)
        await sendCommand(zone.ieee_address, 'state', 'ON').catch(console.error)
        db.prepare(`INSERT INTO irrigation_logs (zone_id, trigger) VALUES (?, 'auto')`).run(zone.id)
        activeZones.add(zone.id)
      }

      // Fin d'arrosage
      if (nowStr === schedule.time_end && activeZones.has(zone.id)) {
        console.log(`[Irrigation] Zone ${zone.name} → OFF`)
        await sendCommand(zone.ieee_address, 'state', 'OFF').catch(console.error)
        db.prepare(`UPDATE irrigation_logs SET ended_at = CURRENT_TIMESTAMP WHERE zone_id = ? AND ended_at IS NULL`).run(zone.id)
        activeZones.delete(zone.id)
      }
    }
  }
}
