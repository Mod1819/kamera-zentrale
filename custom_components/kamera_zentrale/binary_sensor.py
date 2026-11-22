"""Sensor „Clip-Auslöser“: AN, solange ein Erkennungssensor der Kamera an ist, dessen Typ in der FTP-Spalte aktiv ist.

Dadurch passt eine Push-Automation automatisch zur FTP-Einstellung (kein Push ohne Clip).
"""
from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import CoreState, Event, HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_track_state_change_event, async_track_time_interval
from homeassistant.util import dt as dt_util

from . import detection
from .const import DOMAIN, REOLINK_DOMAIN, SIGNAL_MATRIX

_LOGGER = logging.getLogger(__name__)

REFRESH_INTERVAL = timedelta(minutes=10)
TYPE_LABELS = {"people": "Person", "vehicle": "Fahrzeug", "dog_cat": "Tier", "md": "Bewegung"}
# Typ -> Reolink-translation_key des binary_sensor (Fallback: Endung der entity_id)
SOURCE_KEYS: dict[str, tuple[str, ...]] = {
    "people": ("person",), "vehicle": ("vehicle",), "dog_cat": ("pet", "animal", "dog_cat"), "md": ("motion",),
}
FALLBACK_TYPES = [t for t in detection.TYPES if t != "md"]  # ohne gelesene Matrix


def source_map(entries: list[er.RegistryEntry]) -> dict[str, str]:
    """Reolink-Registry-Einträge eines Geräts -> {entity_id: Typ} (nur binary_sensor, nicht deaktiviert)."""
    res: dict[str, str] = {}
    for ent in entries:
        if ent.platform != REOLINK_DOMAIN or ent.domain != "binary_sensor" or ent.disabled_by is not None:
            continue
        tail = ent.entity_id.split(".", 1)[1]
        # Reolink-Bewegungssensor hat keinen translation_key (Name kommt aus device_class motion)
        if ent.translation_key is None and (getattr(ent, "original_device_class", None) or getattr(ent, "device_class", None)) == "motion":
            res[ent.entity_id] = "md"
            continue
        for t, keys in SOURCE_KEYS.items():
            if ent.translation_key in keys or (
                ent.translation_key not in {k for ks in SOURCE_KEYS.values() for k in ks}
                and any(tail.endswith("_" + k) for k in keys)
            ):
                res[ent.entity_id] = t
                break
    return res


def _sources(hass: HomeAssistant, device_id: str) -> dict[str, str]:
    return source_map(er.async_entries_for_device(er.async_get(hass), device_id))


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    known: set[str] = set()

    @callback
    def add_missing(_now=None) -> None:
        new = []
        reolink = {e.entry_id for e in hass.config_entries.async_entries(REOLINK_DOMAIN)}
        for dev in dr.async_get(hass).devices.values():
            if dev.id in known or not reolink.intersection(set(dev.config_entries)):
                continue
            if _sources(hass, dev.id):  # nur Geräte mit Erkennungssensoren (Kameras)
                known.add(dev.id)
                new.append(ClipTrigger(dev))
        if new:
            async_add_entities(new)

    add_missing()
    entry.async_on_unload(async_track_time_interval(hass, add_missing, REFRESH_INTERVAL))


class ClipTrigger(BinarySensorEntity):
    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_translation_key = "clip_trigger"
    _attr_device_class = BinarySensorDeviceClass.MOTION

    def __init__(self, device: dr.DeviceEntry) -> None:
        self._device_id = device.id
        self._attr_unique_id = f"{DOMAIN}_{device.id}_clip_trigger"
        self._attr_device_info = DeviceInfo(identifiers=set(device.identifiers))
        self._enabled: list[str] = list(FALLBACK_TYPES)
        self._updated: str | None = None
        self._sources: dict[str, str] = {}
        self._type: str | None = None
        self._source: str | None = None
        self._unsub_states = None
        self._attr_is_on = False

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(async_dispatcher_connect(self.hass, SIGNAL_MATRIX, self._on_signal))
        self.async_on_remove(async_track_time_interval(self.hass, self._refresh, REFRESH_INTERVAL))
        self.async_on_remove(self._unsubscribe)
        self._resubscribe()
        self._evaluate()
        # Matrix nach HA-Start lesen (Kamera muss erreichbar sein), ohne das Hinzufügen zu blockieren
        if self.hass.state is CoreState.running:
            self.hass.async_create_task(self._refresh())
        else:
            from homeassistant.helpers.start import async_at_started
            self.async_on_remove(async_at_started(self.hass, self._refresh))

    # ---- Matrix ----
    async def _refresh(self, _now=None) -> None:
        self._resubscribe()
        try:
            matrix = await detection.async_get(self.hass, self._device_id)
        except detection.DetectionError as err:
            _LOGGER.debug("Matrix nicht lesbar (%s), behalte letzte", err.message)
            self._evaluate()
            self.async_write_ha_state()
            return
        self._apply(matrix)

    @callback
    def _on_signal(self, camera_id: str, matrix: dict[str, Any]) -> None:
        if camera_id == self._device_id:
            self._apply(matrix)

    @callback
    def _apply(self, matrix: dict[str, Any]) -> None:
        ftp = (matrix.get("actions") or {}).get("ftp")
        if ftp is None:  # FTP-Befehl fehlgeschlagen -> alte Matrix behalten
            return
        self._enabled = [t for t in detection.TYPES if ftp.get(t)]
        self._updated = dt_util.utcnow().isoformat()
        self._evaluate()
        self.async_write_ha_state()

    # ---- Quellsensoren ----
    @callback
    def _resubscribe(self) -> None:
        sources = _sources(self.hass, self._device_id)
        if sources == self._sources and self._unsub_states:
            return
        self._unsubscribe()
        self._sources = sources
        if sources:
            self._unsub_states = async_track_state_change_event(self.hass, list(sources), self._on_state)

    @callback
    def _unsubscribe(self) -> None:
        if self._unsub_states:
            self._unsub_states()
            self._unsub_states = None

    @callback
    def _on_state(self, event: Event) -> None:
        new = event.data.get("new_state")
        eid = event.data["entity_id"]
        if new is not None and new.state == "on" and self._sources.get(eid) in self._enabled:
            self._type, self._source = self._sources[eid], eid
        self._evaluate()
        self.async_write_ha_state()

    @callback
    def _evaluate(self) -> None:
        active = [
            (eid, t) for eid, t in self._sources.items()
            if t in self._enabled and (s := self.hass.states.get(eid)) is not None and s.state == "on"
        ]
        self._attr_is_on = bool(active)
        if active and (self._source, self._type) not in [(e, t) for e, t in active]:
            self._source, self._type = active[0]

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {
            "type": self._type,
            "type_label": TYPE_LABELS.get(self._type),
            "enabled_types": self._enabled,
            "source_entity": self._source,
            "matrix_updated": self._updated,
        }
