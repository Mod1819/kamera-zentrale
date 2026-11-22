"""Verbund: Regel-Logik (follow/pulse/only_dark/event/Besitz/Unload) und WebSocket."""
from datetime import timedelta

import pytest
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import async_fire_time_changed, async_mock_service

from custom_components.kamera_zentrale.const import DOMAIN
from custom_components.kamera_zentrale.links import LinkManager

from .test_init import _setup

TRIG, TGT = "light.garten_light", "light.garten_scheinwerfer"


def rule(**kw):
    return {"name": "Test", "trigger_entity": TRIG, "target_entities": [TGT], "mode": "follow",
            "hold_seconds": 0, "only_dark": False, "enabled": True, **kw}


@pytest.fixture
def calls(hass):
    on = async_mock_service(hass, "homeassistant", "turn_on")
    off = async_mock_service(hass, "homeassistant", "turn_off")
    hass.states.async_set(TRIG, "off")
    hass.states.async_set(TGT, "off")
    return on, off


@pytest.fixture
async def mgr(hass, calls):
    m = LinkManager(hass)
    await m.async_load()
    yield m
    m.async_unload()


async def tick(hass, seconds):
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=seconds))
    await hass.async_block_till_done()


async def set_state(hass, eid, state, **attrs):
    hass.states.async_set(eid, state, attrs)
    await hass.async_block_till_done()


def ids(call_list):
    return [c.data["entity_id"] for c in call_list]


async def test_store_empty_no_rules(mgr):
    assert mgr.async_list() == []


async def test_follow_with_hold(hass, mgr, calls):
    on, off = calls
    await mgr.async_save(rule(hold_seconds=30))
    await set_state(hass, TRIG, "on")
    assert ids(on) == [[TGT]]
    await set_state(hass, TGT, "on")
    await set_state(hass, TRIG, "off")
    await tick(hass, 20)
    assert not off
    await tick(hass, 31)
    assert ids(off) == [[TGT]]


async def test_follow_no_hold_immediate_off(hass, mgr, calls):
    on, off = calls
    await mgr.async_save(rule())
    await set_state(hass, TRIG, "on")
    await set_state(hass, TGT, "on")
    await set_state(hass, TRIG, "off")
    assert ids(off) == [[TGT]]


async def test_retrigger_cancels_timer(hass, mgr, calls):
    on, off = calls
    await mgr.async_save(rule(hold_seconds=30))
    await set_state(hass, TRIG, "on")
    await set_state(hass, TGT, "on")
    await set_state(hass, TRIG, "off")
    await set_state(hass, TRIG, "on")  # wieder an -> Timer weg
    await tick(hass, 60)
    assert not off
    await set_state(hass, TRIG, "off")
    await tick(hass, 31)
    assert ids(off) == [[TGT]]


async def test_pulse_extends_single_timer(hass, mgr, calls):
    on, off = calls
    await mgr.async_save(rule(mode="pulse", hold_seconds=3))  # min 10 s
    await set_state(hass, TRIG, "on")
    await set_state(hass, TRIG, "off")
    await set_state(hass, TRIG, "on")  # erneuter Impuls
    assert len(mgr._timer) == 1
    await tick(hass, 5)
    assert not off  # 3 s wird auf 10 s angehoben
    await tick(hass, 11)
    assert ids(off) == [[TGT]]  # genau einmal


async def test_pulse_ignores_trigger_off(hass, mgr, calls):
    on, off = calls
    await mgr.async_save(rule(mode="pulse", hold_seconds=30))
    await set_state(hass, TRIG, "on")
    await set_state(hass, TRIG, "off")
    assert not off


@pytest.mark.parametrize(("sun", "expect"), [("above_horizon", 0), ("below_horizon", 1), (None, 1)])
async def test_only_dark(hass, mgr, calls, sun, expect):
    on, _ = calls
    if sun:
        hass.states.async_set("sun.sun", sun)
    await mgr.async_save(rule(only_dark=True))
    await set_state(hass, TRIG, "on")
    assert len(on) == expect


async def test_event_impulse(hass, mgr, calls):
    on, off = calls
    ev = "event.ring_motion"
    hass.states.async_set(ev, "2026-11-20T10:00:00")
    await mgr.async_save(rule(trigger_entity=ev))
    await set_state(hass, ev, "2026-11-20T10:00:00", extra=1)  # nur Attribut -> kein Impuls
    assert not on
    await set_state(hass, ev, "2026-11-20T10:05:00")
    assert ids(on) == [[TGT]]
    await tick(hass, 5)
    assert not off
    await tick(hass, 11)  # hold 0 -> min 10 s
    assert ids(off) == [[TGT]]
    await set_state(hass, ev, "unavailable")
    await set_state(hass, ev, "2026-11-20T10:05:00")  # Rückkehr aus unavailable ist kein Impuls
    assert len(on) == 1


async def test_manually_on_target_not_switched_off(hass, mgr, calls):
    on, off = calls
    await mgr.async_save(rule())
    await set_state(hass, TGT, "on")
    await set_state(hass, TRIG, "on")
    await set_state(hass, TRIG, "off")
    assert not on and not off


async def test_old_state_none_ignored(hass, mgr, calls):
    on, _ = calls
    hass.states.async_set("light.neu", "off")
    await mgr.async_save(rule(trigger_entity="light.neu"))
    hass.states.async_remove("light.neu")
    await set_state(hass, "light.neu", "on")  # erste Meldung (old_state None)
    assert not on
    await set_state(hass, "light.neu", "off")
    await set_state(hass, "light.neu", "on")
    assert len(on) == 1


async def test_disabled_rule_inactive(hass, mgr, calls):
    on, _ = calls
    await mgr.async_save(rule(enabled=False))
    await set_state(hass, TRIG, "on")
    assert not on


async def test_unload_cleans_up(hass, mgr, calls):
    on, off = calls
    await mgr.async_save(rule(hold_seconds=30))
    await set_state(hass, TRIG, "on")
    await set_state(hass, TGT, "on")
    await set_state(hass, TRIG, "off")  # Timer läuft
    mgr.async_unload()
    await hass.async_block_till_done()
    assert ids(off) == [[TGT]] and not mgr._timer and not mgr._unsub
    await tick(hass, 60)
    await set_state(hass, TRIG, "on")
    assert len(on) == 1 and len(off) == 1


async def test_persistence(hass, mgr):
    saved = await mgr.async_save(rule())
    other = LinkManager(hass)
    await other.async_load()
    assert other.async_list() == [saved]


# ---------- WebSocket ----------

async def _ws(hass, hass_ws_client, token=None):
    await _setup(hass)
    return await (hass_ws_client(hass, token) if token else hass_ws_client(hass))


async def call(ws, i, kind, **kw):
    await ws.send_json({"id": i, "type": f"{DOMAIN}/links/{kind}", **kw})
    return await ws.receive_json()


async def test_ws_save_list_delete(hass, hass_ws_client, calls):
    ws = await _ws(hass, hass_ws_client)
    assert (await call(ws, 1, "list"))["result"] == {"rules": []}  # nichts automatisch angelegt
    r = await call(ws, 2, "save", rule={"name": " Ring ", "trigger_entity": TRIG, "target_entities": [TGT], "mode": "follow"})
    saved = r["result"]["rule"]
    assert saved["name"] == "Ring" and saved["hold_seconds"] == 0 and saved["enabled"] and saved["id"]
    upd = await call(ws, 3, "save", rule={**saved, "hold_seconds": 45})
    assert upd["result"]["rule"]["id"] == saved["id"]
    rules = (await call(ws, 4, "list"))["result"]["rules"]
    assert len(rules) == 1 and rules[0]["hold_seconds"] == 45
    assert (await call(ws, 5, "delete", rule_id=saved["id"]))["success"]
    assert (await call(ws, 6, "list"))["result"]["rules"] == []
    assert (await call(ws, 7, "delete", rule_id="nix"))["error"]["code"] == "not_found"


async def test_ws_validation(hass, hass_ws_client, calls):
    ws = await _ws(hass, hass_ws_client)
    ok = {"name": "x", "trigger_entity": TRIG, "target_entities": [TGT], "mode": "follow"}
    for i, bad in enumerate([
        {"mode": "x"}, {"hold_seconds": 4000}, {"hold_seconds": -1}, {"name": ""}, {"target_entities": []},
        {"trigger_entity": "kein id"},
    ], 1):
        assert (await call(ws, i, "save", rule={**ok, **bad}))["error"]["code"] == "invalid_format", bad
    assert (await call(ws, 20, "save", rule={**ok, "target_entities": ["light.gibt_es_nicht"]}))["error"]["code"] == "unknown_entity"
    assert (await call(ws, 21, "save", rule={**ok, "trigger_entity": "sensor.x"}))["error"]["code"] == "invalid"
    assert (await call(ws, 22, "save", rule={**ok, "target_entities": [TRIG]}))["error"]["code"] == "invalid"
    assert (await call(ws, 23, "save", rule={**ok, "id": "nix"}))["error"]["code"] == "not_found"
    assert (await call(ws, 24, "list"))["result"]["rules"] == []


async def test_ws_admin_required(hass, hass_ws_client, hass_read_only_access_token, calls):
    admin = await _ws(hass, hass_ws_client)
    rid = (await call(admin, 1, "save", rule={"name": "x", "trigger_entity": TRIG, "target_entities": [TGT],
                                              "mode": "follow"}))["result"]["rule"]["id"]
    ws = await hass_ws_client(hass, hass_read_only_access_token)
    assert len((await call(ws, 1, "list"))["result"]["rules"]) == 1  # Lesen erlaubt
    new = {"name": "y", "trigger_entity": TRIG, "target_entities": [TGT], "mode": "follow"}
    for i, (kind, kw) in enumerate([("save", {"rule": new}), ("delete", {"rule_id": rid}), ("test", {"rule_id": rid})], 2):
        assert (await call(ws, i, kind, **kw))["error"]["code"] == "unauthorized"
    assert len((await call(admin, 9, "list"))["result"]["rules"]) == 1


async def test_ws_test_turns_on_for_10s(hass, hass_ws_client, calls):
    on, off = calls
    ws = await _ws(hass, hass_ws_client)
    rid = (await call(ws, 1, "save", rule={"name": "x", "trigger_entity": TRIG, "target_entities": [TGT],
                                           "mode": "follow"}))["result"]["rule"]["id"]
    assert (await call(ws, 2, "test", rule_id=rid))["success"]
    await hass.async_block_till_done()
    assert ids(on) == [[TGT]] and not off
    await tick(hass, 11)
    assert ids(off) == [[TGT]]
    assert (await call(ws, 3, "test", rule_id="nix"))["error"]["code"] == "not_found"


# ---------- Licht-Verbund (kind=group) ----------

A, B, X, SENS = "light.garten_light", "light.garten_scheinwerfer", "switch.zusatz", "binary_sensor.bewegung"


def grp(**kw):
    return {"kind": "group", "name": "V", "members": [A, B], "followers": [X], "triggers": [],
            "hold_seconds": 0, "only_dark": False, "enabled": True, **kw}


@pytest.fixture
def g(hass, calls):
    for e in (X, SENS):
        hass.states.async_set(e, "off")


async def own(hass, call_list, eid, state):
    """Zustand so melden, wie HA es nach unserem Dienstaufruf tut (gleicher Context)."""
    hass.states.async_set(eid, state, context=call_list[-1].context)
    await hass.async_block_till_done()


async def test_group_mutual_and_followers(hass, mgr, calls, g):
    on, off = calls
    await mgr.async_save(grp())
    await set_state(hass, A, "on")
    assert sorted(ids(on)[0]) == [B, X]
    for e in (B, X):
        await own(hass, on, e, "on")
    assert len(on) == 1 and not off  # keine Schleife
    await set_state(hass, A, "off")
    assert sorted(ids(off)[0]) == [B, X]
    for e in (B, X):
        await own(hass, off, e, "off")
    assert len(on) == 1 and len(off) == 1


async def test_group_reverse_direction(hass, mgr, calls, g):
    on, off = calls
    await mgr.async_save(grp())
    await set_state(hass, B, "on")
    assert sorted(ids(on)[0]) == [A, X]
    await set_state(hass, B, "off")
    assert sorted(ids(off)[0]) == [A, X]


async def test_group_preexisting_member_not_switched_off(hass, mgr, calls, g):
    on, off = calls
    await set_state(hass, B, "on")
    await mgr.async_save(grp())
    await set_state(hass, A, "on")
    assert sorted(ids(on)[0]) == [X]  # B war schon an
    await set_state(hass, A, "off")
    assert ids(off) == []  # B ist noch Initiator (nicht von uns an)
    await set_state(hass, B, "off")
    assert sorted(ids(off)[0]) == [X]
    assert B not in ids(off)[0]


async def test_group_hold_and_cancel(hass, mgr, calls, g):
    on, off = calls
    await mgr.async_save(grp(hold_seconds=30))
    await set_state(hass, A, "on")
    await set_state(hass, A, "off")
    await tick(hass, 20)
    assert not off
    await set_state(hass, A, "on")  # Abbruch
    await set_state(hass, A, "off")
    await tick(hass, 25)
    assert not off  # Timer wurde neu gestartet
    await tick(hass, 31)  # tick ist absolut ab jetzt
    assert sorted(ids(off)[0]) == [B, X]


async def test_group_trigger_sensor_alone(hass, mgr, calls, g):
    on, off = calls
    await mgr.async_save(grp(members=[A], triggers=[SENS]))
    await set_state(hass, SENS, "on")
    assert sorted(ids(on)[0]) == [A, X]
    await set_state(hass, SENS, "off")
    assert sorted(ids(off)[0]) == [A, X]


async def test_group_event_impulse(hass, mgr, calls, g):
    on, off = calls
    ev = "event.ring_motion"
    hass.states.async_set(ev, "2026-11-20T10:00:00")
    await mgr.async_save(grp(members=[A], triggers=[ev]))
    await set_state(hass, ev, "2026-11-20T10:05:00")
    assert sorted(ids(on)[0]) == [A, X]
    await tick(hass, 20)
    assert not off
    await tick(hass, 31)  # 30 s Mindestdauer
    assert sorted(ids(off)[0]) == [A, X]


@pytest.mark.parametrize(("sun", "expect"), [("above_horizon", 0), ("below_horizon", 1)])
async def test_group_only_dark(hass, mgr, calls, g, sun, expect):
    on, _ = calls
    hass.states.async_set("sun.sun", sun)
    await mgr.async_save(grp(only_dark=True))
    await set_state(hass, A, "on")
    assert len(on) == expect


async def test_group_external_off_of_owned(hass, mgr, calls, g):
    on, off = calls
    await mgr.async_save(grp())
    await set_state(hass, A, "on")
    await own(hass, on, B, "on")
    await set_state(hass, B, "off")  # extern aus -> nicht mehr owned
    assert not off
    await set_state(hass, A, "off")
    assert ids(off) == [[X]]


async def test_group_owned_reported_on_again_stays_owned(hass, mgr, calls, g):
    on, off = calls
    await mgr.async_save(grp())
    await set_state(hass, A, "on")
    await own(hass, on, B, "on")
    await set_state(hass, B, "on", brightness=5)  # extern erneut "an" gemeldet
    await set_state(hass, A, "off")
    assert sorted(ids(off)[0]) == [B, X]


async def test_group_test_and_unload(hass, mgr, calls, g):
    on, off = calls
    saved = await mgr.async_save(grp())
    mgr.async_test(saved["id"])
    await hass.async_block_till_done()
    assert sorted(ids(on)[0]) == [A, B, X] and not off
    await tick(hass, 11)
    assert sorted(ids(off)[0]) == [A, B, X]
    mgr.async_test(saved["id"])
    await hass.async_block_till_done()
    mgr.async_unload()
    await hass.async_block_till_done()
    assert len(off) == 2 and not mgr._timer and not mgr._unsub and not mgr._active


async def test_group_list_active_and_legacy_kind(hass, mgr, calls, g):
    saved = await mgr.async_save(grp())
    await mgr.async_save(rule())
    mgr.rules["old"] = {k: v for k, v in rule().items()} | {"id": "old"}  # Altregel ohne kind
    lst = {r["id"]: r for r in mgr.async_list()}
    assert lst[saved["id"]]["active"] is False and lst["old"]["kind"] == "link"
    await set_state(hass, A, "on")
    assert {r["id"]: r for r in mgr.async_list()}[saved["id"]]["active"] is True


async def test_ws_group_validation_and_save(hass, hass_ws_client, calls, g):
    ws = await _ws(hass, hass_ws_client)
    ok = grp()
    del ok["enabled"]
    saved = (await call(ws, 1, "save", rule=ok))["result"]["rule"]
    assert saved["kind"] == "group" and saved["id"]
    lst = (await call(ws, 2, "list"))["result"]["rules"]
    assert lst[0]["kind"] == "group" and lst[0]["active"] is False
    for i, (bad, code) in enumerate([
        ({"members": [A]}, "invalid"), ({"members": [A], "triggers": []}, "invalid"),
        ({"followers": [A]}, "invalid"), ({"members": [A, B, B]}, "invalid"),
        ({"followers": ["light.gibt_es_nicht"]}, "unknown_entity"), ({"members": [A, "siren.x"]}, "invalid"),
        ({"hold_seconds": 4000}, "invalid_format"), ({"name": ""}, "invalid_format"),
    ], 10):
        assert (await call(ws, i, "save", rule={**ok, **bad}))["error"]["code"] == code, bad
    # 1 Mitglied + 1 Auslöser ist gültig
    assert (await call(ws, 30, "save", rule={**ok, "members": [A], "triggers": [SENS]}))["success"]
