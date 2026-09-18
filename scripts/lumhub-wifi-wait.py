#!/usr/bin/env python3
"""
LumHub - Attente WiFi avant démarrage du service
Bloque tant que le WiFi n'est pas connecté, LED rouge (error) pendant l'attente.
Prévu comme ExecStartPre de lumhub.service.

Sort avec code 0 dès que le WiFi est connecté (le service peut démarrer).
"""

import socket
import subprocess
import time
import os

LED_SOCK      = "/run/lumhub-leds.sock"
POLL_INTERVAL = 2.0


def set_led(state: str):
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(1)
            s.connect(LED_SOCK)
            s.sendall(state.encode())
    except Exception:
        pass  # le service LED peut ne pas être encore prêt au tout premier boot


def wifi_connected() -> bool:
    try:
        out = subprocess.check_output(
            ["nmcli", "-t", "-f", "TYPE,STATE", "device"],
            text=True,
            timeout=5,
        )
        for line in out.strip().splitlines():
            parts = line.split(":")
            if len(parts) >= 2 and parts[0] == "wifi" and parts[1] == "connected":
                return True
        return False
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return False


def disable_stray_hotspot_autoconnect():
    """
    Garde-fou au boot : le hotspot ne doit JAMAIS démarrer tout seul,
    uniquement via l'appui bouton explicite (voir lumhub-button.py).
    """
    subprocess.run(
        ["nmcli", "connection", "modify", "Hotspot", "connection.autoconnect", "no"],
        capture_output=True,
    )


def force_off_hotspot_if_stuck():
    """
    Si wlan0 a démarré sur le profil Hotspot (raté d'un boot précédent),
    on le coupe et on force le réseau WiFi normal à prendre la main.
    """
    try:
        out = subprocess.check_output(
            ["nmcli", "-t", "-f", "DEVICE,CONNECTION", "device", "status"],
            text=True,
            timeout=5,
        )
        current = None
        for line in out.strip().splitlines():
            parts = line.split(":")
            if len(parts) >= 2 and parts[0] == "wlan0":
                current = parts[1]
                break

        if current != "Hotspot":
            return

        print("[wifi-wait] wlan0 bloqué sur Hotspot au boot, correction...")
        candidates = subprocess.check_output(
            ["nmcli", "-t", "-f", "NAME,TYPE", "connection", "show"],
            text=True,
            timeout=5,
        )
        home_profile = None
        for line in candidates.strip().splitlines():
            parts = line.split(":")
            if len(parts) >= 2 and parts[1] == "wifi" and parts[0] != "Hotspot":
                home_profile = parts[0]
                break

        subprocess.run(["nmcli", "connection", "down", "Hotspot"], capture_output=True)
        if home_profile:
            subprocess.run(["nmcli", "connection", "up", home_profile], capture_output=True)
            print(f"[wifi-wait] Bascule forcée vers '{home_profile}'")
    except Exception as e:
        print(f"[wifi-wait] Erreur correction hotspot: {e}")


def should_auto_enter_ble_mode():
    """
    True uniquement pour une box jamais configurée (onboarding_done=false)
    sans WiFi disponible — pour un premier déballage sans avoir besoin
    d'expliquer le bouton 10-20s à l'utilisateur.
    Une box déjà en service qui perd son WiFi ne rentre JAMAIS en BLE
    automatiquement — seul l'appui bouton explicite le fait, par sécurité.
    """
    if os.path.exists("/var/lib/lumhub/ble-mode-active"):
        return False
    try:
        import sqlite3
        conn = sqlite3.connect("/var/lib/lumhub/lumhub.db", timeout=3)
        row = conn.execute("SELECT value FROM settings WHERE key = 'onboarding_done'").fetchone()
        conn.close()
        return not (row and row[0] == "true")
    except Exception as e:
        print(f"[wifi-wait] Impossible de lire onboarding_done: {e}")
        return False  # par prudence, ne jamais auto-déclencher si on ne sait pas


def enter_ble_mode_and_reboot():
    print("[wifi-wait] Box jamais configurée, pas de WiFi → entrée auto en mode BLE")
    subprocess.run(
        ["sed", "-i", "s/^dtoverlay=disable-bt/#dtoverlay=disable-bt/", "/boot/firmware/config.txt"],
        check=True,
    )
    with open("/var/lib/lumhub/ble-mode-active", "w") as f:
        f.write(str(time.time()))
    subprocess.call(["sudo", "reboot"])


def main():
    disable_stray_hotspot_autoconnect()
    force_off_hotspot_if_stuck()

    if wifi_connected():
        return  # déjà connecté, on ne touche pas la LED, démarrage immédiat

    if should_auto_enter_ble_mode():
        enter_ble_mode_and_reboot()
        return  # ne devrait jamais être atteint (reboot), sécurité

    print("[wifi-wait] Pas de WiFi, attente...")
    if not os.path.exists("/var/lib/lumhub/ble-mode-active"):
        # En mode config BLE, c'est lumhub-ble-server.py qui gère la LED
        # (pairing, bleu tournant) — on ne veut pas la repasser en rouge.
        set_led("error")
    while not wifi_connected():
        time.sleep(POLL_INTERVAL)
    print("[wifi-wait] WiFi connecté, démarrage du service")


if __name__ == "__main__":
    main()
