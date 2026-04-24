import { getDb } from '../database'
import { sendCommand } from './zigbee'

let poolInterval: NodeJS.Timeout | null = null

export function startPoolService() {
  console.log('[Pool] Service démarré')
  poolInterval = setInterval(checkPool, 60 * 1000) // toutes les minutes
  checkPool() // vérification immédiate
}

export function stopPoolService() {
  if (poolInterval) { clearInterval(poolInterval); poolInterval = null }
}

async function checkPool() {
  const db = getDb()
  const pool = db.prepare('SELECT * FROM pools').get() as any
  if (!pool) return
  if (pool.mode !== 'auto') return // mode forcé, on ne touche pas

  // Température actuelle
  if (!pool.temp_device_id || !pool.pump_device_id) return

  const tempState = db.prepare(`
    SELECT value FROM device_states WHERE device_id = ? AND key = 'temperature'
  `).get(pool.temp_device_id) as any
  if (!tempState) return

  const raw = parseFloat(tempState.value)
  const currentTemp = raw > 100 ? raw / 100 : raw

  // Programme actif selon température
  const programs = db.prepare(`
    SELECT * FROM pool_programs WHERE pool_id = ? ORDER BY sort_order
  `).all(pool.id) as any[]

  const activeProgram = programs.find(p => {
    const aboveMin = p.temp_min === null || currentTemp >= p.temp_min
    const belowMax = p.temp_max === null || currentTemp < p.temp_max
    return aboveMin && belowMax
  })

  if (!activeProgram) {
    // Aucun programme actif → pompe OFF
    await setPump(pool, false)
    return
  }

  // Créneaux du programme actif
  const slots = db.prepare(`
    SELECT * FROM pool_slots WHERE program_id = ? ORDER BY time_start
  `).all(activeProgram.id) as any[]

  // Heure actuelle
  const now = new Date()
  const nowStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`

  // Est-on dans un créneau actif ?
  const inSlot = slots.some((s: any) => nowStr >= s.time_start && nowStr < s.time_end)

  await setPump(pool, inSlot)
}

async function setPump(pool: any, on: boolean) {
  const db = getDb()
  const device = db.prepare('SELECT ieee_address FROM devices WHERE id = ?').get(pool.pump_device_id) as any
  if (!device) return

  // Vérifie l'état actuel pour éviter les commandes inutiles
  const currentState = db.prepare(`
    SELECT value FROM device_states WHERE device_id = ? AND key = 'state'
  `).get(pool.pump_device_id) as any

  const isOn = currentState?.value === 'on'
  if (isOn === on) return // déjà dans le bon état

  console.log(`[Pool] Pompe → ${on ? 'ON' : 'OFF'}`)
  await sendCommand(device.ieee_address, 'state', on ? 'ON' : 'OFF').catch((e: any) =>
    console.error('[Pool] Erreur commande pompe:', e.message)
  )
}
