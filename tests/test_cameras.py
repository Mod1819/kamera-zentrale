"""cameras: Gruppierung, Mehrkamera, deaktivierte Entitäten, Fallback."""
from custom_components.kamera_zentrale.cameras import classify, group_cameras


def ent(dev, eid, key=None, disabled=False):
    return {"device_id": dev, "entity_id": eid, "domain": eid.split(".")[0],
            "translation_key": key, "name": eid, "disabled": disabled}


DEVS = [{"id": "b", "name": "Hof", "model": "RLC-810A", "sw_version": "1"},
        {"id": "a", "name": "Garten", "model": "E1", "sw_version": "2"}]
ENTS = [
    ent("a", "camera.garten_fluessig"), ent("a", "light.garten_floodlight"),
    ent("a", "switch.garten_ir", "ir_lights"), ent("a", "number.garten_s", "motion_sensitivity"),
    ent("a", "binary_sensor.garten_person", "person"), ent("a", "switch.garten_ftp", "ftp_upload"),
    ent("a", "select.garten_preset", "ptz_preset"), ent("a", "siren.garten_sirene"),
    ent("a", "button.garten_neustart", "restart"), ent("a", "sensor.garten_wifi", "wifi_signal"),
    ent("a", "switch.garten_xyz", "foo"), ent("a", "switch.garten_off", "ir_lights", disabled=True),
    ent("b", "camera.hof"),
]


def test_groups_sorted_and_multi_camera():
    cams = group_cameras(DEVS, ENTS)
    assert [c["name"] for c in cams] == ["Garten", "Hof"]
    garten, hof = cams
    assert [g["key"] for g in garten["groups"]] == [
        "live", "licht", "erkennung", "aufnahme", "ptz", "audio", "system", "sonstiges"]
    by = {g["key"]: [e["entity_id"] for e in g["entities"]] for g in garten["groups"]}
    assert by["licht"] == ["light.garten_floodlight", "switch.garten_ir"]  # deaktivierte fehlt
    assert by["erkennung"] == ["binary_sensor.garten_person", "number.garten_s"]
    assert by["ptz"] == ["select.garten_preset"] and by["audio"] == ["siren.garten_sirene"]
    assert by["system"] == ["button.garten_neustart", "sensor.garten_wifi"]
    assert by["sonstiges"] == ["switch.garten_xyz"]  # Fallback
    assert [g["key"] for g in hof["groups"]] == ["live"] and hof["model"] == "RLC-810A"


def test_classify_uses_entity_id_without_translation_key():
    assert classify({"domain": "switch", "entity_id": "switch.cam_record"}) == "aufnahme"
    assert classify({"domain": "switch", "entity_id": "switch.cam_unbekannt"}) == "sonstiges"


def test_device_without_entities():
    assert group_cameras([DEVS[0]], [])[0]["groups"] == []
