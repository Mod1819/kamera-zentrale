"""Setup/Unload, Config-Flow, Optionen, Panel, Websocket (gemockte Registries)."""
from unittest.mock import AsyncMock, patch

from homeassistant import config_entries
from homeassistant.config_entries import ConfigEntryState
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.kamera_zentrale.const import CONF_CLIP_BASE_URL, DEFAULT_CLIP_BASE_URL, DOMAIN


async def _setup(hass, frontend=True):
    if frontend:
        hass.config.components.add("frontend")
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_CLIP_BASE_URL: DEFAULT_CLIP_BASE_URL})
    entry.add_to_hass(hass)
    with patch("homeassistant.components.panel_custom.async_register_panel", new=AsyncMock()) as reg:
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
    return entry, reg


async def test_config_flow_default_and_single_instance(hass):
    r = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert r["type"] is FlowResultType.FORM
    assert r["data_schema"]({})[CONF_CLIP_BASE_URL] == DEFAULT_CLIP_BASE_URL
    r = await hass.config_entries.flow.async_configure(r["flow_id"], {CONF_CLIP_BASE_URL: "http://nas:1/ "})
    assert r["type"] is FlowResultType.CREATE_ENTRY and r["data"] == {CONF_CLIP_BASE_URL: "http://nas:1"}
    await hass.async_block_till_done()
    r = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert r["type"] is FlowResultType.ABORT


async def test_options_flow(hass):
    entry, _ = await _setup(hass)
    r = await hass.config_entries.options.async_init(entry.entry_id)
    assert r["type"] is FlowResultType.FORM
    r = await hass.config_entries.options.async_configure(r["flow_id"], {CONF_CLIP_BASE_URL: "http://neu:9/"})
    assert r["type"] is FlowResultType.CREATE_ENTRY and r["data"] == {CONF_CLIP_BASE_URL: "http://neu:9"}


async def test_setup_unload_and_panel(hass):
    entry, reg = await _setup(hass)
    assert entry.state is ConfigEntryState.LOADED
    kw = reg.await_args.kwargs
    assert kw["frontend_url_path"] == "kameras" and kw["require_admin"] is False
    assert kw["sidebar_icon"] == "mdi:cctv" and kw["sidebar_title"] == "Kameras"
    assert kw["webcomponent_name"] == "kamera-zentrale-panel"
    with patch("homeassistant.components.frontend.async_remove_panel") as rm:
        assert await hass.config_entries.async_unload(entry.entry_id)
    rm.assert_called_once()
    assert entry.state is ConfigEntryState.NOT_LOADED


async def test_without_frontend_no_panel(hass):
    entry, reg = await _setup(hass, frontend=False)
    reg.assert_not_awaited()
    assert entry.state is ConfigEntryState.LOADED


async def test_static_js_served(hass, hass_client):
    await _setup(hass)
    r = await (await hass_client()).get("/kamera_zentrale_static/kamera-zentrale-panel.js")
    assert r.status == 200 and 'customElements.define("kamera-zentrale-panel"' in await r.text()


async def test_websocket_cameras_list(hass, hass_ws_client):
    await _setup(hass)
    rl = MockConfigEntry(domain="reolink", data={})
    rl.add_to_hass(hass)
    other = MockConfigEntry(domain="other", data={})
    other.add_to_hass(hass)
    dreg, ereg = dr.async_get(hass), er.async_get(hass)
    d = dreg.async_get_or_create(config_entry_id=rl.entry_id, identifiers={("reolink", "1")}, name="Garten",
                                 model="E1", sw_version="v1")
    dreg.async_get_or_create(config_entry_id=other.entry_id, identifiers={("other", "1")}, name="Fremd")
    ereg.async_get_or_create("camera", "reolink", "c1", device_id=d.id, config_entry=rl, suggested_object_id="garten")
    ereg.async_get_or_create("switch", "reolink", "s1", device_id=d.id, config_entry=rl,
                             translation_key="ir_lights", suggested_object_id="garten_ir")
    ereg.async_get_or_create("switch", "reolink", "s2", device_id=d.id, config_entry=rl,
                             translation_key="ftp_upload", disabled_by=er.RegistryEntryDisabler.USER)
    ws = await hass_ws_client(hass)
    await ws.send_json({"id": 1, "type": f"{DOMAIN}/cameras/list"})
    res = (await ws.receive_json())["result"]["cameras"]
    assert [c["name"] for c in res] == ["Garten"] and res[0]["id"] == d.id
    assert {g["key"]: [e["entity_id"] for e in g["entities"]] for g in res[0]["groups"]} == {
        "live": ["camera.garten"], "licht": ["switch.garten_ir"]}


async def test_websocket_clips_list(hass, hass_ws_client):
    await _setup(hass)
    rl = MockConfigEntry(domain="reolink", data={})
    rl.add_to_hass(hass)
    dreg = dr.async_get(hass)
    d = dreg.async_get_or_create(config_entry_id=rl.entry_id, identifiers={("reolink", "1")}, name="Garten")
    bad = dreg.async_get_or_create(config_entry_id=rl.entry_id, identifiers={("reolink", "2")}, name="Vor dem Haus")
    ws = await hass_ws_client(hass)

    async def call(i, **kw):
        await ws.send_json({"id": i, "type": f"{DOMAIN}/clips/list", **kw})
        return await ws.receive_json()

    with patch("custom_components.kamera_zentrale.clips.list_clips",
               AsyncMock(return_value=[{"filename": "event_20261102080000.mp4", "time": "2026-11-02T08:00:00"}])) as lc:
        r = await call(1, camera_id=d.id)
    assert r["result"]["folder"] == "Garten" and len(r["result"]["clips"]) == 1
    assert lc.await_args.args[1:] == (DEFAULT_CLIP_BASE_URL, "Garten")
    assert (await call(2, camera_id="nix"))["error"]["code"] == "not_found"
    r = await call(3, camera_id=bad.id)  # ungültiger Ordnername -> leere Liste, kein Netzwerk
    assert r["result"]["clips"] == []
