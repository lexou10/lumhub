#!/bin/bash
FIRST_BOOT_FLAG="/var/lib/lumhub/first-boot-done"

if [ -f "$FIRST_BOOT_FLAG" ]; then
    exit 0
fi

echo "[LumHub] Premier démarrage - Initialisation..."

# Nouveau hostname unique
NEW_HOSTNAME="lumhub-$(cat /proc/sys/kernel/random/uuid | cut -c1-4)"
hostnamectl set-hostname $NEW_HOSTNAME
sed -i "s/127.0.1.1.*/127.0.1.1\t$NEW_HOSTNAME/" /etc/hosts
echo "[LumHub] Hostname: $NEW_HOSTNAME"

# Reset DB LumHub
rm -f /var/lib/lumhub/lumhub.db
echo "[LumHub] DB réinitialisée"

# Reset Homebridge — nouveau PIN aléatoire
PIN=$(python3 -c "import random; print(f'{random.randint(100,999)}-{random.randint(10,99)}-{random.randint(100,999)}')")
python3 -c "
import json
config = json.load(open('/var/lib/homebridge/config.json'))
config['bridge']['pin'] = '$PIN'
config['bridge']['username'] = ':'.join(['{:02X}'.format(b) for b in __import__('os').urandom(6)])
json.dump(config, open('/var/lib/homebridge/config.json', 'w'), indent=4)
"
rm -f /var/lib/homebridge/accessories/cachedAccessories
rm -f /var/lib/homebridge/persist/*
echo "[LumHub] HomeKit PIN: $PIN"

# Reset Zigbee2MQTT
rm -f /opt/zigbee2mqtt/data/database.db
rm -f /opt/zigbee2mqtt/data/coordinator_backup.json
echo "[LumHub] Zigbee réinitialisé"

# Reset WiFi
rm -f /etc/wpa_supplicant/wpa_supplicant.conf
cat > /etc/wpa_supplicant/wpa_supplicant.conf << 'WPEOF'
country=FR
ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev
update_config=1
WPEOF
echo "[LumHub] WiFi réinitialisé"

echo "[LumHub] ✅ Initialisation terminée — $NEW_HOSTNAME"
touch "$FIRST_BOOT_FLAG"
