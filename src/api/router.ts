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
import { thermostatsRouter }     from './routes/thermostats'
import { poolRouter }            from './routes/pool'
import { homekitRouter }     from './routes/homekit'
import { wifiRouter }        from './routes/wifi'
import { irrigationRouter }     from './routes/irrigation'
import { gateRouter }          from './routes/gate'
import { feederRouter }         from './routes/feeder'

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
router.use('/thermostats', thermostatsRouter)
router.use('/homekit',     homekitRouter)
router.use('/pool',       authMiddleware, poolRouter)
router.use('/irrigation', authMiddleware, irrigationRouter)
router.use('/gate',     authMiddleware, gateRouter)
router.use('/feeder',     authMiddleware, feederRouter)


// Owner uniquement
router.use('/settings', ownerOnly, settingsRouter)
router.use('/wifi',     ownerOnly, wifiRouter)
