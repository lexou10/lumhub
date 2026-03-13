#!/usr/bin/env python3
"""
LumHub - Bouton physique GPIO 22
Branchement : bouton entre GPIO 22 (pin 15) et GND
Pull-up interne → HIGH au repos, LOW quand appuyé

Actions :
  Appui court  (< 3s)              → reboot
  Appui long   (≥ 10s)             → shutdown
  Double appui (intervalle < 0.5s) → mode debug (orange pulsant doux 60s)
"""

import time
import subprocess
import socket
import threading
import logging
import RPi.GPIO as GPIO

# ─── Config ────────────────────────────────────────────────────
BUTTON_PIN      = 22
REBOOT_MAX_S    = 3.0    # appui < 3s → reboot
SHUTDOWN_MIN_S  = 10.0   # appui ≥ 10s → shutdown
DOUBLE_TAP_S    = 0.5    # intervalle max entre deux appuis
DEBOUNCE_MS     = 50
DEBUG_DURATION  = 60     # secondes en mode debug
LED_SOCK        = "/run/lumhub-leds.sock"

# ─── Logging ───────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [button] %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler("/var/log/lumhub-button.log"),
        logging.StreamHandler()
    ]
)
log = logging.getLogger(__name__)

# ─── LED helper ────────────────────────────────────────────────
def set_led(state: str):
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(1)
            s.connect(LED_SOCK)
            s.sendall(state.encode())
    except Exception as e:
        log.warning(f"LED socket error: {e}")

# ─── Actions ───────────────────────────────────────────────────
def do_reboot():
    log.info("ACTION: reboot")
    set_led("warning")       # orange pulsant rapide pendant 2s
    time.sleep(2)
    subprocess.run(["reboot"])

def do_shutdown():
    log.info("ACTION: shutdown")
    set_led("error")         # rouge clignotant pendant 3s
    time.sleep(3)
    subprocess.run(["shutdown", "-h", "now"])

def do_debug():
    log.info(f"ACTION: mode debug ({DEBUG_DURATION}s)")
    set_led("debug")         # orange pulsant lent et doux
    def reset():
        time.sleep(DEBUG_DURATION)
        log.info("Mode debug terminé → retour ok")
        set_led("ok")
    threading.Thread(target=reset, daemon=True).start()

# ─── Détection appuis ──────────────────────────────────────────
def run():
    GPIO.setmode(GPIO.BCM)
    GPIO.setup(BUTTON_PIN, GPIO.IN, pull_up_down=GPIO.PUD_UP)
    log.info(f"Bouton initialisé sur GPIO {BUTTON_PIN} (pull-up)")

    last_release_time = 0.0
    pending_single    = False
    pending_thread    = None

    while True:
        # Attente appui (front descendant)
        if GPIO.input(BUTTON_PIN) == GPIO.HIGH:
            time.sleep(0.01)
            continue

        # Debounce
        time.sleep(DEBOUNCE_MS / 1000)
        if GPIO.input(BUTTON_PIN) == GPIO.HIGH:
            continue

        press_time = time.time()
        log.debug("Bouton pressé")
        shutdown_triggered = False

        # Surveiller la durée d'appui
        while GPIO.input(BUTTON_PIN) == GPIO.LOW:
            held = time.time() - press_time
            # Pré-alerte à 7s : LED rouge pour signaler approche du seuil shutdown
            if held >= 7.0 and not shutdown_triggered:
                set_led("error")
            # Seuil shutdown atteint
            if held >= SHUTDOWN_MIN_S and not shutdown_triggered:
                shutdown_triggered = True
                log.info(f"Appui très long ({held:.1f}s) → shutdown")
                while GPIO.input(BUTTON_PIN) == GPIO.LOW:
                    time.sleep(0.05)
                do_shutdown()
                return
            time.sleep(0.05)

        if shutdown_triggered:
            continue

        release_time = time.time()
        duration     = release_time - press_time
        log.debug(f"Relâché après {duration:.2f}s")

        # Vérifier double appui
        interval = release_time - last_release_time
        if pending_single and interval < DOUBLE_TAP_S:
            log.info(f"Double appui (intervalle {interval:.2f}s) → debug")
            pending_single = False
            pending_thread = None
            do_debug()
        else:
            # Premier appui — attendre pour confirmer qu'il n'y a pas de deuxième
            pending_single    = True
            last_release_time = release_time
            captured_time     = release_time

            def check_single(t):
                nonlocal pending_single
                time.sleep(DOUBLE_TAP_S + 0.05)
                if pending_single and last_release_time == t:
                    pending_single = False
                    log.info(f"Appui court confirmé ({duration:.2f}s) → reboot")
                    do_reboot()

            pending_thread = threading.Thread(
                target=check_single, args=(captured_time,), daemon=True
            )
            pending_thread.start()

        time.sleep(0.05)

if __name__ == "__main__":
    try:
        run()
    except KeyboardInterrupt:
        log.info("Arrêt manuel")
    finally:
        GPIO.cleanup()
