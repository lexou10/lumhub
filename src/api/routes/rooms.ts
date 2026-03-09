import { Router, Request, Response } from 'express'
import { getDb } from '../../database'
import { ownerOnly } from '../middleware/auth'

export const roomsRouter = Router()

// GET /api/v1/rooms
roomsRouter.get('/', (req: Request, res: Response) => {
  const rooms = getDb().prepare(`
    SELECT r.*, COUNT(d.id) as device_count
    FROM rooms r
    LEFT JOIN devices d ON d.room_id = r.id AND d.is_hidden = 0
    GROUP BY r.id
    ORDER BY r.floor, r.sort_order
  `).all()
  res.json(rooms)
})

// POST /api/v1/rooms
roomsRouter.post('/', ownerOnly, (req: Request, res: Response) => {
  const { name, icon = 'room', floor = 0 } = req.body
  if (!name) { res.status(400).json({ error: 'Nom requis' }); return }

  const result = getDb().prepare(
    'INSERT INTO rooms (name, icon, floor) VALUES (?, ?, ?)'
  ).run(name, icon, floor)

  res.status(201).json({ id: result.lastInsertRowid, name, icon, floor })
})

// PATCH /api/v1/rooms/:id
roomsRouter.patch('/:id', ownerOnly, (req: Request, res: Response) => {
  const { name, icon, floor, sort_order } = req.body
  getDb().prepare(`
    UPDATE rooms SET
      name       = COALESCE(?, name),
      icon       = COALESCE(?, icon),
      floor      = COALESCE(?, floor),
      sort_order = COALESCE(?, sort_order)
    WHERE id = ?
  `).run(name, icon, floor, sort_order, req.params.id)
  res.json({ success: true })
})

// DELETE /api/v1/rooms/:id
roomsRouter.delete('/:id', ownerOnly, (req: Request, res: Response) => {
  // Les devices dans cette pièce auront room_id = NULL (ON DELETE SET NULL)
  getDb().prepare('DELETE FROM rooms WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})
