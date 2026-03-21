import { onDeviceStateChange } from './automations'
import { getDb } from '../database'
import { findProfile } from './deviceProfiles'
import { broadcastDeviceState, broadcastDeviceOnline } from '../websocket'
import * as mqtt from 'mqtt'

const MQTT_HOST   = process.env.MQTT_HOST   || 'localhost'
const MQTT_PORT   = process.env.MQTT_PORT   || '1883'
const MQTT_TOPIC  = process.env.MQTT_TOPIC  || 'zigbee2mqtt'
const MQTT_URL    = `mqtt://${MQTT_HOST}:${MQTT_PORT}`

let client: mqtt.MqttClient | null = null
let isRunning = false

export async function startZigbeeService(): Promise<void> {
  isRunning = true
  console.log('[Zigbee] Démarrage du service MQTT...')
  connectMQTT()
}

export function stopZigbeeService(): void {
  isRunning = false
  if (client) client.end()
  console.log('[Zigbee] Service arrêté')
}

function connectMQTT(): void {
  if (!isRunning) return
  client = mqtt.connect(MQTT_URL, { reconnectPeriod: 5000, clientId: `lumhub_${Math.random().toString(16).slice(2)}` })
  client.on('connect', () => { client!.subscribe(`${MQTT_TOPIC}/+`); client!.subscribe(`${MQTT_TOPIC}/bridge/devices`); client!.subscribe(`${MQTT_TOPIC}/bridge/event`); syncDevices() })
  client.on('message', (topic: string, payload: Buffer) => { try { handleMQTTMessage(topic, JSON.parse(payload.toString())) } catch (e) {} })
  client.on('error', (err: Error) => console.error('[Zigbee] Erreur MQTT:', err.message))
  client.on('offline', () => console.warn('[Zigbee] MQTT déconnecté, reconnexion...'))
}

function handleMQTTMessage(topic: string, data: any): void {
  if (topic === `${MQTT_TOPIC}/bridge/devices`) { if (Array.isArray(data)) for (const d of data) if (d.type === 'EndDevice' || d.type === 'Router') upsertDevice(d); return }
  if (topic === `${MQTT_TOPIC}/bridge/event`) { if (data.type === 'device_joined') client?.publish(`${MQTT_TOPIC}/bridge/request/devices`, ''); return }
  const friendlyName = topic.replace(`${MQTT_TOPIC}/`, '')
  if (!friendlyName.startsWith('bridge')) handleDeviceState(friendlyName, data)
}

function syncDevices(): void { client?.publish(`${MQTT_TOPIC}/bridge/request/devices`, '') }

function upsertDevice(z2mDevice: any): void {
  const db = getDb()
  const ieee = z2mDevice.ieee_address
  if (!ieee || ieee === '0x00212effff0ee00d') return
  const definition = z2mDevice.definition || {}
  const manufacturer = definition.vendor || z2mDevice.manufacturer || null
  const model = definition.model || z2mDevice.model_id || null
  const name = z2mDevice.friendly_name || ieee
  const profile = findProfile(manufacturer || '', model || '')
  const type = resolveTypeFromZ2M(z2mDevice)
  db.prepare(`INSERT INTO devices (ieee_address, name, manufacturer, model, profile_id, type, is_online, last_seen) VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP) ON CONFLICT(ieee_address) DO UPDATE SET is_online=1, last_seen=CURRENT_TIMESTAMP, manufacturer=COALESCE(excluded.manufacturer, manufacturer), model=COALESCE(excluded.model, model), profile_id=COALESCE(profile_id, excluded.profile_id)`).run(ieee, name, manufacturer, model, profile?.id || null, type)
}

function handleDeviceState(friendlyName: string, data: any): void {
  const db = getDb()
  let device = db.prepare('SELECT id, name FROM devices WHERE ieee_address = ?').get(friendlyName) as any
  if (!device) device = db.prepare('SELECT id, name FROM devices WHERE LOWER(ieee_address) = ?').get(friendlyName.toLowerCase()) as any
  if (!device) return
  if (data.linkquality !== undefined) { db.prepare('UPDATE devices SET is_online = 1, last_seen = CURRENT_TIMESTAMP WHERE id = ?').run(device.id); broadcastDeviceOnline(device.id, true) }
  const states = mapZ2MStates(data)
  updateDeviceStates(device.id, states)
  for (const [key, value] of Object.entries(states)) broadcastDeviceState(device.id, key, value)
}

function mapZ2MStates(data: any): Record<string, string> {
  const s: Record<string, string> = {}
if (data.state !== undefined) {
  s['on']    = String(data.state === 'ON')
  s['state'] = data.state === 'ON' ? 'on' : 'off'
}
  if (data.brightness !== undefined)      s['brightness']  = String(Math.round(data.brightness / 254 * 100))
  if (data.temperature !== undefined)     s['temperature'] = String(Math.round(data.temperature * 100))
  if (data.humidity !== undefined)        s['humidity']    = String(Math.round(data.humidity * 100))
  if (data.occupancy !== undefined)       s['occupancy']   = String(data.occupancy)
  if (data.contact !== undefined)         s['contact']     = String(data.contact)
  if (data.battery !== undefined)         s['battery']     = String(data.battery)
  if (data.linkquality !== undefined)     s['linkquality'] = String(data.linkquality)
  if (data.power !== undefined)           s['power']       = String(data.power)
  if (data.pilot_wire_mode !== undefined) s['mode']        = String(data.pilot_wire_mode)
  if (data.position !== undefined)        s['position']    = String(data.position)
  if (data.state !== undefined && ['OPEN','CLOSE','STOP'].includes(data.state)) s['cover_state'] = String(data.state)
  if (data.position !== undefined)        s['position']    = String(data.position)
  if (data.state !== undefined && ['OPEN','CLOSE','STOP'].includes(data.state)) s['cover_state'] = String(data.state)
  return s
}

export async function sendCommand(ieeeAddress: string, key: string, value: any): Promise<boolean> {
  if (!client?.connected) return false
  const db = getDb()
  const device = db.prepare('SELECT * FROM devices WHERE ieee_address = ?').get(ieeeAddress) as any
  if (!device) return false
  const topic = `${MQTT_TOPIC}/${ieeeAddress}/set`
  const payload = buildMQTTPayload(key, value, device)
  return new Promise((resolve) => {
    client!.publish(topic, JSON.stringify(payload), (err) => {
      if (err) { resolve(false) } else {
        const states: Record<string, string> = { [key]: String(value) }
        if (key === 'pilot_wire_mode' || key === 'mode') { states['pilot_wire_mode'] = String(value); states['mode'] = String(value) }
        updateDeviceStates(device.id, states)
        for (const [k, v] of Object.entries(states)) { broadcastDeviceState(device.id, k, v); onDeviceStateChange(device.id, k, String(v)).catch(() => {}) }
        resolve(true)
      }
    })
  })
}

function buildMQTTPayload(key: string, value: any, device: any): Record<string, any> {
  const isLegrand = device.manufacturer === 'Legrand' || (device.model && device.model.includes('Cable'))
  if (isLegrand && (key === 'mode' || key === 'pilot_wire_mode')) return { pilot_wire_mode: value }
  switch (key) {
    case 'state': case 'on': return { state: (String(value).toLowerCase() === 'on' || value === true || value === 'true') ? 'ON' : 'OFF' }
    case 'brightness': return { brightness: Math.round((parseInt(value) / 100) * 254) }
    case 'position': return { position: parseInt(value) }
    case 'cover_state': return { state: value }
    case 'lift_duration': return { lift_duration: parseInt(value) }
    case 'position': return { position: parseInt(value) }
    case 'cover_state': return { state: value }
    case 'lift_duration': return { lift_duration: parseInt(value) }
    case 'color_temp': return { color_temp: parseInt(value) }
    default: return { [key]: value }
  }
}
export async function startPairing(durationSeconds: number = 120): Promise<void> { client?.publish(`${MQTT_TOPIC}/bridge/request/permit_join`, JSON.stringify({ value: true, time: durationSeconds })) }
export async function stopPairing(): Promise<void> { client?.publish(`${MQTT_TOPIC}/bridge/request/permit_join`, JSON.stringify({ value: false })) }

function updateDeviceStates(deviceId: number, states: Record<string, any>): void {
  const db = getDb()
  const upsert = db.prepare(`INSERT INTO device_states (device_id, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(device_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
  db.transaction(() => { for (const [key, value] of Object.entries(states)) if (value !== null && value !== undefined) upsert.run(deviceId, key, String(value)) })()
}

function resolveTypeFromZ2M(device: any): string {
  const exposes = (device.definition || {}).exposes || []
  if (exposes.some((e: any) => e.type === 'cover'))               return 'cover'
  if (exposes.some((e: any) => e.type === 'cover'))               return 'cover'
  if (exposes.some((e: any) => e.property === 'pilot_wire_mode')) return 'heating'
  if (exposes.some((e: any) => e.property === 'occupancy'))       return 'motion_sensor'
  if (exposes.some((e: any) => e.property === 'temperature'))     return 'temperature_sensor'
  if (exposes.some((e: any) => e.property === 'humidity'))        return 'humidity_sensor'
  if (exposes.some((e: any) => e.property === 'color_temp'))      return 'color_light'
  if (exposes.some((e: any) => e.property === 'brightness'))      return 'dimmable_light'
  return 'light'
}
