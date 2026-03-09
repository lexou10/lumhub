import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

const DB_PATH = process.env.DB_PATH || '/var/lib/lumhub/lumhub.db'
const SCHEMA_PATH = path.join(__dirname, 'schema.sql')

let db: Database.Database

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.')
  }
  return db
}

export function initDb(): Database.Database {
  // Créer le dossier si nécessaire
  const dbDir = path.dirname(DB_PATH)
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true })
  }

  db = new Database(DB_PATH)

  // Optimisations SQLite pour la stabilité
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  db.pragma('cache_size = 10000')
  db.pragma('temp_store = MEMORY')

  // Appliquer le schéma
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8')
  db.exec(schema)

  // Appliquer les migrations
  runMigrations(db)

  console.log(`[DB] Initialisée : ${DB_PATH}`)
  return db
}

function runMigrations(db: Database.Database): void {
  const migrationsDir = path.join(__dirname, 'migrations')
  if (!fs.existsSync(migrationsDir)) return

  const applied = db
    .prepare('SELECT version FROM migrations')
    .all()
    .map((r: any) => r.version)

  const files = fs
    .readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    const version = file.replace('.sql', '')
    if (applied.includes(version)) continue

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
    db.exec(sql)
    db.prepare('INSERT INTO migrations (version) VALUES (?)').run(version)
    console.log(`[DB] Migration appliquée : ${version}`)
  }
}

export function closeDb(): void {
  if (db) {
    db.close()
    console.log('[DB] Connexion fermée')
  }
}
