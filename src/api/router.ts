import { Router } from 'express'
import { authMiddleware, ownerOnly } from './middleware/auth'

// Routes
import { authRouter }        from './routes/auth'
import { usersRouter }       from './routes/users'
import { roomsRouter }       from './routes/rooms'
import { devicesRouter }     from './routes/devices'
import { scenesRouter }      from './routes/scenes'
import { automationsRouter } from './routes/automations'
import { settingsRouter }    from './routes/settings'
import { profilesRouter }    from './routes/profiles'

export const router = Router()

// Public
router.use('/auth',     authRouter)

// Authentifié
router.use(authMiddleware)
router.use('/users',       usersRouter)
router.use('/rooms',       roomsRouter)
router.use('/devices',     devicesRouter)
router.use('/scenes',      scenesRouter)
router.use('/automations', automationsRouter)
router.use('/profiles',    profilesRouter)

// Owner uniquement
router.use('/settings', ownerOnly, settingsRouter)
