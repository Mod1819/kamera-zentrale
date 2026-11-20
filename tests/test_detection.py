"""detection: reine Funktionen + WebSocket get/set mit gemocktem reolink-Entry."""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from homeassistant.helpers import device_registry as dr
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.kamera_zentrale import detection as d
from custom_components.kamera_zentrale.const import DOMAIN


def test_table_helpers():
    assert d.table_enabled("0" * 168) is False
    assert d.table_enabled("0" * 100 + "1" + "0" * 67) is True
    assert d.build_table(True) == "1" * 168 and d.build_table(False) == "0" * 168


def test_channel_of():
    assert d.channel_of({("reolink", "ABC_ch3")}) == 3
    assert d.channel_of({("reolink", "ABC")}) == 0
    assert d.channel_of({("other", "X_ch2")}) == 0


def test_parse_and_matrix():
    val = {"Push": {"schedule": {"table": {"AI_PEOPLE": "1" * 168, "MD": "0" * 168, "TIMING": "1" * 168}}}}
    assert d.parse_action(val, "Push") == {"people": True, "md": False}
    assert d.parse_tracking({"AiDetectType": {"people": 1, "dog_cat": 0, "face": 1}}) == {"people": True, "dog_cat": False}
    m = d.build_matrix({"push": val, "rec": None}, None)
    assert m == {"types": ["people", "md"], "actions": {"push": {"people": True, "md": False}}, "tracking": None}


# ---- WebSocket ----

def _table(on):
    return {k: ("1" if on.get(t) else "0") * 168 for t, k in d.TYPE_KEYS.items()}


class FakeCam:
    """Minimale Kamera: hält Tabellen, antwortet wie reolink_aio.send."""

    def __init__(self):
        self.tables = {a: _table({"people": True}) for a in d.ACTIONS}
        self.track = {"people": 1, "vehicle": 0, "dog_cat": 1, "face": 0}
        self.fail = set()
        self.sent = []

    async def send(self, cmds, expected_response_type=None):
        c = cmds[0]
        self.sent.append(c)
        cmd, p = c["cmd"], c["param"]
        if cmd in self.fail:
            return [{"cmd": cmd, "code": 1, "error": {"detail": "not support"}}]
        for a, (get, set_, key) in d.ACTIONS.items():
            if cmd == get:
                return [{"cmd": cmd, "code": 0, "value": {key: {"schedule": {"table": self.tables[a]}}}}]
            if cmd == set_:
                self.tables[a].update(p[key]["schedule"]["table"])
                return [{"cmd": cmd, "code": 0, "value": {"rspCode": 200}}]
        if cmd == "GetAiCfg":
            return [{"cmd": cmd, "code": 0, "value": {"AiDetectType": self.track}}]
        if cmd == "SetAiCfg":
            self.track.update(p["AiDetectType"])
            return [{"cmd": cmd, "code": 0, "value": {"rspCode": 200}}]
        raise AssertionError(cmd)


@pytest.fixture
async def cam(hass, hass_ws_client):
    from tests.test_init import _setup

    await _setup(hass)
    rl = MockConfigEntry(domain="reolink", data={})
    rl.add_to_hass(hass)
    fake = FakeCam()
    fake.send = AsyncMock(side_effect=fake.send)
    rl.runtime_data = SimpleNamespace(host=SimpleNamespace(api=fake))
    dev = dr.async_get(hass).async_get_or_create(
        config_entry_id=rl.entry_id, identifiers={("reolink", "UID_ch2")}, name="Garten")
    return SimpleNamespace(dev=dev, api=fake, entry=rl, hass=hass, ws=await hass_ws_client(hass))


async def call(ws, i, kind, **kw):
    await ws.send_json({"id": i, "type": f"{DOMAIN}/detection/{kind}", **kw})
    return await ws.receive_json()


async def test_ws_get(cam):
    r = (await call(cam.ws, 1, "get", camera_id=cam.dev.id))["result"]
    assert r["types"] == ["people", "vehicle", "dog_cat", "md"]
    assert r["actions"]["push"] == {"people": True, "vehicle": False, "dog_cat": False, "md": False}
    assert set(r["actions"]) == {"push", "rec", "ftp", "email"}
    assert r["tracking"] == {"people": True, "vehicle": False, "dog_cat": True}  # ohne face
    assert all(c.args[0][0]["param"]["channel"] == 2 for c in cam.api.send.await_args_list)  # Kanal aus _ch2


async def test_ws_get_omits_failed_commands(cam):
    cam.api.send.side_effect = None
    fake = FakeCam()
    fake.fail = {"GetFtpV20", "GetAiCfg"}
    cam.api.send.side_effect = fake.send
    r = (await call(cam.ws, 1, "get", camera_id=cam.dev.id))["result"]
    assert set(r["actions"]) == {"push", "rec", "email"} and r["tracking"] is None


async def test_ws_set_action_and_tracking(cam):
    r = await call(cam.ws, 1, "set", camera_id=cam.dev.id, action="push", detect_type="vehicle", enable=True)
    assert r["result"]["actions"]["push"]["vehicle"] is True
    sent = [c for c in cam.api.send.await_args_list if c.args[0][0]["cmd"] == "SetPushV20"][0].args[0][0]
    assert sent["param"] == {"Push": {"schedule": {"channel": 2, "table": {"AI_VEHICLE": "1" * 168}}}}
    assert cam.api.send.await_args.kwargs == {"expected_response_type": "json"}
    r = await call(cam.ws, 2, "set", camera_id=cam.dev.id, action="push", detect_type="people", enable=False)
    assert r["result"]["actions"]["push"]["people"] is False
    r = await call(cam.ws, 3, "set", camera_id=cam.dev.id, action="tracking", detect_type="dog_cat", enable=False)
    assert r["result"]["tracking"]["dog_cat"] is False
    sent = [c for c in cam.api.send.await_args_list if c.args[0][0]["cmd"] == "SetAiCfg"][0].args[0][0]
    assert sent["param"] == {"channel": 2, "AiDetectType": {"dog_cat": 0}}


async def test_ws_set_validation_and_camera_error(cam):
    bad = await call(cam.ws, 1, "set", camera_id=cam.dev.id, action="nope", detect_type="md", enable=True)
    assert bad["success"] is False and bad["error"]["code"] == "invalid_format"
    r = await call(cam.ws, 2, "set", camera_id=cam.dev.id, action="tracking", detect_type="md", enable=True)
    assert r["error"]["code"] == "invalid"
    fake = FakeCam()
    fake.fail = {"SetRecV20"}
    cam.api.send.side_effect = fake.send
    r = await call(cam.ws, 3, "set", camera_id=cam.dev.id, action="rec", detect_type="md", enable=True)
    assert r["error"]["code"] == "camera_error"
    cam.api.send.side_effect = AsyncMock(side_effect=ConnectionError("weg"))
    r = await call(cam.ws, 4, "get", camera_id=cam.dev.id)
    assert r["error"]["code"] == "camera_error" and "weg" in r["error"]["message"]


async def test_ws_set_requires_admin(cam, hass_admin_user, hass_ws_client, hass_read_only_access_token):
    ws = await hass_ws_client(cam.hass, hass_read_only_access_token)
    r = await call(ws, 1, "set", camera_id=cam.dev.id, action="push", detect_type="md", enable=True)
    assert r["error"]["code"] == "unauthorized"
    cam.api.send.assert_not_awaited()


async def test_ws_entry_missing_or_not_ready(cam):
    del cam.entry.runtime_data
    for i, (kind, kw) in enumerate((("get", {}), ("set", dict(action="push", detect_type="md", enable=True)))):
        r = await call(cam.ws, 10 + i, kind, camera_id=cam.dev.id, **kw)
        assert r["error"]["code"] == "reolink_not_ready" and "nicht bereit" in r["error"]["message"]
    r = await call(cam.ws, 12, "get", camera_id="unbekannt")
    assert r["error"]["code"] == "not_found"
