"""WebSocket-API (Lesen; Schreiben nur bei detection/set, Rest über HA-Dienste).

  kamera_zentrale/cameras/list
  kamera_zentrale/clips/list {camera_id}
  kamera_zentrale/detection/get {camera_id}
  kamera_zentrale/detection/set {camera_id, action, type, enable}  (nur Admin; schreibt an die Kamera)
"""
from __future__ import annotations

import logging

import voluptuous as vol
from aiohttp import ClientError
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from . import cameras, clips, detection
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)


@callback
def async_register(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, ws_cameras_list)
    websocket_api.async_register_command(hass, ws_clips_list)
    websocket_api.async_register_command(hass, ws_detection_get)
    websocket_api.async_register_command(hass, ws_detection_set)


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/cameras/list"})
@callback
def ws_cameras_list(hass, connection, msg):
    connection.send_result(msg["id"], {"cameras": cameras.async_collect(hass)})


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/clips/list", vol.Required("camera_id"): str})
@websocket_api.async_response
async def ws_clips_list(hass, connection, msg):
    dev = dr.async_get(hass).async_get(msg["camera_id"])
    if dev is None:
        connection.send_error(msg["id"], "not_found", "Kamera unbekannt")
        return
    folder = dev.name_by_user or dev.name or ""
    try:
        found = await clips.list_clips(async_get_clientsession(hass), clips.base_url(hass), folder)
    except ValueError:
        connection.send_result(msg["id"], {"folder": folder, "clips": []})
        return
    except (ClientError, TimeoutError) as err:
        connection.send_error(msg["id"], "unavailable", f"Clip-Ablage nicht erreichbar: {err}")
        return
    connection.send_result(msg["id"], {"folder": folder, "clips": found})


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/detection/get", vol.Required("camera_id"): str})
@websocket_api.async_response
async def ws_detection_get(hass, connection, msg):
    try:
        connection.send_result(msg["id"], await detection.async_get(hass, msg["camera_id"]))
    except detection.DetectionError as err:
        connection.send_error(msg["id"], err.code, err.message)


@websocket_api.require_admin
@websocket_api.websocket_command({
    vol.Required("type"): f"{DOMAIN}/detection/set",
    vol.Required("camera_id"): str,
    vol.Required("action"): vol.In([*detection.ACTIONS, "tracking"]),
    vol.Required("detect_type"): vol.In(detection.TYPES),
    vol.Required("enable"): bool,
})
@websocket_api.async_response
async def ws_detection_set(hass, connection, msg):
    try:
        res = await detection.async_set(hass, msg["camera_id"], msg["action"], msg["detect_type"], msg["enable"])
    except detection.DetectionError as err:
        connection.send_error(msg["id"], err.code, err.message)
        return
    connection.send_result(msg["id"], res)
