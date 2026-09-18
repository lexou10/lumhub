#!/usr/bin/env python3
"""
LumHub LED Ring Service - 12 LEDs NeoPixel sur GPIO 21 (PCM)
Écoute un socket Unix /run/lumhub-leds.sock
"""
import socket, os, time, threading, signal, sys
from rpi_ws281x import PixelStrip, Color

LED_COUNT      = 12
LED_PIN        = 21
LED_FREQ_HZ    = 800000
LED_DMA        = 10
LED_BRIGHTNESS = 100
LED_INVERT     = False
LED_CHANNEL    = 0
SOCK_PATH      = '/run/lumhub-leds.sock'

strip = PixelStrip(LED_COUNT, LED_PIN, LED_FREQ_HZ, LED_DMA, LED_INVERT, LED_BRIGHTNESS, LED_CHANNEL)
strip.begin()

current_state = 'boot'
running = True

def all_off():
    for i in range(LED_COUNT):
        strip.setPixelColor(i, Color(0, 0, 0))
    strip.show()

def all_color(r, g, b):
    for i in range(LED_COUNT):
        strip.setPixelColor(i, Color(r, g, b))
    strip.show()

def run_animation():
    global current_state, running
    pos = 0
    brightness = 0
    direction = 1
    while running:
        state = current_state
        if state == 'off':
            all_off()
            time.sleep(0.1)
        elif state == 'ok':
            all_color(0, 80, 0)
            time.sleep(0.5)
        elif state == 'boot':
            all_off()
            strip.setPixelColor(pos % LED_COUNT, Color(100, 80, 0))
            strip.setPixelColor((pos - 1) % LED_COUNT, Color(40, 30, 0))
            strip.show()
            pos += 1
            time.sleep(0.05)
        elif state == 'pairing':
            all_off()
            strip.setPixelColor(pos % LED_COUNT, Color(0, 0, 150))
            strip.setPixelColor((pos - 1) % LED_COUNT, Color(0, 0, 50))
            strip.show()
            pos += 1
            time.sleep(0.05)
        elif state == 'error':
            all_color(150, 0, 0)
            time.sleep(0.3)
            all_off()
            time.sleep(0.3)
        elif state == 'ble_setup':
            all_color(180, 90, 0)
            time.sleep(0.3)
            all_off()
            time.sleep(0.3)
        elif state == 'warning':
            brightness += direction * 15
            if brightness >= 150: direction = -1
            if brightness <= 0: direction = 1
            all_color(brightness, brightness // 4, 0)
            time.sleep(0.03)
        elif state == 'debug':
            brightness += direction * 5
            if brightness >= 80: direction = -1
            if brightness <= 0: direction = 1
            all_color(brightness, brightness // 4, 0)
            time.sleep(0.05)

def run_server():
    global current_state
    if os.path.exists(SOCK_PATH):
        os.remove(SOCK_PATH)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(SOCK_PATH)
    os.chmod(SOCK_PATH, 0o666)
    server.listen(5)
    while running:
        try:
            server.settimeout(1)
            conn, _ = server.accept()
            data = conn.recv(64).decode().strip()
            if data in ('boot', 'ok', 'pairing', 'error', 'warning', 'debug', 'off', 'ble_setup'):
                current_state = data
            conn.close()
        except socket.timeout:
            continue
        except Exception:
            break

def shutdown(sig, frame):
    global running
    running = False
    all_off()
    if os.path.exists(SOCK_PATH):
        os.remove(SOCK_PATH)
    sys.exit(0)

signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)

t_anim = threading.Thread(target=run_animation, daemon=True)
t_serv = threading.Thread(target=run_server, daemon=True)
t_anim.start()
t_serv.start()

time.sleep(10)
if current_state == 'boot':
    current_state = 'ok'

while running:
    time.sleep(1)
