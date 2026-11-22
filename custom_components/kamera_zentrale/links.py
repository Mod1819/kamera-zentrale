"""Verbund: Kopplungen zwischen Geräten (Auslöser -> Ziele), gespeichert im HA-Store.

Regel kind "link" (Default bei Altregeln):
  {id, name, enabled, trigger_entity, target_entities, mode: follow|pulse, hold_seconds, only_dark}
Regel kind "group" (Licht-Verbund, gegenseitig):
  {id, kind, name, enabled, members, followers, triggers, hold_seconds, only_dark}
"""
from __future__ import annotations

import logging
import uuid
from collections import deque
from typing import Any

import voluptuous as vol
from homeassistant.core import CALLBACK_TYPE, Context, Event, HomeAssistant, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.event import async_call_later, async_track_state_change_event
from homeassistant.helpers.storage import Store

_LOGGER = logging.getLogger(__name__)

STORE_KEY = "kamera_zentrale.links"
STORE_VERSION = 1
TRIGGER_DOMAINS = ("light", "switch", "binary_sensor", "event", "input_boolean")
TARGET_DOMAINS = ("light", "switch", "siren")
GROUP_MEMBER_DOMAINS = ("light", "switch")
GROUP_TRIGGER_DOMAINS = ("binary_sensor", "event", "light", "switch")
MIN_PULSE = 10
EVENT_HOLD = 30
CTX_KEEP = 50
TEST_SECONDS = 10
_INVALID = ("unavailable", "unknown")

RULE_SCHEMA = vol.Schema({
    vol.Optional("kind", default="link"): "link",
    vol.Optional("id"): str,
    vol.Required("name"): vol.All(str, vol.Strip, vol.Length(min=1, max=60)),
    vol.Optional("enabled", default=True): bool,
    vol.Required("trigger_entity"): cv.entity_id,
    vol.Required("target_entities"): vol.All([cv.entity_id], vol.Length(min=1, max=20)),
    vol.Required("mode"): vol.In(("follow", "pulse")),
    vol.Optional("hold_seconds", default=0): vol.All(int, vol.Range(min=0, max=3600)),
    vol.Optional("only_dark", default=False): bool,
})

_ENTS = vol.All([cv.entity_id], vol.Length(max=20))
GROUP_SCHEMA = vol.Schema({
    vol.Optional("id"): str,
    vol.Required("kind"): "group",
    vol.Required("name"): vol.All(str, vol.Strip, vol.Length(min=1, max=60)),
    vol.Optional("enabled", default=True): bool,
    vol.Required("members"): _ENTS,
    vol.Optional("followers", default=list): _ENTS,
    vol.Optional("triggers", default=list): _ENTS,
    vol.Optional("hold_seconds", default=0): vol.All(int, vol.Range(min=0, max=3600)),
    vol.Optional("only_dark", default=False): bool,
})


def validate_rule(value: Any) -> dict[str, Any]:
    """Schema je kind (ohne kind = Kopplung)."""
    if isinstance(value, dict) and value.get("kind") == "group":
        return GROUP_SCHEMA(value)
    return RULE_SCHEMA(value)


class LinkError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code, self.message = code, message


class LinkManager:
    """Hält Regeln, Listener, Nachlauf-Timer und die von Regeln eingeschalteten Ziele."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._store: Store = Store(hass, STORE_VERSION, STORE_KEY)
        self.rules: dict[str, dict[str, Any]] = {}
        self._unsub: dict[str, CALLBACK_TYPE] = {}
        self._timer: dict[str, CALLBACK_TYPE] = {}
        self._owned: dict[str, set[str]] = {}  # Ziele, die die Regel selbst eingeschaltet hat
        self._ctx: dict[str, deque[str]] = {}  # eigene Context-ids je Regel (Verbund)
        self._active: set[str] = set()  # Verbünde, die gerade laufen
        self._ev: dict[str, CALLBACK_TYPE] = {}  # laufende event-Impulse je Verbund

    # ---------- Lebenszyklus ----------

    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        self.rules = {r["id"]: r for r in data.get("rules", [])}
        for rule in self.rules.values():
            self._arm(rule)

    @callback
    def async_unload(self) -> None:
        for rid in list(self.rules):
            self._disarm(rid)

    async def _persist(self) -> None:
        await self._store.async_save({"rules": list(self.rules.values())})

    # ---------- API ----------

    def async_list(self) -> list[dict[str, Any]]:
        return [{**r, "kind": r.get("kind", "link"), **({"active": r["id"] in self._active} if r.get("kind") == "group" else {})}
                for r in self.rules.values()]

    async def async_save(self, rule: dict[str, Any]) -> dict[str, Any]:
        rule = dict(rule)
        rid = rule.get("id")
        if rid and rid not in self.rules:
            raise LinkError("not_found", "Kopplung unbekannt")
        if rule.get("kind") == "group":
            self._check_group(rule)
        else:
            rule["kind"] = "link"
            self._check_entity(rule["trigger_entity"], TRIGGER_DOMAINS, "Auslöser")
            for eid in rule["target_entities"]:
                self._check_entity(eid, TARGET_DOMAINS, "Ziel")
            if rule["trigger_entity"] in rule["target_entities"]:
                raise LinkError("invalid", "Auslöser darf nicht Ziel sein")
        rule["id"] = rid or uuid.uuid4().hex[:8]
        self._disarm(rule["id"])
        self.rules[rule["id"]] = rule
        self._arm(rule)
        await self._persist()
        return rule

    async def async_delete(self, rid: str) -> None:
        if rid not in self.rules:
            raise LinkError("not_found", "Kopplung unbekannt")
        self._disarm(rid)
        del self.rules[rid]
        await self._persist()

    @callback
    def async_test(self, rid: str) -> None:
        rule = self.rules.get(rid)
        if rule is None:
            raise LinkError("not_found", "Kopplung unbekannt")
        if rule.get("kind") == "group":
            self._gactivate(rule)
            self._schedule(rid, TEST_SECONDS)
        else:
            self._on(rule, TEST_SECONDS)

    def _check_group(self, rule: dict[str, Any]) -> None:
        m, f, t = rule["members"], rule.get("followers", []), rule.get("triggers", [])
        rule["followers"], rule["triggers"] = f, t
        if not (len(m) >= 2 or (m and t)):
            raise LinkError("invalid", "Mindestens 2 Mitglieder (oder 1 Mitglied + 1 Auslöser)")
        allx = m + f + t
        if len(set(allx)) != len(allx):
            raise LinkError("invalid", "Eine Entität darf nur einmal vorkommen")
        for eids, domains, what in ((m, GROUP_MEMBER_DOMAINS, "Mitglied"), (f, TARGET_DOMAINS, "Zusatzgerät"),
                                    (t, GROUP_TRIGGER_DOMAINS, "Auslöser")):
            for eid in eids:
                self._check_entity(eid, domains, what)

    def _check_entity(self, eid: str, domains: tuple[str, ...], what: str) -> None:
        if eid.split(".", 1)[0] not in domains:
            raise LinkError("invalid", f"{what} {eid}: Typ nicht erlaubt")
        if self.hass.states.get(eid) is None and er.async_get(self.hass).async_get(eid) is None:
            raise LinkError("unknown_entity", f"{what} {eid} existiert nicht")

    # ---------- Laufzeit ----------

    def _arm(self, rule: dict[str, Any]) -> None:
        if not rule["enabled"]:
            return
        rid = rule["id"]
        group = rule.get("kind") == "group"
        handler = self._ghandle if group else self._handle
        watch = rule["members"] + rule["followers"] + rule["triggers"] if group else [rule["trigger_entity"]]

        @callback
        def _changed(event: Event) -> None:
            handler(rid, event.data.get("old_state"), event.data.get("new_state"))

        self._unsub[rid] = async_track_state_change_event(self.hass, watch, _changed)

    def _disarm(self, rid: str) -> None:
        """Listener + Timer weg, selbst eingeschaltete Ziele aus."""
        if unsub := self._unsub.pop(rid, None):
            unsub()
        self._cancel_timer(rid)
        if cancel := self._ev.pop(rid, None):
            cancel()
        self._off(rid)

    def _cancel_timer(self, rid: str) -> None:
        if cancel := self._timer.pop(rid, None):
            cancel()

    def _handle(self, rid: str, old, new) -> None:
        rule = self.rules.get(rid)
        if rule is None or old is None or new is None:  # Start/Neuanlage ist kein Auslöser
            return
        is_event = rule["trigger_entity"].startswith("event.")
        if is_event:
            fired = new.state not in _INVALID and old.state != "unavailable" and new.state != old.state
            went_off = False
        else:
            fired = new.state == "on" and old.state != "on"
            went_off = new.state == "off" and old.state == "on"
        hold = rule["hold_seconds"]
        if fired:
            sun = self.hass.states.get("sun.sun")
            if rule["only_dark"] and sun is not None and sun.state != "below_horizon":
                return
            self._on(rule, max(hold, MIN_PULSE) if is_event or rule["mode"] == "pulse" else None)
        elif went_off and rule["mode"] == "follow":
            if hold > 0:
                self._schedule(rid, hold)
            else:
                self._cancel_timer(rid)
                self._off(rid)

    def _on(self, rule: dict[str, Any], hold: int | None) -> None:
        """Ziele einschalten (nur die, die nicht schon an sind); hold -> nach hold s wieder aus, sonst Timer weg."""
        rid = rule["id"]
        todo = [t for t in rule["target_entities"] if (s := self.hass.states.get(t)) is None or s.state != "on"]
        if todo:
            self._owned.setdefault(rid, set()).update(todo)
            self._call("turn_on", todo, rid)
        if hold is None:
            self._cancel_timer(rid)
        else:
            self._schedule(rid, hold)

    def _schedule(self, rid: str, delay: int) -> None:
        self._cancel_timer(rid)

        @callback
        def _fire(_now) -> None:
            self._timer.pop(rid, None)
            self._off(rid)

        self._timer[rid] = async_call_later(self.hass, delay, _fire)

    def _off(self, rid: str) -> None:
        self._active.discard(rid)
        if owned := self._owned.pop(rid, None):
            self._call("turn_off", sorted(owned), rid)

    def _call(self, service: str, entities: list[str], rid: str) -> None:
        ctx = Context()  # eigene id merken, damit unsere Schaltungen den Verbund nicht erneut auslösen
        self._ctx.setdefault(rid, deque(maxlen=CTX_KEEP)).append(ctx.id)
        self.hass.async_create_task(
            self.hass.services.async_call("homeassistant", service, {"entity_id": entities}, blocking=True, context=ctx),
            eager_start=True,
        )

    # ---------- Laufzeit: Licht-Verbund ----------

    def _is_on(self, eid: str) -> bool:
        return (s := self.hass.states.get(eid)) is not None and s.state == "on"

    def _ghandle(self, rid: str, old, new) -> None:
        rule = self.rules.get(rid)
        if rule is None or old is None or new is None:
            return
        ctx = new.context
        mine = self._ctx.get(rid, ())
        if ctx.id in mine or (ctx.parent_id and ctx.parent_id in mine):
            return  # von uns geschaltet
        eid = new.entity_id
        if eid.startswith("event."):
            if new.state not in _INVALID and old.state != "unavailable" and new.state != old.state:
                if cancel := self._ev.pop(rid, None):
                    cancel()

                @callback
                def _end(_now) -> None:
                    self._ev.pop(rid, None)
                    self._geval(rid)

                self._ev[rid] = async_call_later(self.hass, max(rule["hold_seconds"], EVENT_HOLD), _end)
        elif new.state != "on":
            self._owned.get(rid, set()).discard(eid)  # extern aus: nicht mehr unser
        self._geval(rid)

    def _geval(self, rid: str) -> None:
        rule = self.rules[rid]
        owned = self._owned.get(rid, set())
        initiated = (rid in self._ev
                     or any(self._is_on(e) and e not in owned for e in rule["members"])
                     or any(self._is_on(e) for e in rule["triggers"] if not e.startswith("event.")))
        if initiated:
            self._cancel_timer(rid)
            if rid not in self._active:
                sun = self.hass.states.get("sun.sun")
                if rule["only_dark"] and sun is not None and sun.state != "below_horizon":
                    return
                self._gactivate(rule)
        elif rid in self._active and rid not in self._timer:
            if rule["hold_seconds"] > 0:
                self._schedule(rid, rule["hold_seconds"])
            else:
                self._off(rid)

    def _gactivate(self, rule: dict[str, Any]) -> None:
        rid = rule["id"]
        self._cancel_timer(rid)
        self._active.add(rid)
        todo = [e for e in rule["members"] + rule["followers"] if not self._is_on(e)]
        if todo:
            self._owned.setdefault(rid, set()).update(todo)
            self._call("turn_on", todo, rid)
