import { WebSocketServer, WebSocket } from 'ws'
import { Server } from 'http'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-in-production'

interface AuthedSocket extends WebSocket {
  userId?: number
  username?: string
  role?: string
  isAlive?: boolean
}

let wss: WebSocketServer
const clients = new Set<AuthedSocket>()

export function initWebSocket(server: Server): void {
  wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws: AuthedSocket, req) => {
    // Auth via query param token
    const url = new URL(req.url!, `http://localhost`)
    const token = url.searchParams.get('token')

    if (!token) {
      ws.close(1008, 'Token requis')
      return
    }

    try {
      const payload = jwt.verify(token, JWT_SECRET) as any
      ws.userId   = payload.userId
      ws.username = payload.username
      ws.role     = payload.role
      ws.isAlive  = true
    } catch {
      ws.close(1008, 'Token invalide')
      return
    }

    clients.add(ws)
    console.log(`[WS] Connecté: ${ws.username} (${clients.size} clients)`)

    // Ping/pong pour détecter les déconnexions
    ws.on('pong', () => { ws.isAlive = true })

    ws.on('close', () => {
      clients.delete(ws)
      console.log(`[WS] Déconnecté: ${ws.username} (${clients.size} clients)`)
    })

    ws.on('error', (err) => {
      console.error(`[WS] Erreur (${ws.username}):`, err)
      clients.delete(ws)
    })

    // Ping de bienvenue
    ws.send(JSON.stringify({ type: 'connected', message: 'Bienvenue sur LumHub' }))
  })

  // Heartbeat toutes les 30s — déconnecte les clients fantômes
  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (!ws.isAlive) {
        clients.delete(ws)
        ws.terminate()
        continue
      }
      ws.isAlive = false
      ws.ping()
    }
  }, 30_000)

  wss.on('close', () => clearInterval(heartbeat))

  console.log('[WS] Serveur WebSocket initialisé')
}

export function broadcastDeviceState(deviceId: number, key: string, value: any): void {
  const message = JSON.stringify({
    type:      'device_state',
    device_id: deviceId,
    key,
    value,
    timestamp: new Date().toISOString()
  })

  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message)
    }
  }
}

export function broadcastDeviceOnline(deviceId: number, online: boolean): void {
  const message = JSON.stringify({
    type:      'device_online',
    device_id: deviceId,
    online,
    timestamp: new Date().toISOString()
  })

  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message)
    }
  }
}

export function broadcastToOwner(event: string, data: any): void {
  const message = JSON.stringify({ type: event, ...data, timestamp: new Date().toISOString() })

  for (const ws of clients) {
    if (ws.role === 'owner' && ws.readyState === WebSocket.OPEN) {
      ws.send(message)
    }
  }
}
