"""Reolink-Kameras aus den HA-Registries einsammeln und in Gruppen einordnen.

`group_cameras` ist reine Logik (Listen von Dicts rein, Dicts raus) und ohne hass testbar.
`async_collect` liest nur die Registries und ruft `group_cameras` auf.
"""
from __future__ import annotations

from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er

from .const import REOLINK_DOMAIN

# Reihenfolge = Ausgabe-Reihenfolge und Priorität bei mehreren Treffern.
GROUPS: tuple[str, ...] = ("live", "licht", "erkennung", "aufnahme", "ptz", "audio", "system", "sonstiges")

# Schlüsselwörter (Teilstring-Treffer auf translation_key bzw. entity_id-Objektname).
KEYWORDS: dict[str, tuple[str, ...]] = {
    "licht": ("ir_lights", "floodlight", "spotlight", "status_led"),
    "erkennung": ("clip_trigger", "sensitivity", "ai_", "delay", "motion", "person", "vehicle", "pet", "animal", "visitor"),
    "aufnahme": ("record", "ftp", "push", "email"),
    "ptz": ("ptz", "auto_track", "preset", "zoom", "focus", "guard", "pan", "tilt"),
    "audio": ("siren", "volume", "audio", "alarm"),
    "system": ("restart", "update", "wifi", "storage", "hdd", "reboot"),
}
# Domain-Vorrang vor den Schlüsselwörtern.
DOMAIN_GROUP = {"camera": "live", "light": "licht", "update": "system"}


def classify(entity: dict[str, Any]) -> str:
    """Gruppe einer Entität bestimmen (Domain > translation_key > entity_id)."""
    if grp := DOMAIN_GROUP.get(entity.get("domain", "")):
        return grp
    key = (entity.get("translation_key") or entity["entity_id"].split(".", 1)[-1]).lower()
    for grp, words in KEYWORDS.items():
        if any(w in key for w in words):
            return grp
    return "sonstiges"


def group_cameras(devices: list[dict[str, Any]], entities: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Geräte + Entitäten -> [{id,name,model,sw_version,groups:[{key,entities:[...]}]}], nach Name sortiert."""
    by_device: dict[str, list[dict[str, Any]]] = {}
    for ent in entities:
        if ent.get("disabled"):
            continue
        by_device.setdefault(ent["device_id"], []).append(ent)

    result = []
    for dev in devices:
        buckets: dict[str, list[dict[str, Any]]] = {g: [] for g in GROUPS}
        for ent in sorted(by_device.get(dev["id"], []), key=lambda e: e["entity_id"]):
            buckets[classify(ent)].append({
                k: ent.get(k) for k in ("entity_id", "domain", "translation_key", "name")
            })
        result.append({
            "id": dev["id"],
            "name": dev["name"],
            "model": dev.get("model"),
            "sw_version": dev.get("sw_version"),
            "groups": [{"key": g, "entities": buckets[g]} for g in GROUPS if buckets[g]],
        })
    return sorted(result, key=lambda d: d["name"].lower())


def async_collect(hass: HomeAssistant) -> list[dict[str, Any]]:
    """Alle Geräte der Reolink-Config-Entries samt Entitäten aus den Registries."""
    dev_reg = dr.async_get(hass)
    ent_reg = er.async_get(hass)
    entry_ids = {e.entry_id for e in hass.config_entries.async_entries(REOLINK_DOMAIN)}
    devices, entities = [], []
    for dev in dev_reg.devices.values():
        if not entry_ids.intersection(({getattr(dev, 'config_entry_id', None)} - {None}) or set(dev.config_entries)):
            continue
        devices.append({
            "id": dev.id, "name": dev.name_by_user or dev.name or dev.id,
            "model": dev.model, "sw_version": dev.sw_version,
        })
        for ent in er.async_entries_for_device(ent_reg, dev.id, include_disabled_entities=True):
            entities.append({
                "device_id": dev.id, "entity_id": ent.entity_id, "domain": ent.domain,
                "translation_key": ent.translation_key, "name": ent.name or ent.original_name,
                "disabled": ent.disabled_by is not None,
            })
    return group_cameras(devices, entities)
