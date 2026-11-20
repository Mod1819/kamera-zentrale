"""Clip-Ablage (nginx-autoindex): Auflisten und authentifiziertes Durchreichen."""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from aiohttp import ClientError, ClientSession, ClientTimeout, web
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import CONF_CLIP_BASE_URL, DEFAULT_CLIP_BASE_URL, DOMAIN

MAX_CLIPS = 200
FOLDER_RE = re.compile(r"^[A-Za-z0-9_-]+$")
FILE_RE = re.compile(r"^(?:event_\d{14}\.mp4|latest\.mp4)$")
_EVENT_HREF = re.compile(r'href="(event_(\d{14})\.mp4)"')
_PASS_HEADERS = ("Content-Range", "Accept-Ranges", "Content-Length")


def valid_folder(folder: str) -> bool:
    return bool(FOLDER_RE.fullmatch(folder))


def valid_filename(name: str) -> bool:
    return bool(FILE_RE.fullmatch(name))


def parse_autoindex(html: str) -> list[dict[str, str]]:
    """Clips aus nginx-autoindex-HTML, neueste zuerst, max. 200 (Zeit = lokale Zeit aus dem Dateinamen)."""
    clips = {}
    for name, stamp in _EVENT_HREF.findall(html):
        try:
            ts = datetime.strptime(stamp, "%Y%m%d%H%M%S")
        except ValueError:
            continue  # kaputter Zeitstempel (z. B. Monat 13)
        clips[name] = ts.isoformat()
    ordered = sorted(clips.items(), key=lambda kv: kv[0], reverse=True)[:MAX_CLIPS]
    return [{"filename": n, "time": t} for n, t in ordered]


def base_url(hass: HomeAssistant) -> str:
    entries = hass.config_entries.async_entries(DOMAIN)
    if not entries:
        return DEFAULT_CLIP_BASE_URL
    e = entries[0]
    return e.options.get(CONF_CLIP_BASE_URL, e.data.get(CONF_CLIP_BASE_URL, DEFAULT_CLIP_BASE_URL))


async def list_clips(session: ClientSession, base: str, folder: str) -> list[dict[str, str]]:
    """Clips eines Kamera-Ordners. Wirft ValueError (Ordnername) oder ClientError/TimeoutError."""
    if not valid_folder(folder):
        raise ValueError("Ungültiger Ordnername")
    async with session.get(f"{base}/{folder}/events/", timeout=ClientTimeout(total=10)) as resp:
        if resp.status == 404:
            return []
        resp.raise_for_status()
        return parse_autoindex(await resp.text())


class ClipView(HomeAssistantView):
    """Streamt Clips vom nginx durch (Range-fähig); Zugriff nur angemeldet/signiert."""

    url = "/api/kamera_zentrale/clip/{folder}/{filename}"
    name = "api:kamera_zentrale:clip"
    requires_auth = True

    async def get(self, request: web.Request, folder: str, filename: str) -> web.StreamResponse:
        if not valid_folder(folder) or not valid_filename(filename):
            return web.Response(status=400)
        hass: HomeAssistant = request.app["hass"]
        headers = {"Range": request.headers["Range"]} if "Range" in request.headers else {}
        session = async_get_clientsession(hass)
        try:
            # ponytail: latest.mp4 liegt (Annahme) direkt im Kameraordner, Events unter events/
            sub = "" if filename == "latest.mp4" else "events/"
            upstream = await session.get(f"{base_url(hass)}/{folder}/{sub}{filename}", headers=headers)
        except (ClientError, TimeoutError):
            return web.Response(status=502)
        async with upstream:
            if upstream.status not in (200, 206):
                return web.Response(status=upstream.status if upstream.status == 404 else 502)
            resp = web.StreamResponse(status=upstream.status)
            resp.content_type = "video/mp4"
            resp.headers["Accept-Ranges"] = "bytes"
            for h in _PASS_HEADERS:
                if h in upstream.headers:
                    resp.headers[h] = upstream.headers[h]
            await resp.prepare(request)
            async for chunk in upstream.content.iter_chunked(64 * 1024):
                await resp.write(chunk)
            await resp.write_eof()
            return resp
