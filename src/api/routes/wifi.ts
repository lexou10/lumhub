import { Router, Request, Response } from 'express'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)
export const wifiRouter = Router()

// GET /api/v1/wifi — réseau actuel + liste des réseaux
wifiRouter.get('/', async (req: Request, res: Response) => {
  try {
    const { stdout: current } = await execAsync("nmcli -t -f NAME,DEVICE connection show --active | grep wlan0 | cut -d: -f1")
await execAsync("nmcli device wifi rescan").catch(() => {})
await new Promise(r => setTimeout(r, 2000))
const { stdout: list } = await execAsync("nmcli -t -f SSID,SIGNAL,SECURITY device wifi list | grep -v '^--'")
    
    const networks = list.trim().split('\n')
      .filter(l => l.trim())
      .map(line => {
        const parts = line.split(':')
        return {
          ssid: parts[0] || '',
          signal: parseInt(parts[1]) || 0,
          security: parts[2] || ''
        }
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
