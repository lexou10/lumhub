import { getDb } from '../database'
import { sendCommand } from './zigbee'

let feederInterval: NodeJS.Timeout | null = null
const firedToday = new Set<string>() // "feeder_id:HH:MM"

export function startFeederService() {
  console.log('[Feeder] Service démarré')
  feederInterval = setInterval(checkFeeder, 30 * 1000) // toutes les 30s
  checkFeeder()

  // Reset des déclenchements à minuit
  const now = new Date()
  const msUntilMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime()
  setTimeout(() => {
    firedToday.clear()
    setInterval(() => firedToday.clear(), 24 * 60 * 60 * 1000)
  }, msUntilMidnight)
}

export function stopFeederService() {
  if (feederInterval) { clearInterval(feederInterval); feederInterval = null }
}

async function checkFeeder() {
  const db = getDb()
  const feeder = db.prepare(`
    SELECT f.*, d.ieee_address FROM feeders f
    LEFT JOIN devices d ON d.id = f.device_id
  `).get() as any
  if (!feeder || !feeder.ieee_address) return

  const schedules = db.prepare(`
    SELECT * FROM feeder_schedules WHERE feeder_id = ? AND enabled = 1
  `).all(feeder.id) as any[]

  const now = new Date()
  const nowStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`

  for (const schedule of schedules) {
    const key = `${feeder.id}:${schedule.time}`
    if (schedule.time === nowStr && !firedToday.has(key)) {
      firedToday.add(key)
      console.log(`[Feeder] Repas automatique à ${nowStr}`)
      await distributeDoses(feeder, 'auto')
    }
  }
}

export async function distributeDoses(feeder: any, trigger: string = 'manual') {
  const doses = feeder.doses_per_meal || 1
  const db = getDb()

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
    console.log(`[Feeder] ${doses} dose(s) distribuée(s) (${trigger})`)
  } catch (e: any) {
    console.error('[Feeder] Erreur distribution:', e.message)
  }
}
