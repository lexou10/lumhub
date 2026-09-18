#!/usr/bin/env python3
"""
LumHub - Serveur BLE de configuration WiFi

Ne tourne QUE pendant la fenêtre de config déclenchée par un appui
bouton 10-20s (voir lumhub-button.py) — le service systemd associé
(lumhub-ble.service) a une ConditionPathExists sur le flag ci-dessous,
donc ce script ne démarre jamais en dehors de cette fenêtre.

Flux :
  1. Coupe Zigbee2MQTT (le RaspBee II partage l'UART avec le Bluetooth,
     donc les deux ne peuvent pas fonctionner en même temps)
  2. LED pairing (bleu tournant)
  3. Expose un service GATT avec deux caractéristiques :
     - wifi_config (write)  : JSON {"ssid": "...", "psk": "..."}
     - status (read/notify) : JSON {"state": ..., "ip": ...}
  4. Une fois la connexion WiFi réussie : réactive dtoverlay=disable-bt,
     supprime le flag, et reboot (Zigbee et tout le reste repartent
     normalement au démarrage suivant)
"""

import json
import subprocess
import threading
import time
import socket

import dbus
import dbus.exceptions
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

BLUEZ_SERVICE_NAME = "org.bluez"
DBUS_OM_IFACE = "org.freedesktop.DBus.ObjectManager"
DBUS_PROP_IFACE = "org.freedesktop.DBus.Properties"

GATT_MANAGER_IFACE = "org.bluez.GattManager1"
GATT_SERVICE_IFACE = "org.bluez.GattService1"
GATT_CHRC_IFACE = "org.bluez.GattCharacteristic1"

LE_ADVERTISING_MANAGER_IFACE = "org.bluez.LEAdvertisingManager1"
LE_ADVERTISEMENT_IFACE = "org.bluez.LEAdvertisement1"

ADAPTER_PATH = "/org/bluez/hci0"

SERVICE_UUID = "8f9a0001-3b6f-4a7e-9c1d-2e5f7a8b9c0d"
WIFI_CONFIG_CHAR_UUID = "8f9a0002-3b6f-4a7e-9c1d-2e5f7a8b9c0d"
STATUS_CHAR_UUID = "8f9a0003-3b6f-4a7e-9c1d-2e5f7a8b9c0d"
NETWORKS_CHAR_UUID = "8f9a0004-3b6f-4a7e-9c1d-2e5f7a8b9c0d"
ADV_LOCAL_NAME = "LumHub"

NETWORK_SCAN_INTERVAL = 8.0

BLE_FLAG = "/var/lib/lumhub/ble-mode-active"
CONFIG_TXT = "/boot/firmware/config.txt"
LED_SOCK = "/run/lumhub-leds.sock"
WLAN_IFACE = "wlan0"


def send_led(state):
    for attempt in range(10):
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.settimeout(1)
            s.connect(LED_SOCK)
            s.send(state.encode())
            s.close()
            return
        except Exception:
            time.sleep(0.3)


def apply_wifi_config(ssid, psk):
    try:
        cmd = ["nmcli", "device", "wifi", "connect", ssid]
        if psk:
            cmd += ["password", psk]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return result.returncode == 0, (result.stderr or "").strip()
    except subprocess.TimeoutExpired:
        return False, "timeout"


def finish_success():
    print("[BLE] WiFi configuré avec succès, sortie du mode BLE")
    send_led('ok')
    try:
        subprocess.run(
            ["sed", "-i", "s/^#dtoverlay=disable-bt/dtoverlay=disable-bt/", CONFIG_TXT],
            check=True,
        )
    except Exception as e:
        print(f"[BLE] Erreur restauration config.txt: {e}")
    try:
        import os
        os.remove(BLE_FLAG)
    except Exception:
        pass
    time.sleep(3)  # laisse le temps à la notif status de partir
    subprocess.call(['sudo', 'reboot'])


def scan_networks():
    try:
        subprocess.run(
            ["nmcli", "device", "wifi", "rescan"], capture_output=True, timeout=10
        )
        out = subprocess.check_output(
            ["nmcli", "-t", "-f", "SSID,SIGNAL,SECURITY", "device", "wifi", "list"],
            text=True,
            timeout=10,
        )
        seen = set()
        networks = []
        for line in out.strip().splitlines():
            parts = line.split(":")
            if len(parts) < 3:
                continue
            security = parts[-1]
            try:
                signal = int(parts[-2])
            except ValueError:
                signal = 0
            ssid = ":".join(parts[:-2])
            if ssid and ssid not in seen:
                seen.add(ssid)
                networks.append({"ssid": ssid, "signal": signal, "security": security})
        networks.sort(key=lambda n: n["signal"], reverse=True)
        return networks
    except Exception as e:
        print(f"[BLE] Erreur scan réseaux: {e}")
        return []


def network_scan_loop(networks_char, stop_event):
    while not stop_event.is_set():
        networks = scan_networks()
        print(f"[BLE] {len(networks)} réseau(x) trouvé(s)")
        networks_char.update_networks(networks)
        stop_event.wait(NETWORK_SCAN_INTERVAL)


class InvalidArgsException(dbus.exceptions.DBusException):
    _dbus_error_name = "org.freedesktop.DBus.Error.InvalidArgs"


class Application(dbus.service.Object):
    def __init__(self, bus):
        self.path = "/org/lumhub/ble"
        self.services = []
        dbus.service.Object.__init__(self, bus, self.path)
        self.add_service(LumHubService(bus, 0, self))

    def get_path(self):
        return dbus.ObjectPath(self.path)

    def add_service(self, service):
        self.services.append(service)

    @dbus.service.method(DBUS_OM_IFACE, out_signature="a{oa{sa{sv}}}")
    def GetManagedObjects(self):
        response = {}
        for service in self.services:
            response[service.get_path()] = service.get_properties()
            for chrc in service.characteristics:
                response[chrc.get_path()] = chrc.get_properties()
        return response


class LumHubService(dbus.service.Object):
    PATH_BASE = "/org/lumhub/ble/service"

    def __init__(self, bus, index, app):
        self.path = f"{self.PATH_BASE}{index}"
        self.bus = bus
        self.uuid = SERVICE_UUID
        self.primary = True
        self.characteristics = []
        dbus.service.Object.__init__(self, bus, self.path)
        self.status_char = StatusCharacteristic(bus, 1, self)
        self.networks_char = NetworksCharacteristic(bus, 2, self)
        self.add_characteristic(WifiConfigCharacteristic(bus, 0, self))
        self.add_characteristic(self.status_char)
        self.add_characteristic(self.networks_char)

    def get_path(self):
        return dbus.ObjectPath(self.path)

    def add_characteristic(self, chrc):
        self.characteristics.append(chrc)

    def get_properties(self):
        return {
            GATT_SERVICE_IFACE: {
                "UUID": self.uuid,
                "Primary": self.primary,
                "Characteristics": dbus.Array(
                    [c.get_path() for c in self.characteristics], signature="o"
                ),
            }
        }

    @dbus.service.method(DBUS_PROP_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        if interface != GATT_SERVICE_IFACE:
            raise InvalidArgsException()
        return self.get_properties()[GATT_SERVICE_IFACE]


class Characteristic(dbus.service.Object):
    def __init__(self, bus, index, uuid, flags, service):
        self.path = service.path + "/char" + str(index)
        self.bus = bus
        self.uuid = uuid
        self.service = service
        self.flags = flags
        self.notifying = False
        dbus.service.Object.__init__(self, bus, self.path)

    def get_path(self):
        return dbus.ObjectPath(self.path)

    def get_properties(self):
        return {
            GATT_CHRC_IFACE: {
                "Service": self.service.get_path(),
                "UUID": self.uuid,
                "Flags": self.flags,
            }
        }

    @dbus.service.method(DBUS_PROP_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        if interface != GATT_CHRC_IFACE:
            raise InvalidArgsException()
        return self.get_properties()[GATT_CHRC_IFACE]


class WifiConfigCharacteristic(Characteristic):
    """Write-only. Payload JSON UTF-8 {"ssid": "...", "psk": "..."}"""

    def __init__(self, bus, index, service):
        Characteristic.__init__(self, bus, index, WIFI_CONFIG_CHAR_UUID, ["write"], service)

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="aya{sv}")
    def WriteValue(self, value, options):
        try:
            raw = bytes(value).decode("utf-8")
            data = json.loads(raw)
            ssid = data.get("ssid")
            psk = data.get("psk", "")
            if not ssid:
                raise InvalidArgsException("ssid manquant")
        except (ValueError, UnicodeDecodeError):
            raise InvalidArgsException("payload JSON invalide")

        print(f"[BLE] Reçu config WiFi pour SSID='{ssid}'")
        status_char = self.service.status_char
        status_char.update_status("connecting", None)

        def worker():
            ok, err = apply_wifi_config(ssid, psk)
            if ok:
                status_char.update_status("connected", None)
                finish_success()
            else:
                print(f"[BLE] Échec connexion: {err}")
                status_char.update_status("error", None)

        threading.Thread(target=worker, daemon=True).start()


class StatusCharacteristic(Characteristic):
    """Read + Notify. JSON {"state": ..., "ip": ...}"""

    def __init__(self, bus, index, service):
        Characteristic.__init__(self, bus, index, STATUS_CHAR_UUID, ["read", "notify"], service)
        self._value = self._encode({"state": "waiting", "ip": None})

    @staticmethod
    def _encode(payload):
        return [dbus.Byte(b) for b in json.dumps(payload).encode("utf-8")]

    def update_status(self, state, ip=None):
        self._value = self._encode({"state": state, "ip": ip})
        if self.notifying:
            self.PropertiesChanged(
                GATT_CHRC_IFACE, {"Value": dbus.Array(self._value, signature="y")}, []
            )

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="a{sv}", out_signature="ay")
    def ReadValue(self, options):
        offset = int(options.get("offset", 0))
        return self._value[offset:]

    @dbus.service.method(GATT_CHRC_IFACE)
    def StartNotify(self):
        self.notifying = True

    @dbus.service.method(GATT_CHRC_IFACE)
    def StopNotify(self):
        self.notifying = False

    @dbus.service.signal(DBUS_PROP_IFACE, signature="sa{sv}as")
    def PropertiesChanged(self, interface, changed, invalidated):
        pass


class NetworksCharacteristic(Characteristic):
    """
    Read + Notify. JSON UTF-8 : liste des réseaux WiFi scannés
    [{"ssid": "...", "signal": 80, "security": "WPA2"}, ...]
    Mise à jour en tâche de fond toutes les NETWORK_SCAN_INTERVAL secondes.
    """

    def __init__(self, bus, index, service):
        Characteristic.__init__(self, bus, index, NETWORKS_CHAR_UUID, ["read", "notify"], service)
        self._value = self._encode([])

    @staticmethod
    def _encode(networks):
        return [dbus.Byte(b) for b in json.dumps(networks).encode("utf-8")]

    def update_networks(self, networks):
        self._value = self._encode(networks)
        if self.notifying:
            self.PropertiesChanged(
                GATT_CHRC_IFACE, {"Value": dbus.Array(self._value, signature="y")}, []
            )

    @dbus.service.method(GATT_CHRC_IFACE, in_signature="a{sv}", out_signature="ay")
    def ReadValue(self, options):
        offset = int(options.get("offset", 0))
        return self._value[offset:]

    @dbus.service.method(GATT_CHRC_IFACE)
    def StartNotify(self):
        self.notifying = True

    @dbus.service.method(GATT_CHRC_IFACE)
    def StopNotify(self):
        self.notifying = False

    @dbus.service.signal(DBUS_PROP_IFACE, signature="sa{sv}as")
    def PropertiesChanged(self, interface, changed, invalidated):
        pass


class Advertisement(dbus.service.Object):
    PATH = "/org/lumhub/ble/advertisement0"

    def __init__(self, bus, local_name):
        self.path = self.PATH
        self.ad_type = "peripheral"
        self.service_uuids = [SERVICE_UUID]
        self.local_name = local_name
        dbus.service.Object.__init__(self, bus, self.path)

    def get_path(self):
        return dbus.ObjectPath(self.path)

    def get_properties(self):
        return {
            LE_ADVERTISEMENT_IFACE: {
                "Type": self.ad_type,
                "ServiceUUIDs": dbus.Array(self.service_uuids, signature="s"),
            }
        }

    @dbus.service.method(DBUS_PROP_IFACE, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        if interface != LE_ADVERTISEMENT_IFACE:
            raise InvalidArgsException()
        return self.get_properties()[LE_ADVERTISEMENT_IFACE]

    @dbus.service.method(LE_ADVERTISEMENT_IFACE)
    def Release(self):
        pass


DB_PATH = "/var/lib/lumhub/lumhub.db"


def get_box_name():
    try:
        import sqlite3
        conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=3)
        row = conn.execute("SELECT value FROM settings WHERE key = 'box_name'").fetchone()
        conn.close()
        if row and row[0]:
            return row[0]
    except Exception as e:
        print(f"[BLE] Impossible de lire box_name: {e}")
    import socket as _socket
    return _socket.gethostname()


def main():
    print("[BLE] Arrêt de Zigbee2MQTT (partage l'UART avec le Bluetooth)")
    subprocess.run(["systemctl", "stop", "zigbee2mqtt"], capture_output=True)

    send_led('ble_setup')

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()

    app = Application(bus)
    box_name = get_box_name()[:4]  # marge de sécurité stricte sur les 31 octets max du paquet BLE
    adv = Advertisement(bus, box_name)

    adapter_obj = bus.get_object(BLUEZ_SERVICE_NAME, ADAPTER_PATH)
    gatt_manager = dbus.Interface(adapter_obj, GATT_MANAGER_IFACE)
    ad_manager = dbus.Interface(adapter_obj, LE_ADVERTISING_MANAGER_IFACE)

    gatt_manager.RegisterApplication(
        app.get_path(), {},
        reply_handler=lambda: print("[BLE] GATT app enregistrée"),
        error_handler=lambda e: print(f"[BLE] Erreur RegisterApplication: {e}"),
    )
    ad_manager.RegisterAdvertisement(
        adv.get_path(), {},
        reply_handler=lambda: print("[BLE] Advertising démarré"),
        error_handler=lambda e: print(f"[BLE] Erreur RegisterAdvertisement: {e}"),
    )

    print("[BLE] En attente de configuration WiFi...")

    stop_event = threading.Event()
    scan_thread = threading.Thread(
        target=network_scan_loop, args=(app.services[0].networks_char, stop_event), daemon=True
    )
    scan_thread.start()

    mainloop = GLib.MainLoop()
    mainloop.run()


if __name__ == "__main__":
    main()
