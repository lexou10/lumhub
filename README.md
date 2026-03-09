# LumHub Server

Serveur domotique Zigbee pour la box LumHub. Node.js + TypeScript + SQLite.

## Structure du projet

```
lumhub/
├── src/
│   ├── index.ts                    ← Point d'entrée
│   ├── database/
│   │   ├── index.ts                ← Connexion + init SQLite
│   │   ├── schema.sql              ← Schéma complet
│   │   └── migrations/             ← Migrations futures (ex: 1.0.1.sql)
│   ├── api/
│   │   ├── router.ts               ← Routeur principal
│   │   ├── middleware/
│   │   │   └── auth.ts             ← JWT + rôles
│   │   └── routes/
│   │       ├── auth.ts             ← Login, logout, setup, /me
│   │       ├── users.ts            ← CRUD users + permissions
│   │       ├── rooms.ts            ← CRUD pièces
│   │       ├── devices.ts          ← CRUD devices + control + history
│   │       ├── scenes.ts           ← Scènes + activation
│   │       ├── automations.ts      ← Automations
│   │       ├── settings.ts         ← Config box
│   │       └── profiles.ts         ← Profils devices
│   ├── services/
│   │   └── deviceProfiles.ts       ← Registre des profils JSON
│   └── websocket/
│       └── index.ts                ← WebSocket temps réel
├── device-profiles/
│   ├── legrand/
│   │   └── 064882.json             ← Sortie câble chauffage fil pilote
│   ├── ikea/                       ← À compléter
│   ├── sonoff/                     ← À compléter
│   └── aqara/                      ← À compléter
├── package.json
├── tsconfig.json
└── lumhub.service                  ← Service systemd production
```

## Installation

```bash
npm install
npm run dev       # développement
npm run build     # production
npm start         # production
```

## Variables d'environnement

```env
PORT=3000
DB_PATH=/var/lib/lumhub/lumhub.db
JWT_SECRET=votre-secret-tres-long-et-aleatoire
NODE_ENV=production
```

## API REST

### Auth (public)
| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/api/v1/auth/status` | Box configurée ? |
| POST | `/api/v1/auth/setup` | Créer le compte owner (onboarding) |
| POST | `/api/v1/auth/login` | Connexion |
| POST | `/api/v1/auth/logout` | Déconnexion |
| GET | `/api/v1/auth/me` | Profil connecté |

### Devices (authentifié)
| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/api/v1/devices` | Liste tous les devices |
| GET | `/api/v1/devices/:id` | Détail + états + profil |
| PATCH | `/api/v1/devices/:id` | Renommer, changer de pièce |
| DELETE | `/api/v1/devices/:id` | Supprimer (owner) |
| POST | `/api/v1/devices/:id/control` | Envoyer une commande |
| GET | `/api/v1/devices/:id/history` | Historique des états |

### WebSocket
Connexion : `ws://lumhub.local:3000/ws?token=JWT`

Messages reçus :
```json
{ "type": "device_state",  "device_id": 1, "key": "pilot_wire_mode", "value": "eco" }
{ "type": "device_online", "device_id": 1, "online": false }
{ "type": "connected",     "message": "Bienvenue sur LumHub" }
```

## Rôles
- `owner` — accès total
- `user` — contrôle devices, scènes, automations
- `guest` — uniquement les devices autorisés par l'owner

## Ajouter un profil device

Créer un fichier JSON dans `device-profiles/<manufacturer>/<model>.json` :

```json
{
  "id": "legrand-064882",
  "manufacturer": "Legrand",
  "model": "064882",
  "name": "Nom du produit",
  "category": "heating",
  "icon": "heater",
  "color": "#FF6B35",
  "capabilities": {
    "ma_propriete": {
      "type": "enum",
      "label": "Mon label",
      "values": [{ "key": "on", "label": "Allumé" }],
      "default": "on",
      "readonly": false
    }
  },
  "ui": {
    "primary_control": "ma_propriete"
  }
}
```

Le serveur le chargera automatiquement au prochain démarrage.

## Déploiement Raspberry Pi

```bash
# Copier le service systemd
sudo cp lumhub.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable lumhub
sudo systemctl start lumhub

# Voir les logs
sudo journalctl -u lumhub -f
```
