import { Router, Request, Response } from 'express'
import bcrypt from 'bcrypt'
import { getDb } from '../../database'
import { ownerOnly } from '../middleware/auth'

export const usersRouter = Router()

// GET /api/v1/users — owner uniquement
usersRouter.get('/', ownerOnly, (req: Request, res: Response) => {
  const users = getDb().prepare(`
    SELECT id, username, email, role, avatar, is_active, created_at, last_login
    FROM users ORDER BY role, username
  `).all()
  res.json(users)
})

// POST /api/v1/users — créer un user (owner uniquement)
usersRouter.post('/', ownerOnly, (req: Request, res: Response) => {
  const { username, password, role = 'user', email } = req.body

  if (!username || !password) {
    res.status(400).json({ error: 'Username et mot de passe requis' }); return
  }
  if (!['user', 'guest'].includes(role)) {
    res.status(400).json({ error: 'Rôle invalide (user ou guest)' }); return
  }

  const db = getDb()
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
  if (exists) { res.status(409).json({ error: 'Username déjà pris' }); return }

  const passwordHash = bcrypt.hashSync(password, 12)
  const result = db.prepare(`
    INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)
  `).run(username, email || null, passwordHash, role)

  res.status(201).json({ id: result.lastInsertRowid, username, role })
})

// PATCH /api/v1/users/:id
usersRouter.patch('/:id', ownerOnly, (req: Request, res: Response) => {
  const db = getDb()
  const { username, email, password, role, is_active } = req.body
  const userId = parseInt(req.params.id, 10)

  // Empêcher de changer le rôle owner
  const target = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as any
  if (!target) { res.status(404).json({ error: 'Utilisateur non trouvé' }); return }
  if (target.role === 'owner' && role && role !== 'owner') {
    res.status(400).json({ error: 'Impossible de changer le rôle du propriétaire' }); return
  }

  const passwordHash = password ? bcrypt.hashSync(password, 12) : undefined

  db.prepare(`
    UPDATE users SET
      username      = COALESCE(?, username),
      email         = COALESCE(?, email),
      password_hash = COALESCE(?, password_hash),
      role          = COALESCE(?, role),
      is_active     = COALESCE(?, is_active)
    WHERE id = ?
  `).run(username, email, passwordHash, role, is_active, userId)

  res.json({ success: true })
})

// DELETE /api/v1/users/:id
usersRouter.delete('/:id', ownerOnly, (req: Request, res: Response) => {
  const db = getDb()
  const userId = parseInt(req.params.id, 10)

  const target = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as any
  if (!target) { res.status(404).json({ error: 'Utilisateur non trouvé' }); return }
  if (target.role === 'owner') {
    res.status(400).json({ error: 'Impossible de supprimer le propriétaire' }); return
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(userId)
  res.json({ success: true })
})

// GET /api/v1/users/:id/permissions — permissions guest
usersRouter.get('/:id/permissions', ownerOnly, (req: Request, res: Response) => {
  const perms = getDb().prepare(`
    SELECT udp.*, d.name as device_name, d.type as device_type
    FROM user_device_permissions udp
    JOIN devices d ON d.id = udp.device_id
    WHERE udp.user_id = ?
  `).all(req.params.id)
  res.json(perms)
})

// PUT /api/v1/users/:id/permissions
usersRouter.put('/:id/permissions', ownerOnly, (req: Request, res: Response) => {
  const { permissions } = req.body // [{ device_id, can_read, can_control }]
  const db = getDb()
  const userId = parseInt(req.params.id, 10)

  const upsert = db.prepare(`
    INSERT INTO user_device_permissions (user_id, device_id, can_read, can_control)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, device_id) DO UPDATE SET
      can_read    = excluded.can_read,
      can_control = excluded.can_control
  `)

  const upsertMany = db.transaction((perms: any[]) => {
    for (const p of perms) {
      upsert.run(userId, p.device_id, p.can_read ? 1 : 0, p.can_control ? 1 : 0)
    }
  })

  upsertMany(permissions)
  res.json({ success: true })
})
