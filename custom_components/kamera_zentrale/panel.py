"""Seitenleisten-Panel „Kameras“ (Web-Component ohne Build-Schritt)."""
from __future__ import annotations

import json
import logging
from pathlib import Path

from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

PANEL_URL_PATH = "kameras"
STATIC_URL = f"/{DOMAIN}_static"
WEBCOMPONENT = "kamera-zentrale-panel"
_STATIC_FLAG = f"{DOMAIN}_static_registered"


def _version() -> str:
    manifest = json.loads((Path(__file__).parent / "manifest.json").read_text(encoding="utf-8"))
    return manifest["version"]


async def async_register_panel(hass: HomeAssistant) -> bool:
    if not hass.data.get(_STATIC_FLAG):
        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL, str(Path(__file__).parent / "www"), cache_headers=False)]
        )
        hass.data[_STATIC_FLAG] = True
    if "frontend" not in hass.config.components:
        _LOGGER.warning("Frontend nicht geladen – Kamera-Panel wird nicht angezeigt")
        return False
    from homeassistant.components import panel_custom

    version = await hass.async_add_executor_job(_version)
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=WEBCOMPONENT,
        sidebar_title="Kameras",
        sidebar_icon="mdi:cctv",
        module_url=f"{STATIC_URL}/{WEBCOMPONENT}.js?v={version}",
        require_admin=False,
        config={},
    )
    return True


def async_remove_panel(hass: HomeAssistant) -> None:
    if "frontend" not in hass.config.components:
        return
    from homeassistant.components import frontend

    frontend.async_remove_panel(hass, PANEL_URL_PATH, warn_if_unknown=False)
