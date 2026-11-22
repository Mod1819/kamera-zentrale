"""Erkennungs-Schalter je Objekttyp (Push/Aufnahme/FTP/E-Mail/Tracking) über die HA-Reolink-Integration.

Reine Funktionen (Tabelle<->bool, Antwort->Matrix) sind ohne hass testbar; `async_get`/`async_set`
sprechen die Kamera über `entry.runtime_data.host.api.send(...)` (reolink_aio) der bestehenden Integration an.
"""
from __future__ import annotations

import logging
import re
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr

from .const import REOLINK_DOMAIN

_LOGGER = logging.getLogger(__name__)

TABLE_LEN = 7 * 24
# Typ -> Schlüssel in schedule.table (Reihenfolge = Ausgabe-Reihenfolge)
TYPE_KEYS: dict[str, str] = {
    "people": "AI_PEOPLE", "vehicle": "AI_VEHICLE", "dog_cat": "AI_DOG_CAT", "md": "MD",
}
TYPES = tuple(TYPE_KEYS)
TRACK_TYPES = ("people", "vehicle", "dog_cat")  # "face" bewusst weggelassen
# Aktion -> (Get-Befehl, Set-Befehl, Schlüssel im value)
ACTIONS: dict[str, tuple[str, str, str]] = {
    "push": ("GetPushV20", "SetPushV20", "Push"),
    "rec": ("GetRecV20", "SetRecV20", "Rec"),
    "ftp": ("GetFtpV20", "SetFtpV20", "Ftp"),
    "email": ("GetEmailV20", "SetEmailV20", "Email"),
}
NOT_READY = "Reolink-Integration nicht bereit"


class DetectionError(Exception):
    """Fehler mit Code für send_error."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# ---------- reine Funktionen ----------

def table_enabled(table: str) -> bool:
    return "1" in table


def build_table(enable: bool) -> str:
    return ("1" if enable else "0") * TABLE_LEN


def parse_action(value: dict[str, Any], key: str) -> dict[str, bool]:
    """value (Antwort von GetXxxV20) -> {type: bool}, nur Typen, die die Kamera liefert."""
    table = ((value.get(key) or {}).get("schedule") or {}).get("table") or {}
    return {t: table_enabled(str(table[k])) for t, k in TYPE_KEYS.items() if k in table}


def parse_tracking(value: dict[str, Any]) -> dict[str, bool]:
    cfg = value.get("AiDetectType") or {}
    return {t: bool(cfg[t]) for t in TRACK_TYPES if t in cfg}


def build_matrix(values: dict[str, dict[str, Any] | None], tracking: dict[str, Any] | None) -> dict[str, Any]:
    """Antworten je Aktion (None = Befehl fehlgeschlagen) -> Ergebnis des WebSocket-get."""
    actions = {a: parse_action(v, ACTIONS[a][2]) for a, v in values.items() if v is not None}
    present = {t for m in actions.values() for t in m}
    return {
        "types": [t for t in TYPES if t in present],
        "actions": actions,
        "tracking": parse_tracking(tracking) if tracking is not None else None,
    }


def channel_of(identifiers: set[tuple[str, str]]) -> int:
    for dom, ident in identifiers:
        if dom == REOLINK_DOMAIN and (m := re.search(r"_ch(\d+)$", str(ident))):
            return int(m.group(1))
    return 0


# ---------- Kamera-Zugriff ----------

def _api(hass: HomeAssistant, device: dr.DeviceEntry):
    for entry_id in (({getattr(device, 'config_entry_id', None)} - {None}) or set(device.config_entries)):
        entry = hass.config_entries.async_get_entry(entry_id)
        if entry is None or entry.domain != REOLINK_DOMAIN:
            continue
        api = getattr(getattr(getattr(entry, "runtime_data", None), "host", None), "api", None)
        if api is not None:
            return api
    raise DetectionError("reolink_not_ready", NOT_READY)


async def _send(api, cmd: str, param: dict[str, Any], action: int = 0) -> dict[str, Any] | None:
    """Befehl senden -> value, None bei code != 0 / leerer Antwort. Verbindungsfehler -> DetectionError."""
    try:
        res = await api.send([{"cmd": cmd, "action": action, "param": param}], expected_response_type="json")
    except Exception as err:  # reolink_aio wirft verschiedene Fehlertypen
        raise DetectionError("camera_error", f"{cmd}: {err}") from err
    item = res[0] if res else None
    if not isinstance(item, dict) or item.get("code", 0) != 0:
        return None
    return item.get("value") or {}


async def _read(api, ch: int) -> dict[str, Any]:
    values = {a: await _send(api, get, {"channel": ch}) for a, (get, _, _) in ACTIONS.items()}
    return build_matrix(values, await _send(api, "GetAiCfg", {"channel": ch}))


def _device(hass: HomeAssistant, camera_id: str) -> dr.DeviceEntry:
    dev = dr.async_get(hass).async_get(camera_id)
    if dev is None:
        raise DetectionError("not_found", "Kamera unbekannt")
    return dev


async def async_get(hass: HomeAssistant, camera_id: str) -> dict[str, Any]:
    dev = _device(hass, camera_id)
    return await _read(_api(hass, dev), channel_of(dev.identifiers))


async def async_set(hass: HomeAssistant, camera_id: str, action: str, type_: str, enable: bool) -> dict[str, Any]:
    dev = _device(hass, camera_id)
    api = _api(hass, dev)
    ch = channel_of(dev.identifiers)
    if action == "tracking":
        if type_ not in TRACK_TYPES:
            raise DetectionError("invalid", f"Tracking nicht für '{type_}'")
        cmd, param = "SetAiCfg", {"channel": ch, "AiDetectType": {type_: int(enable)}}
    else:
        _, cmd, key = ACTIONS[action]
        param = {key: {"schedule": {"channel": ch, "table": {TYPE_KEYS[type_]: build_table(enable)}}}}
    if await _send(api, cmd, param) is None:
        raise DetectionError("camera_error", f"{cmd} von der Kamera abgelehnt")
    return await _read(api, ch)
