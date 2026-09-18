#!/usr/bin/env python3
"""
LumHub - Bouton physique GPIO 22

Toutes les actions sont décidées AU RELÂCHEMENT du bouton, selon la
durée totale de l'appui — rien ne se déclenche pendant que le bouton
est encore tenu, pour ne jamais couper court à un appui plus long.

  < 1s              → ok / debug (double appui)
  1s à 10s          → si pas de WiFi : mode config BLE
                       si WiFi connecté : clignote vert x2 (déjà connectée)
  10s à 15s         → reboot
  ≥ 15s             → shutdown
"""
import time
import subprocess
import socket
import signal
import sys
import threading
import gpiod
from gpiod.line import Direction, Bias, Value

BUTTON_PIN = 22
SOCK_PATH  = '/run/lumhub-leds.sock'

BLE_MIN_S      = 1.0
REBOOT_MIN_S   = 10.0
SHUTDOWN_MIN_S = 15.0

BLE_FLAG   = "/var/lib/lumhub/ble-mode-active"
CONFIG_TXT = "/boot/firmware/config.txt"
WLAN_IFACE = "wlan0"

def send_led(state):
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(SOCK_PATH)
        s.send(state.encode())
        s.close()
    except Exception:
        pass

def blink_ok_twice():
    for _ in range(2):
        send_led('off')
        time.sleep(0.15)
        send_led('ok')
        time.sleep(0.15)
    send_led('ok')

def wifi_really_connected():
    """
    True si wlan0 est actuellement connecté à un vrai réseau WiFi.
    """
    try:
        out = subprocess.check_output(
            ["nmcli", "-t", "-f", "DEVICE,STATE,CONNECTION", "device", "status"],
            text=True,
            timeout=5,
        )
        for line in out.strip().splitlines():
            parts = line.split(":")
            if len(parts) < 3:
                continue
            device, state, connection = parts[0], parts[1], parts[2]
            if device == WLAN_IFACE and state == "connected" and connection != "--":
                return True
        return False
    except Exception:
        return False

def do_ble_setup():
    send_led('ble_setup')
    try:
        # Active le Bluetooth interne (commente la ligne dtoverlay=disable-bt),
        # nécessaire au démarrage suivant pour que le contrôleur BT soit exposé.
        subprocess.run(
            ["sed", "-i", "s/^dtoverlay=disable-bt/#dtoverlay=disable-bt/", CONFIG_TXT],
            check=True,
        )
        with open(BLE_FLAG, "w") as f:
            f.write(str(time.time()))
    except Exception:
        send_led('error')
        return
    time.sleep(1)
    subprocess.call(['sudo', 'reboot'])

def do_reboot():
    send_led('warning')
    time.sleep(1)
    subprocess.call(['sudo', 'reboot'])

def do_shutdown():
    send_led('error')
    time.sleep(1)
    subprocess.call(['sudo', 'poweroff'])

# ─── GPIO (libgpiod v2.x) ───────────────────────────────────────
request = gpiod.request_lines(
    "/dev/gpiochip0",
    consumer="lumhub-button",
    config={BUTTON_PIN: gpiod.LineSettings(direction=Direction.INPUT, bias=Bias.PULL_UP)},
)

def is_pressed():
    return request.get_value(BUTTON_PIN) == Value.INACTIVE

running = True
last_press_time = 0

def shutdown_signal(sig, frame):
    global running
    running = False
    request.release()
    sys.exit(0)

signal.signal(signal.SIGTERM, shutdown_signal)
signal.signal(signal.SIGINT, shutdown_signal)

while running:
    if is_pressed():
        press_start = time.time()

        # On attend juste le relâchement, sans jamais rien déclencher
        # pendant que le bouton est encore tenu.
        while is_pressed():
            time.sleep(0.05)

        duration = time.time() - press_start

        if duration >= SHUTDOWN_MIN_S:
            do_shutdown()
        elif duration >= REBOOT_MIN_S:
            do_reboot()
        elif duration >= BLE_MIN_S:
            if wifi_really_connected():
                blink_ok_twice()
            else:
                do_ble_setup()
        else:
            now = time.time()
            if now - last_press_time < 0.5:
                send_led('debug')
            else:
                send_led('ok')
            last_press_time = now

    time.sleep(0.05)
