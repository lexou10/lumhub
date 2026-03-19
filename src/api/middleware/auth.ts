import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { getDb } from '../../database'

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-in-production'

export interface AuthUser {
  id: number
  username: string
  role: 'owner' | 'user' | 'guest'
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Token manquant' })
    return
  }

  const token = header.slice(7)

  // Vérifier si c'est un api_token permanent (Homebridge, etc.)
  const apiToken = getDb()
    .prepare('SELECT id, name FROM api_tokens WHERE token = ?')
    .get(token) as any
  if (apiToken) {
    req.user = { id: 0, username: apiToken.name, role: 'owner' }
    next()
    return
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as any

    // Vérifier que la session existe en BDD (permet la révocation)
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    const session = getDb()
      .prepare(`SELECT id FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')`)
      .get(tokenHash)

    if (!session) {
      res.status(401).json({ error: 'Session expirée ou révoquée' })
      return
    }

    req.user = { id: payload.userId, username: payload.username, role: payload.role }
    next()
  } catch {
    res.status(401).json({ error: 'Token invalide' })
  }
}

export function ownerOnly(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'owner') {
    res.status(403).json({ error: 'Accès réservé au propriétaire' })
    return
  }
  next()
}

export function ownerOrUser(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role === 'guest') {
    res.status(403).json({ error: 'Accès non autorisé' })
    return
  }
  next()
}

export function generateToken(user: AuthUser): { token: string; expiresAt: Date } {
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 jours
  const token = jwt.sign(
    { userId: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: '30d' }
  )
  return { token, expiresAt }
}
