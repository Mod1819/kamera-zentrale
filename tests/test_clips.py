"""clips: Parser, Sortierung, Validierung, Durchreichen (Range)."""
import pytest
from homeassistant.components.http import HomeAssistantView  # noqa: F401
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMockResponse

from custom_components.kamera_zentrale import clips
from custom_components.kamera_zentrale.const import CONF_CLIP_BASE_URL, DOMAIN

HTML = '''<html><body><a href="../">../</a>
<a href="event_20261101100000.mp4">event_20261101100000.mp4</a>  01-Nov-2026 10:00  5M
<a href="event_20261102080000.mp4">event_20261102080000.mp4</a>
<a href="event_20261301000000.mp4">kaputt</a>
<a href="other.mp4">other.mp4</a><a href="event_20261102080000.mp4">dup</a></body></html>'''


def test_parse_sorted_newest_first():
    assert clips.parse_autoindex(HTML) == [
        {"filename": "event_20261102080000.mp4", "time": "2026-11-02T08:00:00"},
        {"filename": "event_20261101100000.mp4", "time": "2026-11-01T10:00:00"}]


def test_parse_max_200():
    html = "".join(f'<a href="event_20260101{i // 60:02d}{i % 60:02d}00.mp4"></a>' for i in range(250))
    assert len(clips.parse_autoindex(html)) == 200


@pytest.mark.parametrize("name,ok", [("event_20261102080000.mp4", True), ("latest.mp4", True),
                                      ("../event_20261102080000.mp4", False), ("event_1.mp4", False),
                                      ("event_20261102080000.mp4/x", False), ("a.mp4", False)])
def test_valid_filename(name, ok):
    assert clips.valid_filename(name) is ok


@pytest.mark.parametrize("f,ok", [("Garten", True), ("a-b_1", True), ("..", False), ("a/b", False),
                                   ("", False), ("a b", False), ("%2e%2e", False)])
def test_valid_folder(f, ok):
    assert clips.valid_folder(f) is ok


async def test_list_clips_rejects_traversal():
    with pytest.raises(ValueError):
        await clips.list_clips(None, "http://x", "../etc")


@pytest.fixture
async def nginx(hass, hass_client, aioclient_mock):  # noqa: D103
    base = "http://192.0.2.1:8080"
    seen = {}

    async def video(method, url, data):
        seen["range"] = (aioclient_mock.mock_calls[-1][3] or {}).get("Range")
        if seen["range"]:
            return AiohttpClientMockResponse(method, url, status=206, response=b"34",
                                             headers={"Content-Range": "bytes 3-4/10"})
        return AiohttpClientMockResponse(method, url, response=b"0123456789")

    aioclient_mock.get(f"{base}/Garten/events/event_20261102080000.mp4", side_effect=video)
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_CLIP_BASE_URL: base})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return seen, await hass_client()


async def test_view_streams_and_forwards_range(nginx):
    seen, client = nginx
    r = await client.get("/api/kamera_zentrale/clip/Garten/event_20261102080000.mp4")
    assert r.status == 200 and await r.read() == b"0123456789"
    assert r.headers["Content-Type"] == "video/mp4" and r.headers["Accept-Ranges"] == "bytes"
    r = await client.get("/api/kamera_zentrale/clip/Garten/event_20261102080000.mp4", headers={"Range": "bytes=3-4"})
    assert r.status == 206 and r.headers["Content-Range"] == "bytes 3-4/10" and await r.read() == b"34"
    assert seen["range"] == "bytes=3-4"


async def test_view_rejects_bad_names_and_unauth(nginx, hass_client_no_auth):
    _, client = nginx
    assert (await client.get("/api/kamera_zentrale/clip/Garten/evil.mp4")).status == 400
    assert (await client.get("/api/kamera_zentrale/clip/a%20b/latest.mp4")).status == 400
    anon = await hass_client_no_auth()
    assert (await anon.get("/api/kamera_zentrale/clip/Garten/event_20261102080000.mp4")).status == 401
