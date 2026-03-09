import { Router, Request, Response } from 'express'
import { exec } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const router = Router()

const VERSION_FILE  = '/opt/lumhub/version.json'
const CHECK_CACHE   = '/tmp/lumhub-update-check.json'
const RESULT_FILE   = '/tmp/lumhub-update-result.json'
const UPDATER       = '/usr/local/bin/lumhub-updater.sh'
const CACHE_TTL_MS  = 60 * 60 * 1000  // 1h

function readJSON(filePath: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

function currentVersion(): string {
  const v = readJSON(VERSION_FILE)
  return v?.version ?? '0.0.0'
}

// ─── GET /api/v1/update/status ──────────────────────────────
// Retourne version actuelle + dernière vérif en cache
router.get('/status', (req: Request, res: Response) => {
  const current = currentVersion()
  const cache   = readJSON(CHECK_CACHE)

  res.json({
    current_version:  current,
    latest_version:   cache?.latest_version  ?? null,
    update_available: cache?.update_available ?? false,
    notes:            cache?.notes           ?? '',
    checked_at:       cache?.checked_at      ?? null,
  })
})

// ─── POST /api/v1/update/check ──────────────────────────────
// Force une vérification GitHub (ou retourne le cache si < 1h)
router.post('/check', (req: Request, res: Response) => {
  const cache = readJSON(CHECK_CACHE)
  if (cache?.checked_at) {
    const age = Date.now() - new Date(cache.checked_at).getTime()
    if (age < CACHE_TTL_MS) {
      return res.json({ ...cache, from_cache: true })
    }
  }

  exec(`sudo ${UPDATER} check`, { timeout: 15000 }, (err, stdout, stderr) => {
    const result = readJSON(CHECK_CACHE)
    if (result) {
      return res.json({ ...result, from_cache: false })
    }
    res.status(500).json({ error: 'Vérification échouée', details: stderr })
  })
})

// ─── POST /api/v1/update/apply ──────────────────────────────
// Lance la mise à jour (async — répond immédiatement)
let updateInProgress = false

router.post('/apply', (req: Request, res: Response) => {
  if (updateInProgress) {
    return res.status(409).json({ error: 'Mise à jour déjà en cours' })
  }

  updateInProgress = true

  // Supprimer l'ancien résultat
  try { fs.unlinkSync(RESULT_FILE) } catch {}

  // Lancer en arrière-plan
  const child = exec(
    `sudo ${UPDATER} apply`,
    { timeout: 300000 },  // 5 min max
    (err, stdout, stderr) => {
      updateInProgress = false
    }
  )

  // Répondre immédiatement — le client poll /update/progress
  res.json({ started: true, message: 'Mise à jour en cours...' })
})

// ─── GET /api/v1/update/progress ────────────────────────────
// Retourne l'état en cours (polling côté iOS)
router.get('/progress', (req: Request, res: Response) => {
  if (updateInProgress) {
    // Lire les dernières lignes du log
    let lastLines = ''
    try {
      const log = fs.readFileSync('/var/log/lumhub-update.log', 'utf-8')
      lastLines = log.split('\n').filter(Boolean).slice(-5).join('\n')
    } catch {}
    return res.json({ in_progress: true, log: lastLines })
  }

  const result = readJSON(RESULT_FILE)
  if (result) {
    return res.json({ in_progress: false, ...result })
  }

  res.json({ in_progress: false, result: null })
})

export default router
