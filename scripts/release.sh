#!/bin/bash
# LumHub - Créer une release

set -e

cd /home/pi/lumhub

VERSION=$(python3 -c "import json; print(json.load(open('package.json'))['version'])")
echo "Release v$VERSION"

# Build
echo "[1/4] Build..."
npm run build

# Créer structure temporaire
echo "[2/4] Préparation archive..."
TMP=$(mktemp -d)
mkdir -p $TMP/scripts
mkdir -p $TMP/services

# Copier dist
cp -r dist $TMP/

# Copier scripts système
cp /usr/local/bin/lumhub-wifi-monitor.sh $TMP/scripts/
cp /usr/local/bin/lumhub-update-launcher.sh $TMP/scripts/ 2>/dev/null || true
cp /usr/local/bin/lumhub-leds.py $TMP/scripts/ 2>/dev/null || true
cp /usr/local/bin/lumhub-button.py $TMP/scripts/ 2>/dev/null || true

# Copier services
cp /etc/systemd/system/homelumbox-wifi.service $TMP/services/

# Copier version et migrations
cp version.json $TMP/
[ -f migrations.sql ] && cp migrations.sql $TMP/ || true

# Créer l'archive
echo "[3/4] Création archive..."
tar -czf lumhub.tar.gz -C $TMP .
rm -rf $TMP

echo "[4/4] Archive créée : lumhub.tar.gz"
echo "Contenu :"
tar -tzf lumhub.tar.gz | grep -v "\.map" | head -30
