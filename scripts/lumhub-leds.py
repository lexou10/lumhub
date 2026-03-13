#!/usr/bin/env python3
"""
LumHub LED Ring Service - 12 LEDs NeoPixel sur GPIO 21 (PCM)
Écoute un socket Unix /run/lumhub-leds.sock

États :
  boot    → 🟡 Jaune tournant
  ok      → 🟢 Vert fixe
  pairing → 🔵 Bleu tournant
  error   → 🔴 Rouge clignotant
  warning → 🟠 Orange pulsant rapide
  debug   → 🟠 Orange pulsant lent et doux
  off     → Éteint
"""
import socket, os, time, threading, signal, sys
from rpi_ws281x import PixelStrip, Color

# ─── Config ────────────────────────────────────────────────────
LED_COUNT      = 12
LED_PIN        = 21        # GPIO 21 (PCM)
LED_FREQ_HZ    = 800000
LED_DMA        = 10
LED_BRIGHTNESS = 50        # 0-255
LED_INVERT     = False
LED_CHANNEL    = 0
SOCKET_PATH    = '/run/lumhub-leds.sock'

strip = PixelStrip(LED_COUNT, LED_PIN, LED_FREQ_HZ, LED_DMA, LED_INVERT, LED_BRIGHTNESS, LED_CHANNEL)
strip.begin()

current_state    = 'boot'
animation_thread = None
stop_event       = threading.Event()

# ─── Helpers ───────────────────────────────────────────────────
def clear():
    for i in range(LED_COUNT):
        strip.setPixelColor(i, Color(0, 0, 0))
    strip.show()

def set_all(r, g, b):
    for i in range(LED_COUNT):
        strip.setPixelColor(i, Color(r, g, b))
    strip.show()

# ─── Animations ────────────────────────────────────────────────
def animate_spin(r, g, b, tail=4, delay=0.05):
    """Rotation avec traînée."""
    pos = 0
    while not stop_event.is_set():
        for i in range(LED_COUNT):
            dist = (pos - i) % LED_COUNT
            if dist < tail:
                brightness = int((tail - dist) / tail * 255)
                strip.setPixelColor(i, Color(
                    int(r * brightness / 255),
                    int(g * brightness / 255),
                    int(b * brightness / 255)
                ))
            else:
                strip.setPixelColor(i, Color(0, 0, 0))
        strip.show()
        pos = (pos + 1) % LED_COUNT
        time.sleep(delay)

def animate_blink(r, g, b, delay=0.4):
    """Clignotement on/off."""
    state = False
    while not stop_event.is_set():
        if state:
            set_all(r, g, b)
        else:
            clear()
        state = not state
        time.sleep(delay)

def animate_pulse(r, g, b, steps=30, delay=0.04):
    """Pulsation douce — monte et descend l'intensité progressivement.
    steps=30 + delay=0.04 → cycle ~2.4s, très doux.
    """
    import math
    t = 0.0
    while not stop_event.is_set():
        # Courbe sinusoïdale pour un effet très fluide
        factor = (math.sin(t) + 1) / 2   # 0.0 → 1.0
        for i in range(LED_COUNT):
            strip.setPixelColor(i, Color(
                int(r * factor),
                int(g * factor),
                int(b * factor)
            ))
        strip.show()
        t += math.pi / steps
        time.sleep(delay)

def animate_pulse_fast(r, g, b, steps=15, delay=0.03):
    """Pulsation rapide pour warning."""
    import math
    t = 0.0
    while not stop_event.is_set():
        factor = (math.sin(t) + 1) / 2
        for i in range(LED_COUNT):
            strip.setPixelColor(i, Color(
                int(r * factor),
                int(g * factor),
                int(b * factor)
            ))
        strip.show()
        t += math.pi / steps
        time.sleep(delay)

# ─── Gestion états ─────────────────────────────────────────────
def run_animation(state):
    global animation_thread, stop_event
    stop_event.set()
    if animation_thread and animation_thread.is_alive():
        animation_thread.join(timeout=1)
    stop_event = threading.Event()

    def target():
        if state == 'boot':
            animate_spin(255, 180, 0)               # 🟡 Jaune tournant
        elif state == 'ok':
            set_all(0, 80, 0)                       # 🟢 Vert fixe
        elif state == 'pairing':
            animate_spin(0, 80, 255)                # 🔵 Bleu tournant
        elif state == 'error':
            animate_blink(180, 0, 0)                # 🔴 Rouge clignotant
        elif state == 'warning':
            animate_pulse_fast(255, 80, 0)          # 🟠 Orange pulsant rapide
        elif state == 'debug':
            animate_pulse(255, 80, 0, steps=40, delay=0.04)  # 🟠 Orange pulsant lent et doux
        elif state == 'off':
            clear()

    animation_thread = threading.Thread(target=target, daemon=True)
    animation_thread.start()

# ─── Socket Unix ───────────────────────────────────────────────
VALID_STATES = ('boot', 'ok', 'pairing', 'error', 'warning', 'debug', 'off')

def listen():
    global current_state
    if os.path.exists(SOCKET_PATH):
        os.remove(SOCKET_PATH)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(SOCKET_PATH)
    os.chmod(SOCKET_PATH, 0o777)
    server.listen(5)
    server.settimeout(1)
    print('[LEDs] Socket prêt:', SOCKET_PATH)
    while True:
        try:
            conn, _ = server.accept()
            data = conn.recv(64).decode().strip()
            conn.close()
            if data in VALID_STATES:
                print(f'[LEDs] État: {data}')
                current_state = data
                run_animation(data)
        except socket.timeout:
            continue
        except Exception as e:
            print(f'[LEDs] Erreur socket: {e}')

# ─── Signal / shutdown ─────────────────────────────────────────
def shutdown(sig, frame):
    stop_event.set()
    clear()
    sys.exit(0)

signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)

# ─── Start ─────────────────────────────────────────────────────
print('[LEDs] Démarrage LumHub LED Ring')
run_animation('boot')
listen()
