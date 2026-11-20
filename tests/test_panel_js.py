"""Panel-JS: Syntaxcheck mit node (node ist Pflicht, kein Skip)."""
import subprocess
from pathlib import Path

JS = Path(__file__).parent.parent / "custom_components/kamera_zentrale/www/kamera-zentrale-panel.js"


def test_node_check():
    r = subprocess.run(["node", "--check", str(JS)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


def _detect(entities):
    """detectPtz aus dem Panel-JS in node ausführen (Stubs für DOM-Globals)."""
    import json
    prog = (
        "const vm=require('vm'),fs=require('fs');const c=vm.createContext({HTMLElement:class{},"
        "customElements:{define(){}},location:{search:''},URLSearchParams});"
        f"vm.runInContext(fs.readFileSync({json.dumps(str(JS))},'utf8'),c);"
        f"console.log(JSON.stringify(vm.runInContext('detectPtz('+{json.dumps(json.dumps(entities))}+')',c)));"
    )
    r = subprocess.run(["node", "-e", prog], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def _e(eid, key=None):
    return {"entity_id": eid, "domain": eid.split(".")[0], "translation_key": key}


def test_detect_ptz_none():
    assert _detect([_e("camera.cam"), _e("switch.cam_record", "record")]) is None


def test_detect_ptz_full():
    ents = [_e("button.c_ptz_left", "ptz_left"), _e("button.c_ptz_stop", "ptz_stop"),
            _e("button.c_ptz_zoom_in", "ptz_zoom_in"), _e("number.c_zoom", "zoom"),
            _e("select.c_preset", "ptz_preset"), _e("switch.c_track", "auto_tracking"),
            _e("button.c_guard", "guard_go_to")]
    p = _detect(ents)
    assert p["btn"]["left"] == "button.c_ptz_left" and p["btn"]["stop"] == "button.c_ptz_stop"
    assert p["btn"]["zoom_in"] == "button.c_ptz_zoom_in" and p["btn"]["up"] is None
    assert (p["zoom"], p["preset"], p["tracking"], p["guard"]) == (
        "number.c_zoom", "select.c_preset", "switch.c_track", "button.c_guard")


def test_detect_ptz_entity_id_fallback():
    p = _detect([_e("button.cam_ptz_up"), _e("button.cam_ptz_stop")])
    assert p["btn"]["up"] == "button.cam_ptz_up" and p["btn"]["stop"] == "button.cam_ptz_stop"


def _lenses(entities):
    import json
    prog = (
        "const vm=require('vm'),fs=require('fs');const c=vm.createContext({HTMLElement:class{},"
        "customElements:{define(){}},location:{search:''},URLSearchParams});"
        f"vm.runInContext(fs.readFileSync({json.dumps(str(JS))},'utf8'),c);"
        f"console.log(JSON.stringify(vm.runInContext('lensesOf('+{json.dumps(json.dumps(entities))}+')',c)));"
    )
    r = subprocess.run(["node", "-e", prog], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def test_lenses_none_and_single_view():
    assert _lenses([_e("switch.x")]) == []
    assert _lenses([_e("camera.cam_a", "fluent"), _e("camera.cam_b", "clear")]) == [
        {"index": 0, "label": "", "entity_id": "camera.cam_a"}]


def test_lenses_trackmix_sub_only():
    got = _lenses([_e("camera.g_obj_1", "sub_lens_1"), _e("camera.g_obj_0", "sub_lens_0"), _e("switch.x")])
    assert got == [{"index": 0, "label": "Weitwinkel", "entity_id": "camera.g_obj_0"},
                   {"index": 1, "label": "Tele", "entity_id": "camera.g_obj_1"}]


def test_lenses_prefer_main_and_extra_label():
    got = _lenses([_e("camera.s0", "sub_lens_0"), _e("camera.m0", "main_lens_0"),
                   _e("camera.m1", "main_lens_1"), _e("camera.s2", "sub_lens_2")])
    assert [(x["index"], x["label"], x["entity_id"]) for x in got] == [
        (0, "Weitwinkel", "camera.m0"), (1, "Tele", "camera.m1"), (2, "Objektiv 2", "camera.s2")]


def _pick(clips, at):
    import json
    prog = (
        "const vm=require('vm'),fs=require('fs');const c=vm.createContext({HTMLElement:class{},"
        "customElements:{define(){}},location:{search:''},URLSearchParams});"
        f"vm.runInContext(fs.readFileSync({json.dumps(str(JS))},'utf8'),c);"
        f"console.log(JSON.stringify(vm.runInContext('pickClip('+{json.dumps(json.dumps(clips))}+','+{json.dumps(json.dumps(at))}+')',c)));"
    )
    r = subprocess.run(["node", "-e", prog], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def _c(stamp):
    iso = f"{stamp[:4]}-{stamp[4:6]}-{stamp[6:8]}T{stamp[8:10]}:{stamp[10:12]}:{stamp[12:]}"
    return {"filename": f"event_{stamp}.mp4", "time": iso}


AT = "20260101120000"


def test_pick_empty_waits():
    assert _pick([], AT) == {"state": "wait"}


def test_pick_boundaries():
    assert _pick([_c("20260101115830")], AT)["state"] == "play"  # at-90s
    assert _pick([_c("20260101115829")], AT)["state"] == "wait"  # at-91s
    assert _pick([_c("20260101120030")], AT)["state"] == "play"  # at+30s
    assert _pick([_c("20260101120031")], AT)["state"] == "fallback"  # at+31s


def test_pick_nearest_of_many():
    r = _pick([_c("20260101120020"), _c("20260101115955"), _c("20260101115900")], AT)
    assert r["state"] == "play" and r["clip"]["filename"] == "event_20260101115955.mp4"


def test_pick_wait_old_clips():
    assert _pick([_c("20260101110000"), _c("20260101115000")], AT)["state"] == "wait"


def test_pick_fallback_nearest_before():
    r = _pick([_c("20260101130000"), _c("20260101110000"), _c("20260101100000")], AT)
    assert r["state"] == "fallback" and r["clip"]["filename"] == "event_20260101110000.mp4"


def test_pick_fallback_none_before():
    assert _pick([_c("20260101130000")], AT) == {"state": "fallback"}
