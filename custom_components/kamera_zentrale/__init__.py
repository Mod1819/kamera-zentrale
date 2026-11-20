"""Kamera-Zentrale – Panel für die Reolink-Kameras aus Home Assistant."""
from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from . import clips, panel, websocket
from .const import DOMAIN

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """WebSocket-Befehle und Clip-View einmalig registrieren."""
    websocket.async_register(hass)
    hass.http.register_view(clips.ClipView())
    return True


async def _async_reload(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Optionen geändert -> neu laden."""
    await hass.config_entries.async_reload(entry.entry_id)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    entry.async_on_unload(entry.add_update_listener(_async_reload))
    await panel.async_register_panel(hass)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    panel.async_remove_panel(hass)
    return True
