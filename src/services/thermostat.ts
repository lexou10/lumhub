import { getDb } from '../database'
import { sendCommand } from './zigbee'

let thermostatTimer: ReturnType<typeof setInterval> | null = null

export function startThermostatService(): void {
  console.log('[Thermostat] Démarrage du service...')
  runCycle()
  thermostatTimer = setInterval(runCycle, 10000)
}

export function triggerCycle(): void { runCycle().catch(e => console.error("[Thermostat] triggerCycle error:", e.message)) }
export function stopThermostatService(): void {
  if (thermostatTimer) clearInterval(thermostatTimer)
  console.log('[Thermostat] Service arrêté')
}

async function runCycle(): Promise<void> {
  const db = getDb()
  const thermostats = db.prepare(`
    SELECT t.*, r.name as room_name
    FROM thermostats t
    JOIN rooms r ON r.id = t.room_id
    WHERE t.enabled = 1
  `).all() as any[]

  for (const thermostat of thermostats) {
    try { await processThermostat(thermostat) }
    catch (err: any) { console.error(`[Thermostat] Erreur ${thermostat.room_name}:`, err.message) }
  }
}

async function processThermostat(thermostat: any): Promise<void> {
  const db = getDb()

  const currentTemp = getRoomTemperature(thermostat.room_id)
  if (currentTemp === null) {
    console.log(`[Thermostat] ${thermostat.room_name}: pas de sonde`)
    return
  }

  const targetTemp = getTargetTemperature(thermostat)

  const heaters = db.prepare(`
    SELECT * FROM devices
    WHERE room_id = ? AND type = 'heating' AND is_online = 1
  `).all(thermostat.room_id) as any[]

  if (heaters.length === 0) return

  // Logique simple : temp < consigne = ON, temp >= consigne = OFF
  const shouldHeat = currentTemp < targetTemp
  const label = shouldHeat ? 'CHAUFFE' : 'STOP'
  console.log(`[Thermostat] ${thermostat.room_name}: ${currentTemp}°C / cible ${targetTemp}°C → ${label}`)

  for (const heater of heaters) {
    await commandHeater(heater, shouldHeat, thermostat.mode === 'away')
  }

  db.prepare(`
    INSERT INTO device_states (device_id, key, value, updated_at)
    VALUES (?, 'thermostat_current_temp', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(device_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(heaters[0].id, String(currentTemp))
}

async function commandHeater(heater: any, shouldHeat: boolean, isAway: boolean): Promise<void> {
  if (heater.device_mode === 'pilot') {
    const desiredMode = (isAway || !shouldHeat) ? 'off' : 'comfort'
    const currentMode = getCurrentState(heater.id, 'mode')
    if (currentMode === desiredMode) return
    console.log(`[Thermostat] ${heater.name}: pilot_wire_mode → ${desiredMode}`)
    await sendCommand(heater.ieee_address, 'mode', desiredMode)
  } else {
    const desiredState = (!isAway && shouldHeat) ? 'on' : 'off'
    const currentOn = getCurrentState(heater.id, 'on')
    const isOn = currentOn === 'true'
    if ((desiredState === 'on') === isOn) return
    console.log(`[Thermostat] ${heater.name}: relay → ${desiredState.toUpperCase()}`)
    await sendCommand(heater.ieee_address, 'state', desiredState)
  }
}

function getTargetTemperature(thermostat: any): number {
  if (thermostat.mode === 'away') return thermostat.away_temp
  if (thermostat.mode === 'schedule') {
    const scheduled = getScheduledTemp(thermostat.id)
    if (scheduled !== null) return scheduled
  }
  return thermostat.target_temp
}

function getScheduledTemp(thermostatId: number): number | null {
  const db = getDb()
  const now = new Date()
  const dayOfWeek = (now.getDay() + 6) % 7
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const schedule = db.prepare(`
    SELECT * FROM thermostat_schedules
    WHERE thermostat_id = ? AND day_of_week = ?
      AND time_start <= ? AND time_end > ?
    ORDER BY time_start DESC LIMIT 1
  `).get(thermostatId, dayOfWeek, currentTime, currentTime) as any
  return schedule ? schedule.target_temp : null
}

function getRoomTemperature(roomId: number): number | null {
  const db = getDb()
  const sensor = db.prepare(`
    SELECT d.id FROM devices d
    WHERE d.room_id = ? AND d.type = 'temperature_sensor' AND d.is_online = 1
    LIMIT 1
  `).get(roomId) as any
  if (!sensor) return null
  const state = db.prepare(`SELECT value FROM device_states WHERE device_id = ? AND key = 'temperature'`).get(sensor.id) as any
  if (!state?.value) return null
  const raw = parseFloat(state.value)
  return raw > 100 ? raw / 100 : raw
}

function getCurrentState(deviceId: number, key: string): string | null {
  const db = getDb()
  const state = db.prepare('SELECT value FROM device_states WHERE device_id = ? AND key = ?').get(deviceId, key) as any
  return state?.value ?? null
}
