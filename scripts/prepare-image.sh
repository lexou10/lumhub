#!/bin/bash
# LumHub - Préparation image disque
# À lancer AVANT de cloner la carte SD

echo "╔══════════════════════════════════════╗"
echo "║   LumHub - Préparation image disque  ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "⚠️  Ce script va mettre à jour LumHub et effacer toutes les données personnelles."
read -p "Continuer ? (oui/non) : " confirm
if [ "$confirm" != "oui" ]; then echo "Annulé."; exit 0; fi

# 0. Mise à jour LumHub depuis GitHub
echo "[0/7] Mise à jour LumHub vers la dernière version..."
sudo /usr/local/bin/lumhub-updater.sh check
sudo /usr/local/bin/lumhub-updater.sh apply --force
echo "[0/7] ✓ LumHub à jour"

# 1. Arrêter les services
echo "[1/7] Arrêt des services..."
sudo systemctl stop lumhub homebridge zigbee2mqtt mosquitto

# 2. Supprimer la DB LumHub
echo "[2/7] Suppression DB LumHub..."
sudo rm -f /var/lib/lumhub/lumhub.db
sudo rm -f /var/lib/lumhub/first-boot-done
sudo rm -f /var/lib/lumhub/first-boot-done
sudo rm -f /var/lib/lumhub/first-boot-done

# 3. Reset Homebridge
echo "[3/7] Reset Homebridge..."
sudo rm -f /var/lib/homebridge/accessories/cachedAccessories
sudo rm -rf /var/lib/homebridge/persist/*

# 4. Reset Zigbee2MQTT
echo "[4/7] Reset Zigbee2MQTT..."
sudo rm -f /opt/zigbee2mqtt/data/database.db
sudo rm -f /opt/zigbee2mqtt/data/coordinator_backup.json

# 5. Reset WiFi
echo "[5/7] Reset WiFi..."
sudo rm -f /etc/wpa_supplicant/wpa_supplicant.conf
sudo tee /etc/wpa_supplicant/wpa_supplicant.conf << 'WPEOF'
country=FR
ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev
update_config=1
WPEOF

# 6. Nettoyer les logs
echo "[6/7] Nettoyage logs..."
sudo journalctl --rotate --vacuum-time=1s 2>/dev/null
sudo rm -f /var/log/lumhub*.log
sudo rm -f /tmp/lumhub*

# 7. Nettoyer l'historique
echo "[7/7] Nettoyage historique..."
rm -f /home/pi/.bash_history
sudo rm -f /root/.bash_history
history -c

echo ""
echo "✅ Box prête pour le clonage !"
echo ""
echo "Étapes suivantes :"
echo "  1. Éteindre le Pi : sudo poweroff"
echo "  2. Retirer la carte SD"
echo "  3. Sur Mac : sudo dd if=/dev/diskX of=~/lumhub-image.img bs=4m status=progress"
echo "  4. Compresser : gzip ~/lumhub-image.img"
echo "  5. Flasher sur nouvelle carte avec Raspberry Pi Imager"
