#!/bin/bash
set -euo pipefail

# Charge un éventuel token GitHub depuis /etc/lumhub/lumhub.env — le repo
# étant public, ce n'est jamais requis (juste utile pour augmenter le
# quota d'appels API si besoin un jour).
if [ -f /etc/lumhub/lumhub.env ]; then
    set -a
    source /etc/lumhub/lumhub.env
    set +a
fi

GITHUB_REPO="lexou10/lumhub"
GITHUB_TOKEN="${LUMHUB_GH_TOKEN:-}"
GITHUB_API="https://api.github.com/repos/${GITHUB_REPO}/releases/latest"
INSTALL_DIR="/opt/lumhub"
BACKUP_DIR="/opt/lumhub-backups"
SCRIPTS_DIR="/usr/local/bin"
DB_PATH="/var/lib/lumhub/lumhub.db"
VERSION_FILE="/opt/lumhub/version.json"
TMP_DIR="/tmp/lumhub-update"
LOG_FILE="/var/log/lumhub-update.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

# Le repo est public — l'authentification n'est jamais requise pour
# check/apply. Un token, si présent, sert uniquement à augmenter le quota
# d'appels API (60/h en anonyme, largement suffisant en usage normal),
# jamais un point de blocage critique.
auth_args() {
    if [ -n "$GITHUB_TOKEN" ]; then
        echo "-H" "Authorization: Bearer $GITHUB_TOKEN"
    fi
}

current_version() {
    if [ -f "$VERSION_FILE" ]; then
        python3 -c "import json,sys; d=json.load(open('$VERSION_FILE')); print(d.get('version','0.0.0'))"
    else
        echo "0.0.0"
    fi
}

cmd_check() {
    log "Vérification des mises à jour..."
    local current
    current=$(current_version)
    local release
    release=$(curl -sf --max-time 10 \
        $(auth_args) \
        -H "Accept: application/vnd.github.v3+json" \
        "$GITHUB_API") || { log "Impossible de contacter GitHub"; exit 1; }
    local latest
    latest=$(echo "$release" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['tag_name'].lstrip('v'))")
    local notes
    notes=$(echo "$release" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('body','')[:500])")
    local download_url
    download_url=$(echo "$release" | python3 -c "
import json,sys
d=json.load(sys.stdin)
assets=[a for a in d.get('assets',[]) if a['name']=='lumhub.tar.gz']
print(assets[0]['browser_download_url'] if assets else '')
")
    python3 -c "
import json
result = {
    'current_version': '$current',
    'latest_version': '$latest',
    'update_available': '$latest' != '$current',
    'notes': '''$notes''',
    'download_url': '$download_url',
    'checked_at': '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
}
print(json.dumps(result, indent=2))
" | tee /tmp/lumhub-update-check.json
    log "Version actuelle: $current | Disponible: $latest"
}

cmd_apply() {
    local force="${1:-}"
    local current
    current=$(current_version)
    if [ ! -f /tmp/lumhub-update-check.json ]; then
        cmd_check
    fi
    local latest download_url
    latest=$(python3 -c "import json; d=json.load(open('/tmp/lumhub-update-check.json')); print(d['latest_version'])")
    download_url=$(python3 -c "import json; d=json.load(open('/tmp/lumhub-update-check.json')); print(d['download_url'])")
    if [ "$latest" = "$current" ] && [ "$force" != "--force" ]; then
        log "Déjà à jour ($current)."
        exit 0
    fi
    log "=== Début mise à jour $current → $latest ==="
    mkdir -p "$BACKUP_DIR"
    BACKUP_NAME="lumhub-backup-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$BACKUP_DIR/$BACKUP_NAME"
    cp -r "$INSTALL_DIR/dist" "$BACKUP_DIR/$BACKUP_NAME/" 2>/dev/null || true
    cp "$DB_PATH" "$BACKUP_DIR/$BACKUP_NAME/lumhub.db" 2>/dev/null || true
    ls -dt "$BACKUP_DIR"/lumhub-backup-* | tail -n +6 | xargs rm -rf 2>/dev/null || true
    log "Téléchargement..."
    rm -rf "$TMP_DIR"
    mkdir -p "$TMP_DIR"
    curl -sfL --max-time 120 $(auth_args) \
      "$download_url" \
      -o "$TMP_DIR/lumhub.tar.gz" || { log "ERREUR: Téléchargement échoué"; exit 1; }
    tar -xzf "$TMP_DIR/lumhub.tar.gz" -C "$TMP_DIR" || { log "ERREUR: Archive corrompue"; exit 1; }
    log "Application..."
    if [ -d "$TMP_DIR/dist" ]; then
        rm -rf "$INSTALL_DIR/dist"
        cp -r "$TMP_DIR/dist" "$INSTALL_DIR/"
        chown -R lumhub:lumhub "$INSTALL_DIR/dist"
    fi

    # Dépendances système pour le mode BLE (python3-dbus, python3-gi ne
    # sont PAS embarquées dans l'archive — ce sont des paquets apt, pas
    # des scripts). Sans elles, lumhub-ble-server.py plante au démarrage.
    if [ -f "$TMP_DIR/scripts/lumhub-ble-server.py" ]; then
        if ! python3 -c "import dbus, gi" 2>/dev/null; then
            log "Installation des dépendances BLE (python3-dbus, python3-gi)..."
            apt-get update >> "$LOG_FILE" 2>&1 || true
            apt-get install -y python3-dbus python3-gi >> "$LOG_FILE" 2>&1 \
                || log "ERREUR: installation des dépendances BLE échouée — le mode BLE ne fonctionnera pas"
        fi
    fi

    # Scripts Python/shell déployés dans /usr/local/bin
    for script in lumhub-leds.py lumhub-button.py lumhub-network-guard.py lumhub-wifi-wait.py lumhub-ble-server.py; do
        if [ -f "$TMP_DIR/scripts/$script" ]; then
            cp "$TMP_DIR/scripts/$script" "$SCRIPTS_DIR/$script"
            chmod +x "$SCRIPTS_DIR/$script"
        fi
    done
    if [ -f "$TMP_DIR/scripts/lumhub-wifi-monitor.sh" ]; then
        cp "$TMP_DIR/scripts/lumhub-wifi-monitor.sh" "$SCRIPTS_DIR/lumhub-wifi-monitor.sh"
        chmod +x "$SCRIPTS_DIR/lumhub-wifi-monitor.sh"
    fi
    if [ -f "$TMP_DIR/scripts/lumhub-update-launcher.sh" ]; then
        cp "$TMP_DIR/scripts/lumhub-update-launcher.sh" "$SCRIPTS_DIR/lumhub-update-launcher.sh"
        chmod +x "$SCRIPTS_DIR/lumhub-update-launcher.sh"
    fi
    # L'updater se met lui-même à jour — évite qu'une box reste bloquée
    # sur une version cassée du script (ex. token révoqué codé en dur)
    # sans pouvoir jamais se réparer via une mise à jour normale.
    if [ -f "$TMP_DIR/scripts/lumhub-updater.sh" ]; then
        cp "$TMP_DIR/scripts/lumhub-updater.sh" "$SCRIPTS_DIR/lumhub-updater.sh"
        chmod +x "$SCRIPTS_DIR/lumhub-updater.sh"
    fi

    # Services systemd
    if [ -f "$TMP_DIR/services/homelumbox-wifi.service" ]; then
        cp "$TMP_DIR/services/homelumbox-wifi.service" "/etc/systemd/system/homelumbox-wifi.service"
        systemctl daemon-reload
        systemctl restart homelumbox-wifi || true
    fi
    if [ -f "$TMP_DIR/services/lumhub-network-guard.service" ]; then
        cp "$TMP_DIR/services/lumhub-network-guard.service" "/etc/systemd/system/lumhub-network-guard.service"
        systemctl daemon-reload
        systemctl enable --now lumhub-network-guard || true
    fi
    if [ -f "$TMP_DIR/services/lumhub-ble.service" ]; then
        cp "$TMP_DIR/services/lumhub-ble.service" "/etc/systemd/system/lumhub-ble.service"
        systemctl daemon-reload
        systemctl enable lumhub-ble || true
    fi

    # Override lumhub.service.d (attente WiFi au démarrage)
    if [ -f "$TMP_DIR/overrides/lumhub.service.d/override.conf" ]; then
        mkdir -p /etc/systemd/system/lumhub.service.d
        cp "$TMP_DIR/overrides/lumhub.service.d/override.conf" /etc/systemd/system/lumhub.service.d/override.conf
        systemctl daemon-reload
    fi

    if [ -f "$TMP_DIR/migrations.sql" ]; then
        sqlite3 "$DB_PATH" < "$TMP_DIR/migrations.sql" || { log "ERREUR: Migration SQL"; exit 1; }
    fi
    if [ -f "$TMP_DIR/version.json" ]; then
        cp "$TMP_DIR/version.json" "$VERSION_FILE"
    fi

    # Firmware Broadcom (BLE) — le contrôleur Bluetooth de certaines box
    # (BCM4345C0) refuse toute advertising LE avec l'ancien firmware
    # (erreur "Invalid Parameters"), quel que soit le code applicatif.
    # Indispensable pour que le mode BLE fonctionne, ne prend effet
    # qu'après reboot.
    NEEDS_REBOOT=0
    if [ -f "$TMP_DIR/scripts/lumhub-ble-server.py" ]; then
        log "Vérification du firmware Bluetooth (BLE)..."
        apt-get update >> "$LOG_FILE" 2>&1 || true
        BEFORE=$(dpkg-query -W -f='${Version}' firmware-brcm80211 2>/dev/null || echo "none")
        apt-get install --only-upgrade -y \
            firmware-brcm80211 firmware-atheros firmware-libertas \
            firmware-mediatek firmware-realtek >> "$LOG_FILE" 2>&1 || true
        AFTER=$(dpkg-query -W -f='${Version}' firmware-brcm80211 2>/dev/null || echo "none")
        if [ "$BEFORE" != "$AFTER" ]; then
            log "Firmware Bluetooth mis à jour ($BEFORE → $AFTER), reboot nécessaire"
            NEEDS_REBOOT=1
        fi
    fi

    if [ "$NEEDS_REBOOT" = "1" ]; then
        log "=== Mise à jour appliquée : $latest — reboot pour finaliser (firmware) ==="
        python3 -c "
import json
result = {'success': True, 'version': '$latest', 'updated_at': '$(date -u +%Y-%m-%dT%H:%M:%SZ)', 'rebooted': True}
open('/tmp/lumhub-update-result.json','w').write(json.dumps(result))
"
        rm -rf "$TMP_DIR"
        sleep 2
        reboot
        exit 0
    fi

    log "Redémarrage..."
    systemctl restart lumhub
    sleep 5
    if systemctl is-active --quiet lumhub; then
        log "=== Mise à jour réussie : $latest ==="
        python3 -c "
import json
result = {'success': True, 'version': '$latest', 'updated_at': '$(date -u +%Y-%m-%dT%H:%M:%SZ)'}
open('/tmp/lumhub-update-result.json','w').write(json.dumps(result))
"
        rm -rf "$TMP_DIR"
        exit 0
    else
        log "ERREUR: lumhub ne démarre pas — rollback"
        cp -r "$BACKUP_DIR/$BACKUP_NAME/dist" "$INSTALL_DIR/"
        chown -R lumhub:lumhub "$INSTALL_DIR/dist"
        systemctl start lumhub
        exit 1
    fi
}

case "${1:-}" in
    check) cmd_check ;;
    apply) cmd_apply "${2:-}" ;;
    *) echo "Usage: $0 check | apply [--force]"; exit 1 ;;
esac
