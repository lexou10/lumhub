import { Router, Request, Response } from 'express'
import bcrypt from 'bcrypt'
import crypto from 'crypto'
import { getDb } from '../../database'
import { generateToken, authMiddleware } from '../middleware/auth'

export const authRouter = Router()

// POST /api/v1/auth/setup — Création du compte owner (onboarding, une seule fois)
authRouter.post('/setup', (req: Request, res: Response) => {
  const db = getDb()

  const ownerExists = db.prepare("SELECT id FROM users WHERE role = 'owner'").get()
  if (ownerExists) {
    res.status(400).json({ error: 'Un compte propriétaire existe déjà' })
    return
  }

  const { username, password, boxName } = req.body
  if (!username || !password) {
    res.status(400).json({ error: 'Username et mot de passe requis' })
    return
  }

  const passwordHash = bcrypt.hashSync(password, 12)

  const user = db.prepare(`
    INSERT INTO users (username, password_hash, role)
    VALUES (?, ?, 'owner')
  `).run(username, passwordHash)

  if (boxName) {
    db.prepare("UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'box_name'")
      .run(boxName)
  }

  db.prepare("UPDATE settings SET value = 'true', updated_at = CURRENT_TIMESTAMP WHERE key = 'onboarding_done'")
    .run()

  const authUser = { id: user.lastInsertRowid as number, username, role: 'owner' as const }
  const { token, expiresAt } = generateToken(authUser)

  // Sauvegarder la session
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  db.prepare(`
    INSERT INTO sessions (user_id, token_hash, device_name, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(authUser.id, tokenHash, req.body.deviceName || 'iPhone', expiresAt.toISOString())

  res.status(201).json({ token, expiresAt, user: authUser })
})

// POST /api/v1/auth/login
authRouter.post('/login', (req: Request, res: Response) => {
  const db = getDb()
  const { username, password, deviceName } = req.body

  if (!username || !password) {
    res.status(400).json({ error: 'Username et mot de passe requis' })
    return
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username) as any
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    res.status(401).json({ error: 'Identifiants incorrects' })
    return
  }

  const authUser = { id: user.id, username: user.username, role: user.role }
  const { token, expiresAt } = generateToken(authUser)

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  db.prepare(`
    INSERT INTO sessions (user_id, token_hash, device_name, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(authUser.id, tokenHash, deviceName || 'iPhone', expiresAt.toISOString())

  db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id)

  res.json({ token, expiresAt, user: authUser })
})

// POST /api/v1/auth/logout
authRouter.post('/logout', authMiddleware, (req: Request, res: Response) => {
  const token = req.headers.authorization!.slice(7)
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
  res.json({ success: true })
})

// GET /api/v1/auth/me
authRouter.get('/me', authMiddleware, (req: Request, res: Response) => {
  const user = getDb()
    .prepare('SELECT id, username, email, role, avatar, created_at, last_login FROM users WHERE id = ?')
    .get(req.user!.id)
  res.json(user)
})

// GET /api/v1/auth/status — vérifie si la box est configurée (pas d'auth)
authRouter.get('/status', (_req: Request, res: Response) => {
  const db = getDb()
  const onboarding = db.prepare("SELECT value FROM settings WHERE key = 'onboarding_done'").get() as any
  const boxName    = db.prepare("SELECT value FROM settings WHERE key = 'box_name'").get() as any
  res.json({
    onboarding_done: onboarding?.value === 'true',
    box_name: boxName?.value
  })
})
