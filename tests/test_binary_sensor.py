"""Clip-Auslöser: Mapping, Matrix-Logik, Fallback, Fehler, Dispatcher, Unload."""
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from homeassistant.config_entries import ConfigEntryState
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_fire_time_changed

from custom_components.kamera_zentrale import binary_sensor as bs
from custom_components.kamera_zentrale import detection
from custom_components.kamera_zentrale.const import SIGNAL_MATRIX
from tests.test_init import _setup

GET = "custom_components.kamera_zentrale.detection.async_get"


def matrix(**ftp):
    return {"types": list(ftp), "actions": {"ftp": ftp}, "tracking": None}


def reg(platform="reolink", domain="binary_sensor", key=None, eid="binary_sensor.x", disabled=None):
    return SimpleNamespace(platform=platform, domain=domain, translation_key=key, entity_id=eid, disabled_by=disabled)


def test_source_map():
    m = bs.source_map([
        reg(key="person", eid="binary_sensor.g_p"), reg(key="vehicle", eid="binary_sensor.g_v"),
        reg(key="pet", eid="binary_sensor.g_t"), reg(key="animal", eid="binary_sensor.g_a"),
        reg(key="motion", eid="binary_sensor.g_m"),
        reg(key=None, eid="binary_sensor.g_person"),            # Fallback entity_id-Endung
        reg(key="other", eid="binary_sensor.g_motion"),          # fremder Key + Endung -> kein Treffer? (key bekannt? nein)
        reg(platform="x", key="person", eid="binary_sensor.fremd"),
        reg(domain="switch", key="person", eid="switch.s"),
        reg(key="person", eid="binary_sensor.off", disabled="user"),
    ])
    assert m["binary_sensor.g_p"] == "people" and m["binary_sensor.g_v"] == "vehicle"
    assert m["binary_sensor.g_t"] == m["binary_sensor.g_a"] == "dog_cat" and m["binary_sensor.g_m"] == "md"
    assert m["binary_sensor.g_person"] == "people"
    assert "binary_sensor.fremd" not in m and "switch.s" not in m and "binary_sensor.off" not in m


async def _env(hass, ftp=None, fail=False):
    hass.config.components.add("frontend")
    rl = MockConfigEntry(domain="reolink", data={})
    rl.add_to_hass(hass)
    dev = dr.async_get(hass).async_get_or_create(config_entry_id=rl.entry_id, identifiers={("reolink", "1_ch0")}, name="Garten")
    ereg = er.async_get(hass)
    for key in ("person", "vehicle", "pet", "motion"):
        ereg.async_get_or_create("binary_sensor", "reolink", key, device_id=dev.id, config_entry=rl,
                                 translation_key=key, suggested_object_id=f"garten_{key}")
    ereg.async_get_or_create("binary_sensor", "reolink", "nur-fremd", device_id=None, config_entry=rl)
    mock = AsyncMock(side_effect=detection.DetectionError("camera_error", "x")) if fail else AsyncMock(return_value=matrix(**(ftp or {})))
    with patch(GET, mock):
        entry, _ = await _setup(hass, frontend=False)
        await hass.async_block_till_done()
    return dev, entry, mock


def st(hass):
    return hass.states.get("binary_sensor.garten_clip_trigger")


async def test_entity_id_unique_id_device_attrs(hass):
    dev, entry, _ = await _env(hass, dict(people=True, vehicle=False, dog_cat=False, md=False))
    e = er.async_get(hass).async_get("binary_sensor.garten_clip_trigger")
    assert e.unique_id == f"kamera_zentrale_{dev.id}_clip_trigger" and e.device_id == dev.id
    s = st(hass)
    assert s.state == "off" and s.attributes["device_class"] == "motion"
    assert s.attributes["enabled_types"] == ["people"] and s.attributes["matrix_updated"] is not None
    assert s.attributes["type"] is None


async def test_state_follows_matrix_and_attributes(hass):
    _, _, _ = await _env(hass, dict(people=True, vehicle=False, dog_cat=False, md=False))
    hass.states.async_set("binary_sensor.garten_vehicle", "on")
    await hass.async_block_till_done()
    assert st(hass).state == "off"  # Fahrzeug nicht in FTP
    hass.states.async_set("binary_sensor.garten_person", "on")
    await hass.async_block_till_done()
    s = st(hass)
    assert s.state == "on" and s.attributes["type"] == "people" and s.attributes["type_label"] == "Person"
    assert s.attributes["source_entity"] == "binary_sensor.garten_person"
    hass.states.async_set("binary_sensor.garten_person", "off")
    await hass.async_block_till_done()
    s = st(hass)
    assert s.state == "off" and s.attributes["type"] == "people"  # zuletzt auslösender Typ bleibt


async def test_matrix_change_via_dispatcher(hass):
    dev, _, _ = await _env(hass, dict(people=False, vehicle=False, dog_cat=False, md=False))
    hass.states.async_set("binary_sensor.garten_pet", "on")
    await hass.async_block_till_done()
    assert st(hass).state == "off"
    async_dispatcher_send(hass, SIGNAL_MATRIX, dev.id, matrix(people=False, vehicle=False, dog_cat=True, md=False))
    await hass.async_block_till_done()
    s = st(hass)
    assert s.state == "on" and s.attributes["type"] == "dog_cat" and s.attributes["type_label"] == "Tier"
    async_dispatcher_send(hass, SIGNAL_MATRIX, "andere", matrix(dog_cat=False))  # fremde Kamera ignoriert
    await hass.async_block_till_done()
    assert st(hass).state == "on"
    async_dispatcher_send(hass, SIGNAL_MATRIX, dev.id, matrix(dog_cat=False))
    await hass.async_block_till_done()
    assert st(hass).state == "off"


async def test_detection_set_dispatches(hass):
    dev, _, _ = await _env(hass, dict(people=False, vehicle=False, dog_cat=False, md=False))
    hass.states.async_set("binary_sensor.garten_person", "on")
    await hass.async_block_till_done()
    assert st(hass).state == "off"
    api = SimpleNamespace(send=AsyncMock())
    new = matrix(people=True, vehicle=False, dog_cat=False, md=False)
    with patch.object(detection, "_api", return_value=api), patch.object(detection, "_send", AsyncMock(return_value={"x": 1})), \
            patch.object(detection, "_read", AsyncMock(return_value=new)):
        await detection.async_set(hass, dev.id, "ftp", "people", True)
        await hass.async_block_till_done()
    assert st(hass).state == "on"


async def test_fallback_without_matrix(hass):
    await _env(hass, fail=True)
    s = st(hass)
    assert s.state != "unavailable" and s.attributes["matrix_updated"] is None
    assert s.attributes["enabled_types"] == ["people", "vehicle", "dog_cat"]
    hass.states.async_set("binary_sensor.garten_motion", "on")
    await hass.async_block_till_done()
    assert st(hass).state == "off"  # md zählt im Fallback nicht
    hass.states.async_set("binary_sensor.garten_vehicle", "on")
    await hass.async_block_till_done()
    assert st(hass).state == "on"


async def test_camera_error_keeps_last_matrix(hass):
    await _env(hass, dict(people=True, vehicle=False, dog_cat=False, md=False))
    stamp = st(hass).attributes["matrix_updated"]
    err = AsyncMock(side_effect=detection.DetectionError("camera_error", "weg"))
    with patch(GET, err):
        async_fire_time_changed(hass, dt_util.utcnow() + timedelta(minutes=11))
        await hass.async_block_till_done()
    s = st(hass)
    assert err.await_count == 1  # 10-min-Lauf hat gelesen
    assert s.attributes["enabled_types"] == ["people"] and s.attributes["matrix_updated"] == stamp
    ok = AsyncMock(return_value=matrix(people=False, vehicle=True, dog_cat=False, md=False))
    with patch(GET, ok):
        async_fire_time_changed(hass, dt_util.utcnow() + timedelta(minutes=22))
        await hass.async_block_till_done()
    assert st(hass).attributes["enabled_types"] == ["vehicle"]


async def test_unload(hass):
    _, entry, _ = await _env(hass, dict(people=True))
    assert st(hass).state == "off"
    with patch("homeassistant.components.frontend.async_remove_panel"):
        assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.NOT_LOADED and st(hass).state == "unavailable"


def test_source_map_motion_ohne_translation_key():
    """Reolink-Bewegungssensor: kein translation_key, device_class motion, deutsche entity_id."""
    from types import SimpleNamespace
    from custom_components.kamera_zentrale.binary_sensor import source_map
    ents = [
        SimpleNamespace(platform="reolink", domain="binary_sensor", disabled_by=None, entity_id="binary_sensor.garten_bewegung",
                        translation_key=None, original_device_class="motion", device_class=None),
        SimpleNamespace(platform="reolink", domain="binary_sensor", disabled_by=None, entity_id="binary_sensor.garten_tier",
                        translation_key="animal", original_device_class=None, device_class=None),
    ]
    assert source_map(ents) == {"binary_sensor.garten_bewegung": "md", "binary_sensor.garten_tier": "dog_cat"}
