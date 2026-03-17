import { getDb } from '../database'
import { sendCommand } from './zigbee'
import { broadcastToOwner } from '../websocket'

let automationTimer: ReturnType<typeof setInterval> | null = null
let lastTriggered: Map<number, string> = new Map()

// ============================================================
// DÉMARRAGE / ARRÊT
// ============================================================
export function startAutomationService(): void {
  console.log('[Automations] Démarrage du service...')
  runCycle()
  automationTimer = setInterval(runCycle, 10000) // toutes les 10s
}

export function stopAutomationService(): void {
  if (automationTimer) clearInterval(automationTimer)
  console.log('[Automations] Service arrêté')
}

// Appelé depuis zigbee.ts quand un état change
export async function onDeviceStateChange(deviceId: number, key: string, value: string): Promise<void> {
  const db = getDb()
  const automations = db.prepare(`
    SELECT * FROM automations WHERE enabled = 1 AND trigger_type = 'device'
  `).all() as any[]

  for (const auto of automations) {
    const config = JSON.parse(auto.trigger_config)
    if (config.device_id === deviceId && config.key === key) {
      const matches = checkDeviceTrigger(config, value)
      if (matches) await executeAutomation(auto)
    }
  }
}

// ============================================================
// CYCLE PRINCIPAL (time, sunrise, sunset)
// ============================================================
async function runCycle(): Promise<void> {
  const db = getDb()
  const now = new Date()
  const automations = db.prepare(`
    SELECT * FROM automations WHERE enabled = 1
  `).all() as any[]

  for (const auto of automations) {
    try {
      const config = JSON.parse(auto.trigger_config)
      const condition = auto.condition ? JSON.parse(auto.condition) : null
      let shouldTrigger = false

      switch (auto.trigger_type) {
        case 'time':
          shouldTrigger = checkTimeTrigger(auto, config, now)
          break
        case 'sunrise':
          shouldTrigger = checkSunTrigger('sunrise', config, now)
          break
        case 'sunset':
          shouldTrigger = checkSunTrigger('sunset', config, now)
          break
        case 'manual':
          continue // manuel = déclenché uniquement via API
      }

      if (!shouldTrigger) continue
      if (!checkCondition(condition)) continue
      if (alreadyTriggeredToday(auto.id, now)) continue

      await executeAutomation(auto)

    } catch (err: any) {
      console.error(`[Automations] Erreur ${auto.name}:`, err.message)
    }
  }
}

// ============================================================
// VÉRIFICATIONS DÉCLENCHEURS
// ============================================================
function checkTimeTrigger(auto: any, config: any, now: Date): boolean {
  if (!config.time) return false

  // Vérifier le jour de la semaine (0=lundi, 6=dimanche)
  if (config.days && config.days.length > 0) {
    const dayOfWeek = (now.getDay() + 6) % 7
    if (!config.days.includes(dayOfWeek)) return false
  }

  const [h, m] = config.time.split(':').map(Number)
  return now.getHours() === h && now.getMinutes() === m
}

function checkSunTrigger(type: 'sunrise' | 'sunset', config: any, now: Date): boolean {
  // Coordonnées Bordeaux par défaut (configurable dans settings)
  const db = getDb()
  const latSetting = db.prepare("SELECT value FROM settings WHERE key = 'latitude'").get() as any
  const lonSetting = db.prepare("SELECT value FROM settings WHERE key = 'longitude'").get() as any
  const lat = parseFloat(latSetting?.value || '44.8378')
  const lon = parseFloat(lonSetting?.value || '-0.5792')

  const sunTime = getSunTime(type, lat, lon, now)
  if (!sunTime) return false

  const offsetMin = config.offset_minutes || 0
  const target = new Date(sunTime.getTime() + offsetMin * 60000)

  return now.getHours() === target.getHours() && now.getMinutes() === target.getMinutes()
}

function checkDeviceTrigger(config: any, value: string): boolean {
  if (!config.operator || config.expected_value === undefined) return false

  const expected = String(config.expected_value)
  switch (config.operator) {
    case 'eq':  return value === expected
    case 'neq': return value !== expected
    case 'gt':  return parseFloat(value) > parseFloat(expected)
    case 'lt':  return parseFloat(value) < parseFloat(expected)
    case 'gte': return parseFloat(value) >= parseFloat(expected)
    case 'lte': return parseFloat(value) <= parseFloat(expected)
    default:    return false
  }
}

// ============================================================
// VÉRIFICATION CONDITION
// ============================================================
function checkCondition(condition: any): boolean {
  if (!condition) return true

  const db = getDb()

  try {
    switch (condition.type) {
      case 'time_range': {
        const now = new Date()
        const current = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
        const from = condition.from || '00:00'
        const to = condition.to || '23:59'
        if (from <= to) return current >= from && current <= to
        // Cas nuit (ex: 22:00 → 06:00)
        return current >= from || current <= to
      }
      case 'device_state': {
        const state = db.prepare('SELECT value FROM device_states WHERE device_id = ? AND key = ?')
          .get(condition.device_id, condition.key) as any
        if (!state) return false
        return checkDeviceTrigger(condition, state.value)
      }
      case 'temperature': {
        const state = db.prepare(`
          SELECT ds.value FROM device_states ds
          JOIN devices d ON d.id = ds.device_id
          WHERE d.room_id = ? AND d.type = 'temperature_sensor' AND ds.key = 'temperature'
          LIMIT 1
        `).get(condition.room_id) as any
        if (!state) return false
        const temp = parseFloat(state.value) > 100 ? parseFloat(state.value) / 100 : parseFloat(state.value)
        return checkDeviceTrigger({ ...condition, expected_value: condition.value }, String(temp))
      }
      default:
        return true
    }
  } catch {
    return true
  }
}

// ============================================================
// ANTI-DOUBLE DÉCLENCHEMENT
// ============================================================
function alreadyTriggeredToday(autoId: number, now: Date): boolean {
  const key = `${autoId}-${now.toDateString()}-${now.getHours()}-${now.getMinutes()}`
  if (lastTriggered.get(autoId) === key) return true
  lastTriggered.set(autoId, key)
  return false
}

// ============================================================
// EXÉCUTION
// ============================================================
export async function executeAutomation(auto: any): Promise<void> {
  const db = getDb()
  console.log(`[Automations] Déclenchement: ${auto.name}`)

  const actions = db.prepare(`
    SELECT aa.*, d.ieee_address, d.name as device_name
    FROM automation_actions aa
    JOIN devices d ON d.id = aa.device_id
    WHERE aa.automation_id = ?
    ORDER BY aa.sort_order
  `).all(auto.id) as any[]

  for (const action of actions) {
    if (action.delay_ms > 0) {
      await new Promise(r => setTimeout(r, action.delay_ms))
    }

    const actionData = JSON.parse(action.action)

    try {
      // Thermostat virtuel — mise à jour directe en DB
      if (action.ieee_address.startsWith('virtual_thermostat_')) {
        const db = getDb()
        const thermostatId = db.prepare('SELECT id FROM thermostats WHERE room_id = (SELECT room_id FROM devices WHERE id = ?)').get(action.device_id) as any
        if (thermostatId) {
          if (actionData.key === 'target_temp') {
            db.prepare('UPDATE thermostats SET target_temp = ? WHERE id = ?').run(parseFloat(actionData.value), thermostatId.id)
            console.log(`[Automations] Thermostat ${action.device_name}: target_temp → ${actionData.value}°C`)
          } else if (actionData.key === 'enabled') {
            db.prepare('UPDATE thermostats SET enabled = ? WHERE id = ?').run(actionData.value === 'true' ? 1 : 0, thermostatId.id)
            console.log(`[Automations] Thermostat ${action.device_name}: enabled → ${actionData.value}`)
          }
        }
      } else {
        await sendCommand(action.ieee_address, actionData.key, actionData.value)
        console.log(`[Automations] ${action.device_name}: ${actionData.key} = ${actionData.value}`)
      }
    } catch (err: any) {
      console.error(`[Automations] Erreur action ${action.device_name}:`, err.message)
    }
  }

  // Mettre à jour last_triggered
  db.prepare('UPDATE automations SET last_triggered = CURRENT_TIMESTAMP WHERE id = ?').run(auto.id)

  // Broadcaster l'événement
  broadcastToOwner('automation_triggered', { id: auto.id, name: auto.name, timestamp: new Date().toISOString() })
}

// ============================================================
// LEVER/COUCHER DU SOLEIL (calcul astronomique)
// ============================================================
function getSunTime(type: 'sunrise' | 'sunset', lat: number, lon: number, date: Date): Date | null {
  try {
    const rad = Math.PI / 180
    const dayOfYear = Math.floor((date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / 86400000)
    const B = (360 / 365) * (dayOfYear - 81) * rad
    const eqTime = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B)
    const decl = 23.45 * Math.sin(B) * rad
    const hourAngle = Math.acos(-Math.tan(lat * rad) * Math.tan(decl)) / rad
    const noon = 12 - (lon / 15) - (eqTime / 60)
    const offsetH = hourAngle / 15
    const timeDecimal = type === 'sunrise' ? noon - offsetH : noon + offsetH
    const h = Math.floor(timeDecimal)
    const m = Math.round((timeDecimal - h) * 60)
    const result = new Date(date)
    result.setHours(h, m, 0, 0)
    return result
  } catch {
    return null
  }
}
