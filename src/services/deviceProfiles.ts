import fs from 'fs'
import path from 'path'

export interface CapabilityDefinition {
  type: 'enum' | 'boolean' | 'float' | 'integer' | 'string'
  label: string
  unit?: string
  values?: { key: string; label: string; icon?: string }[]
  default?: any
  readonly: boolean
  show_in_ui?: boolean
  history?: boolean
}

export interface DeviceProfile {
  id: string
  manufacturer: string
  model: string
  name: string
  category: string
  icon: string
  color: string
  capabilities: Record<string, CapabilityDefinition>
  ui: {
    primary_control: string
    card_style?: string
    show_consumption?: boolean
    thermostat_compatible?: boolean
  }
  zigbee?: {
    clusters: { input: string[]; output: string[] }
  }
}

const PROFILES_DIR = path.join(__dirname, '../../device-profiles')
const registry = new Map<string, DeviceProfile>()

export function loadProfiles(): void {
  registry.clear()
  let count = 0

  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.name.endsWith('.json')) {
        try {
          const profile: DeviceProfile = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
          registry.set(profile.id, profile)
          count++
        } catch (e) {
          console.error(`[Profiles] Erreur lecture ${fullPath}:`, e)
        }
      }
    }
  }

  walk(PROFILES_DIR)
  console.log(`[Profiles] ${count} profil(s) chargé(s)`)
}

export function findProfile(manufacturer: string, model: string): DeviceProfile | null {
  // Cherche par manufacturer + model exact
  const id = `${manufacturer.toLowerCase().replace(/\s+/g, '-')}-${model}`
  if (registry.has(id)) return registry.get(id)!

  // Cherche par model seul (cas où le manufacturer varie légèrement)
  for (const profile of registry.values()) {
    if (profile.model === model) return profile
  }

  return null
}

export function getProfile(id: string): DeviceProfile | null {
  return registry.get(id) || null
}

export function getAllProfiles(): DeviceProfile[] {
  return Array.from(registry.values())
}

export function getProfilesByCategory(category: string): DeviceProfile[] {
  return Array.from(registry.values()).filter(p => p.category === category)
}
