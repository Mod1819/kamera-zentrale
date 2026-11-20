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
