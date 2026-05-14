import { Router, Request, Response } from 'express'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)
export const wifiRouter = Router()

// GET /api/v1/wifi — réseau actuel + liste des réseaux
wifiRouter.get('/', async (req: Request, res: Response) => {
  try {
    const { stdout: current } = await execAsync("nmcli -t -f NAME,DEVICE connection show --active | grep wlan0 | cut -d: -f1")
await execAsync("sudo nmcli device wifi rescan ifname wlan0").catch(() => {})
await new Promise(r => setTimeout(r, 4000))
const { stdout: list } = await execAsync("nmcli -t -f SSID,SIGNAL,SECURITY device wifi list ifname wlan0 | grep -v '^--'")
    
    const networks = list.trim().split('\n')
      .filter(l => l.trim())
      .map(line => {
        // Les derniers champs sont signal et security, le reste est le SSID
        const parts = line.split(':')
        const security = parts[parts.length - 1] || ''
        const signal = parseInt(parts[parts.length - 2]) || 0
        const ssid = parts.slice(0, parts.length - 2).join(':')
        return { ssid, signal, security }
      })
      .filter(n => n.ssid)
      .sort((a, b) => b.signal - a.signal)

    res.json({
      current: current.trim(),
      networks
    })
  } catch(e: any) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/v1/wifi — changer de réseau
wifiRouter.post('/', async (req: Request, res: Response) => {
  const { ssid, password } = req.body
  if (!ssid) { res.status(400).json({ error: 'SSID requis' }); return }

  try {
    // Tente de se connecter
    const cmd = password
      ? `sudo nmcli device wifi connect "${ssid}" password "${password}" ifname wlan0`
      : `sudo nmcli device wifi connect "${ssid}" ifname wlan0`
    
    await execAsync(cmd)
    res.json({ success: true, ssid })
  } catch(e: any) {
    res.status(500).json({ error: 'Connexion échouée: ' + e.message })
  }
})
