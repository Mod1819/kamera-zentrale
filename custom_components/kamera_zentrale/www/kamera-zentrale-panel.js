/* Kamera-Zentrale – Panel v0.2.0 (iOS/macOS Design)
 * Daten: WebSocket kamera_zentrale/cameras/list + clips/list + detection/get|set, Werte live aus hass.states,
 * Schreiben über normale HA-Dienste (hass.callService); Erkennungs-Matrix über detection/set (Admin).
 */
const DOMAIN = "kamera_zentrale";
const TABS = [
  ["live", "Live"], ["aufnahmen", "Aufnahmen"], ["licht", "Licht"], ["erkennung", "Erkennung"],
  ["aufnahme", "Aufnahme"], ["ptz", "PTZ"], ["audio", "Audio"], ["system", "System"], ["sonstiges", "Sonstiges"],
];
const REFRESH_MS = 2000;
const DET_TYPES = { people: ["Person", "account"], vehicle: ["Fahrzeug", "car"], dog_cat: ["Tier", "paw"], md: ["Bewegung", "motion-sensor"] };
const DET_ACTIONS = { push: "Push", rec: "Aufnahme", ftp: "FTP", email: "E-Mail" };
const DET_TRACK_ICON = "target";
const DETECTION_TYPES = ["motion", "person", "vehicle", "animal", "pet", "visitor"];

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTime = (iso) => new Date(iso).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "medium" });
const fmtDate = (iso) => { const d = new Date(iso); const now = new Date(); const diff = Math.floor((now - d) / 86400000); if (diff === 0) return "Heute"; if (diff === 1) return "Gestern"; return d.toLocaleDateString("de-DE"); };

/** PTZ-Entitäten einer Kamera erkennen (reine Funktion). `entities` = flache Liste {entity_id, domain, translation_key}.
 *  Gibt null zurück, wenn nichts Steuerbares da ist. */
const PTZ_DIRS = ["left", "right", "up", "down", "zoom_in", "zoom_out"];
function detectPtz(entities) {
  const key = (e) => String(e.translation_key || (e.entity_id || "").split(".").slice(1).join(".")).toLowerCase();
  const find = (dom, name) => {
    const e = (entities || []).find((x) => x.domain === dom && (key(x) === name || key(x).endsWith("_" + name)));
    return e ? e.entity_id : null;
  };
  const btn = {};
  [...PTZ_DIRS, "stop"].forEach((n) => { btn[n] = find("button", "ptz_" + n); });
  const p = {
    btn, guard: find("button", "guard_go_to"), calibrate: find("button", "ptz_calibrate"),
    zoom: find("number", "zoom"), focus: find("number", "focus"), speed: find("number", "ptz_speed"),
    preset: find("select", "ptz_preset"), tracking: find("switch", "auto_tracking"),
  };
  const any = PTZ_DIRS.some((n) => btn[n]) || p.zoom || p.focus || p.preset || p.tracking;
  return any ? p : null;
}

class KameraZentralePanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._cameras = null;
    this._error = "";
    this._cam = null; // device_id der Detailansicht
    this._tab = "live";
    this._clips = null; // {folder, clips} | {error}
    this._clipSrc = "";
    this._det = null; // {cam, data}|{cam, error}
    this._timer = null;
    this._params = new URLSearchParams(location.search);
    this._ptzMove = null; // aktive PTZ-Bewegung {stop, t0}
    this._ptzSpeed = 25;
    this._onVis = () => { if (document.hidden) this._ptzEnd(true); };
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._load();
    else this._updateValues();
  }

  connectedCallback() {
    this._timer = setInterval(() => this._refreshImages(), REFRESH_MS);
    document.addEventListener("visibilitychange", this._onVis);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    document.removeEventListener("visibilitychange", this._onVis);
    this._ptzEnd(true);
  }

  async _load() {
    try {
      const res = await this._hass.callWS({ type: `${DOMAIN}/cameras/list` });
      this._cameras = res.cameras;
      const want = this._params.get("camera");
      if (want && this._cameras.some((c) => c.id === want)) {
        this._cam = want;
        if (this._params.get("clip")) {
          this._tab = "aufnahmen";
          await this._loadClips();
          await this._play(this._params.get("clip"));
          return;
        }
      }
    } catch (e) {
      this._error = e.message || String(e);
    }
    this._render();
  }

  _camera() { return (this._cameras || []).find((c) => c.id === this._cam); }
  _state(eid) { return this._hass.states[eid]; }
  _liveEntity(cam) {
    const g = cam.groups.find((x) => x.key === "live");
    return g && g.entities.find((e) => e.domain === "camera");
  }
  _imgUrl(eid) {
    const st = this._state(eid);
    const token = st && st.attributes.access_token;
    return token ? `/api/camera_proxy/${eid}?token=${encodeURIComponent(token)}&t=${Date.now()}` : "";
  }

  _refreshImages() {
    if (!this._hass || document.hidden) return;
    this.shadowRoot.querySelectorAll("img[data-cam]").forEach((img) => {
      const url = this._imgUrl(img.dataset.cam);
      if (url) img.src = url;
    });
  }

  async _loadClips() {
    this._clips = null;
    this._render();
    try {
      this._clips = await this._hass.callWS({ type: `${DOMAIN}/clips/list`, camera_id: this._cam });
    } catch (e) {
      this._clips = { error: e.message || String(e) };
    }
    this._render();
  }

  async _play(filename) {
    try {
      const path = `/api/${DOMAIN}/clip/${encodeURIComponent(this._clips.folder)}/${encodeURIComponent(filename)}`;
      const signed = await this._hass.callWS({ type: "auth/sign_path", path });
      this._clipSrc = signed.path;
      this._clipName = filename;
    } catch (e) {
      this._clipSrc = "";
      this._error = e.message || String(e);
    }
    this._render();
  }

  // ---------- Rendering ----------

  _render() {
    this._ptzEnd(true); // DOM wird ersetzt: pointerup käme nie an
    const root = this.shadowRoot;
    root.innerHTML = `<style>${STYLE}</style><div class="wrap">${this._html()}</div>`;
    this._bind();
    if (this._cam && this._tab === "live") this._mountStream();
    this._updateValues();
  }

  _html() {
    if (this._error && !this._cameras) return `<p class="err">${esc(this._error)}</p>`;
    if (!this._cameras) return `<p class="muted">Lade Kameras …</p>`;
    const cam = this._camera();
    return cam ? this._detailHtml(cam) : this._overviewHtml();
  }

  _overviewHtml() {
    if (!this._cameras.length) return `<h1>Kameras</h1><p class="muted">Keine Reolink-Kameras gefunden.</p>`;
    const tiles = this._cameras.map((c) => {
      const live = this._liveEntity(c);
      const st = live && this._state(live.entity_id);
      const online = st && st.state !== "unavailable";
      return `<div class="tile" data-open="${esc(c.id)}">
        ${live ? `<img data-cam="${esc(live.entity_id)}" src="${esc(this._imgUrl(live.entity_id))}" alt="">` : `<div class="noimg">kein Bild</div>`}
        <div class="meta"><b>${esc(c.name)}</b><span class="dot ${online ? "on" : "off"}"></span>${online ? "online" : "offline"}</div>
      </div>`;
    });
    return `<h1>Kameras</h1><div class="grid">${tiles.join("")}</div>`;
  }

  _detailHtml(cam) {
    const keys = new Set(cam.groups.map((g) => g.key));
    const tabs = TABS.filter(([k]) => (k === "aufnahmen" ? true : keys.has(k)));
    if (!tabs.some(([k]) => k === this._tab)) this._tab = tabs[0][0];
    const nav = tabs.map(([k, l]) => `<button class="tab ${k === this._tab ? "act" : ""}" data-tab="${k}">${l}</button>`).join("");
    return `<div class="head"><button class="back-btn" data-back>‹ Kameras</button><div class="head-title"><h1>${esc(cam.name)}</h1>
      <p class="subhead">${esc(cam.model || "")} ${esc(cam.sw_version || "")}</p></div></div>
      <div class="tabs-seg">${nav}</div>
      ${this._error ? `<div class="toast err" id="toast-err">${esc(this._error)}</div>` : ""}
      <div class="body">${this._tabHtml(cam)}</div>`;
  }

  _tabHtml(cam) {
    if (this._tab === "live") {
      const live = this._liveEntity(cam);
      if (!live) return `<p class="muted">Keine Kamera-Entität.</p>`;
      const ptz = this._ptzHtml(cam);
      const stream = `<div id="stream"><img class="big" data-cam="${esc(live.entity_id)}" src="${esc(this._imgUrl(live.entity_id))}" alt=""></div>`;
      return ptz ? `<div class="live-wrap"><div>${stream}</div>${ptz}</div>` : stream;
    }
    if (this._tab === "aufnahmen") return this._clipsHtml();
    const g = cam.groups.find((x) => x.key === this._tab);
    if (!g) return "";

    if (this._tab === "erkennung") {
      const binaries = g.entities.filter((e) => e.domain === "binary_sensor");
      const others = g.entities.filter((e) => e.domain !== "binary_sensor");
      let html = "";
      if (binaries.length > 0) {
        html += `<div class="section"><h3>Live-Status</h3><div class="pills">${binaries.map((e) => this._ctrlHtml(e)).join("")}</div></div>`;
      }
      html += this._detectionHtml();
      if (others.length > 0) {
        html += `<div class="section"><h3>Einstellungen</h3><div class="ctrls">${others.map((e) => this._ctrlHtml(e)).join("")}</div></div>`;
      }
      return html;
    }
    return `<div class="ctrls">${g.entities.map((e) => this._ctrlHtml(e)).join("")}</div>`;
  }

  // ---------- PTZ-Steuerung (Live-Reiter) ----------

  _ptzEntities(cam) { return cam.groups.flatMap((g) => g.entities); }

  _ptzOpen() { try { return localStorage.getItem("kz_ptz_open") !== "0"; } catch (e) { return true; } }

  _ptzHtml(cam) {
    const ents = this._ptzEntities(cam);
    const p = detectPtz(ents);
    if (!p) return "";
    const ent = (eid) => ents.find((e) => e.entity_id === eid);
    const b = (name, label, cls = "") => `<button class="ptz-btn ${cls}" data-ptz="${name}" aria-label="${label}"${p.btn[name] ? "" : " disabled"}>${
      { up: "▲", down: "▼", left: "◀", right: "▶", zoom_in: "+", zoom_out: "−" }[name]}</button>`;
    const center = p.guard
      ? `<button class="ptz-btn ptz-mid" data-ptz-guard="${esc(p.guard)}" aria-label="Guard-Position">⌂</button>`
      : `<button class="ptz-btn ptz-mid" data-ptz-stop aria-label="Stopp">■</button>`;
    const dpad = p.btn.left || p.btn.right || p.btn.up || p.btn.down
      ? `<div class="dpad">${b("up", "Hoch", "u")}${b("left", "Links", "l")}${center}${b("right", "Rechts", "r")}${b("down", "Runter", "d")}</div>` : "";
    const zoomBtns = p.btn.zoom_in || p.btn.zoom_out
      ? `<div class="ptz-zoom">${b("zoom_out", "Zoom raus")}<span class="muted">Zoom</span>${b("zoom_in", "Zoom rein")}</div>` : "";
    const move = p.btn.left || p.btn.right || p.btn.up || p.btn.down || p.btn.zoom_in || p.btn.zoom_out;
    const speed = move && !p.speed
      ? `<div class="ctrl"><label>Geschwindigkeit</label><div class="in"><input type="range" class="slider" min="1" max="64" value="${this._ptzSpeed}" data-ptz-speed><span class="val" id="ptz-speed-val">${this._ptzSpeed}</span></div></div>` : "";
    const rows = [p.speed, p.zoom, p.focus, p.tracking].filter(Boolean).map((id) => this._ctrlHtml(ent(id))).join("");
    let presets = "";
    if (p.preset) {
      const opts = ((this._state(p.preset) || { attributes: {} }).attributes.options || []);
      presets = opts.length ? `<div class="pills ptz-presets" data-ps="${esc(p.preset)}">${opts.map((o) => `<button class="pill ptz-preset" data-ptz-preset="${esc(o)}">${esc(o)}</button>`).join("")}</div>` : "";
    }
    return `<details class="ptz-panel" tabindex="0" ${this._ptzOpen() ? "open" : ""}><summary>Steuerung</summary>
      ${dpad}${zoomBtns}${presets}${speed || rows ? `<div class="ctrls">${speed}${rows}</div>` : ""}</details>`;
  }

  _svc(d, s, data) {
    return this._hass.callService(d, s, data).catch((e) => this._toast(e.message || String(e)));
  }

  _ptzStart(name) {
    if (this._ptzMove) return;
    const cam = this._camera();
    const p = cam && detectPtz(this._ptzEntities(cam));
    const eid = p && p.btn[name];
    if (!eid) return;
    this._ptzMove = { stop: p.btn.stop, t0: Date.now(), name };
    this.shadowRoot.querySelectorAll(`[data-ptz="${name}"]`).forEach((x) => x.classList.add("on"));
    try { navigator.vibrate?.(10); } catch (e) { /* egal */ }
    const move = !name.startsWith("zoom") && this._hass.services?.reolink?.ptz_move;
    if (move) this._svc("reolink", "ptz_move", { entity_id: eid, speed: this._ptzSpeed });
    else this._svc("button", "press", { entity_id: eid });
  }

  /** Bewegung beenden; now=true: sofort (Sicherheitsstopp), sonst min. 250 ms Bewegung. */
  _ptzEnd(now = false) {
    const m = this._ptzMove;
    if (!m) return;
    this._ptzMove = null;
    this.shadowRoot.querySelectorAll(`[data-ptz="${m.name}"]`).forEach((x) => x.classList.remove("on"));
    if (!m.stop) return;
    const stop = () => this._svc("button", "press", { entity_id: m.stop });
    const wait = now ? 0 : Math.max(0, 250 - (Date.now() - m.t0));
    wait ? setTimeout(stop, wait) : stop();
  }

  _ptzBind(root) {
    const KEYS = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
    root.querySelectorAll("[data-ptz]").forEach((el) => {
      el.addEventListener("pointerdown", (ev) => { ev.preventDefault(); this._ptzStart(el.dataset.ptz); });
      ["pointerup", "pointerleave", "pointercancel"].forEach((t) => el.addEventListener(t, () => { if (this._ptzMove && this._ptzMove.name === el.dataset.ptz) this._ptzEnd(); }));
      el.addEventListener("contextmenu", (ev) => ev.preventDefault());
    });
    root.querySelectorAll("[data-ptz-stop]").forEach((el) => el.addEventListener("click", () => {
      const cam = this._camera(); const p = cam && detectPtz(this._ptzEntities(cam));
      if (p && p.btn.stop) this._svc("button", "press", { entity_id: p.btn.stop });
    }));
    root.querySelectorAll("[data-ptz-guard]").forEach((el) => el.addEventListener("click", () => this._svc("button", "press", { entity_id: el.dataset.ptzGuard })));
    root.querySelectorAll("[data-ptz-preset]").forEach((el) => el.addEventListener("click", () =>
      this._svc("select", "select_option", { entity_id: el.parentElement.dataset.ps, option: el.dataset.ptzPreset })));
    root.querySelectorAll("[data-ptz-speed]").forEach((el) => el.addEventListener("input", () => {
      this._ptzSpeed = Number(el.value);
      const v = root.getElementById ? root.getElementById("ptz-speed-val") : null;
      if (v) v.textContent = el.value;
    }));
    root.querySelectorAll(".ptz-panel").forEach((el) => {
      el.addEventListener("toggle", () => { try { localStorage.setItem("kz_ptz_open", el.open ? "1" : "0"); } catch (e) { /* egal */ } });
      el.addEventListener("keydown", (ev) => {
        const n = KEYS[ev.key];
        if (!n || ev.repeat || ev.target.closest("input,select")) return;
        ev.preventDefault(); this._ptzStart(n);
      });
      el.addEventListener("keyup", (ev) => { if (KEYS[ev.key]) this._ptzEnd(); });
      el.addEventListener("blur", () => this._ptzEnd(true));
    });
  }

  // ---------- Erkennung: Matrix ----------

  async _loadDetection() {
    const cam = this._cam;
    this._det = null;
    this._render();
    try {
      this._det = { cam, data: await this._hass.callWS({ type: `${DOMAIN}/detection/get`, camera_id: cam }) };
    } catch (e) {
      this._det = { cam, error: e.message || String(e) };
    }
    if (this._cam === cam && this._tab === "erkennung") this._render();
  }

  _detToggle(key, checked) {
    return `<label class="toggle-wrap"><input type="checkbox" class="toggle" data-det="${key}"${checked ? " checked" : ""}><div class="toggle-track"></div></label>`;
  }

  _detectionHtml() {
    const d = this._det && this._det.cam === this._cam ? this._det : null;
    if (!d) return `<div class="section"><h3>Erkennen &amp; Reagieren</h3><p class="muted">Lade …</p></div>`;
    if (d.error) return `<div class="section"><h3>Erkennen &amp; Reagieren</h3><p class="muted">${esc(d.error)}</p></div>`;
    const { types, actions, tracking } = d.data;
    const acts = Object.keys(DET_ACTIONS).filter((a) => actions[a]);
    const icon = (t) => `<ha-icon icon="mdi:${DET_TYPES[t][1]}"></ha-icon>`;
    let html = "";
    if (acts.length && types.length) {
      const cell = (a, t) => (t in actions[a] ? this._detToggle(`${a}:${t}`, actions[a][t]) : `<span class="muted">–</span>`);
      const table = `<table class="det-table"><thead><tr><th></th>${acts.map((a) => `<th>${DET_ACTIONS[a]}</th>`).join("")}</tr></thead><tbody>` +
        types.map((t) => `<tr><td class="det-name">${icon(t)} ${DET_TYPES[t][0]}</td>${acts.map((a) => `<td>${cell(a, t)}</td>`).join("")}</tr>`).join("") +
        `</tbody></table>`;
      const lists = types.map((t) => `<h3>${icon(t)} ${DET_TYPES[t][0]}</h3><div class="ctrls">` +
        acts.filter((a) => t in actions[a]).map((a) => `<div class="ctrl"><label>${DET_ACTIONS[a]}</label><div class="in">${this._detToggle(`${a}:${t}`, actions[a][t])}</div></div>`).join("") + `</div>`).join("");
      html += `<div class="section"><h3>Erkennen &amp; Reagieren</h3><div class="det-desktop ctrls">${table}</div><div class="det-mobile">${lists}</div>` +
        `<p class="hint">Einschalten aktiviert rund um die Uhr; Zeitpläne aus der App werden überschrieben.</p></div>`;
    }
    if (tracking && Object.keys(tracking).length) {
      html += `<div class="section"><h3>Verfolgen (Tracking)</h3><div class="ctrls">` +
        Object.keys(DET_TYPES).filter((t) => t in tracking).map((t) =>
          `<div class="ctrl"><label>${icon(t)} ${DET_TYPES[t][0]}</label><div class="in">${this._detToggle(`tracking:${t}`, tracking[t])}</div></div>`).join("") + `</div></div>`;
    }
    return html;
  }

  /** Schalter optimistisch umlegen (macht der Browser), bei Fehler zurück + Toast. */
  async _detSet(el) {
    const [action, type] = el.dataset.det.split(":");
    const enable = el.checked;
    const data = this._det.data;
    const store = action === "tracking" ? data.tracking : data.actions[action];
    const sync = () => this.shadowRoot.querySelectorAll(`[data-det="${el.dataset.det}"]`).forEach((x) => { x.checked = store[type]; });
    const before = store[type];
    store[type] = enable; sync();
    try {
      this._det.data = await this._hass.callWS({ type: `${DOMAIN}/detection/set`, camera_id: this._cam, action, detect_type: type, enable });
    } catch (e) {
      store[type] = before; sync();
      this._toast(e.message || String(e));
      return;
    }
    this.shadowRoot.querySelectorAll("[data-det]").forEach((x) => {
      const [a, t] = x.dataset.det.split(":");
      const m = a === "tracking" ? this._det.data.tracking : this._det.data.actions[a];
      if (m && t in m) x.checked = m[t];
    });
  }

  _toast(msg) {
    this._error = msg;
    const old = this.shadowRoot.getElementById("toast-err");
    if (old) old.remove();
    const el = document.createElement("div");
    el.className = "toast err"; el.id = "toast-err"; el.textContent = msg;
    this.shadowRoot.querySelector(".wrap").appendChild(el);
    setTimeout(() => { if (this._error === msg) this._error = ""; el.remove(); }, 4000);
  }

  _clipsHtml() {
    const c = this._clips;
    if (!c) return `<p class="muted">Lade Aufnahmen …</p>`;
    if (c.error) return `<p class="err">${esc(c.error)}</p>`;

    const player = this._clipSrc ? `<div class="player-modal" id="player-modal">
      <button class="close-modal" data-close-modal>✕</button>
      <video controls playsinline autoplay src="${esc(this._clipSrc)}"></video>
      <p class="clip-name">${esc(this._clipName)}</p>
    </div>` : "";

    const grouped = {};
    c.clips.forEach((x) => {
      const day = fmtDate(x.time);
      if (!grouped[day]) grouped[day] = [];
      grouped[day].push(x);
    });
    const days = Object.keys(grouped).reverse();
    const list = c.clips.length
      ? days.map((day) => {
        const clips = grouped[day].map((x) => `<li class="${x.filename === this._clipName ? "act" : ""}" data-clip="${esc(x.filename)}"><span class="time">${esc(fmtTime(x.time).split(" ")[1])}</span><span class="file">${esc(x.filename)}</span></li>`).join("");
        return `<div class="day-group"><h3>${day}</h3><ul class="clips-list">${clips}</ul></div>`;
      }).join("")
      : `<p class="muted">Keine Aufnahmen.</p>`;
    return `${player}<div class="clips-container">${list}</div>`;
  }

  /** Ein Steuerelement je Entität nach Domain; Werte setzt _updateValues(). */
  _ctrlHtml(e) {
    const id = esc(e.entity_id);
    const st = this._state(e.entity_id);
    const label = esc(e.name || (st && st.attributes.friendly_name) || e.entity_id);
    let input;
    switch (e.domain) {
      case "binary_sensor": {
        const on = st && st.state === "on";
        const isDetection = DETECTION_TYPES.some(t => label.toLowerCase().includes(t));
        const statusText = on ? "Erkannt" : "Ruhig";
        input = `<div class="pill ${on && isDetection ? "active" : ""}" data-bs="${id}">${statusText}</div>`;
        break;
      }
      case "switch": case "siren":
        input = `<label class="toggle-wrap"><input type="checkbox" class="toggle" data-act="toggle" data-e="${id}"><div class="toggle-track"></div></label>`; break;
      case "light": {
        const modes = (st && st.attributes.supported_color_modes) || [];
        const dim = modes.some((m) => m !== "onoff");
        input = `<label class="toggle-wrap"><input type="checkbox" class="toggle" data-act="toggle" data-e="${id}"><div class="toggle-track"></div></label>` +
          (dim ? `<input type="range" class="slider" min="1" max="255" data-act="brightness" data-e="${id}">` : "");
        break;
      }
      case "number": {
        const a = (st && st.attributes) || {};
        input = `<input type="range" class="slider" min="${esc(a.min ?? 0)}" max="${esc(a.max ?? 100)}" step="${esc(a.step ?? 1)}" data-act="number" data-e="${id}"><span class="val" data-val="${id}"></span>`;
        break;
      }
      case "select": {
        const opts = ((st && st.attributes.options) || []).map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("");
        input = `<select class="dropdown" data-act="select" data-e="${id}">${opts}</select>`; break;
      }
      case "button":
        input = `<button class="btn-pill" data-act="press" data-e="${id}">Ausführen</button>`; break;
      case "update":
        input = `<span class="val" data-val="${id}"></span>`; break;
      default: // sensor, sonstige: nur Anzeige
        input = `<span class="val" data-val="${id}"></span>`;
    }
    return `<div class="ctrl"><label>${label}</label><div class="in">${input}</div></div>`;
  }

  _mountStream() {
    const cam = this._camera();
    const live = cam && this._liveEntity(cam);
    const st = live && this._state(live.entity_id);
    if (!st || !customElements.get("ha-camera-stream")) return; // Fallback: Standbild-Refresh
    const el = document.createElement("ha-camera-stream");
    el.hass = this._hass; el.stateObj = st; el.controls = true;
    el.className = "big";
    const box = this.shadowRoot.getElementById("stream");
    box.innerHTML = ""; box.appendChild(el);
  }

  /** Werte aus hass.states in vorhandene Elemente schreiben (ohne Neuaufbau, Fokus bleibt). */
  _updateValues() {
    if (!this._hass) return;
    const root = this.shadowRoot;
    const stream = root.querySelector("ha-camera-stream");
    if (stream) { stream.hass = this._hass; stream.stateObj = this._state(stream.stateObj.entity_id) || stream.stateObj; }

    root.querySelectorAll("[data-bs]").forEach((el) => {
      const st = this._state(el.dataset.bs);
      if (!st) return;
      const on = st.state === "on";
      const label = el.parentElement.querySelector("label");
      const isDetection = label && DETECTION_TYPES.some(t => label.textContent.toLowerCase().includes(t));
      el.textContent = on ? "Erkannt" : "Ruhig";
      el.classList.toggle("active", on && isDetection);
    });

    root.querySelectorAll("[data-ps]").forEach((box) => {
      const st = this._state(box.dataset.ps);
      box.querySelectorAll("[data-ptz-preset]").forEach((b) => b.classList.toggle("active", !!st && st.state === b.dataset.ptzPreset));
    });

    root.querySelectorAll("[data-e]").forEach((el) => {
      const st = this._state(el.dataset.e);
      if (!st || root.activeElement === el) return;
      const on = st.state === "on";
      switch (el.dataset.act) {
        case "toggle": el.checked = on; break;
        case "brightness": el.value = st.attributes.brightness ?? 255; el.disabled = !on; break;
        case "number": el.value = st.state; break;
        case "select": el.value = st.state; break;
      }
      el.disabled = el.disabled || st.state === "unavailable";
    });
    root.querySelectorAll("[data-val]").forEach((el) => {
      const st = this._state(el.dataset.val);
      if (!st) { el.textContent = "–"; return; }
      const unit = st.attributes.unit_of_measurement ? ` ${st.attributes.unit_of_measurement}` : "";
      if (st.entity_id.startsWith("update.")) {
        el.textContent = st.attributes.installed_version
          ? `${st.attributes.installed_version}${st.state === "on" ? ` → ${st.attributes.latest_version}` : " (aktuell)"}` : st.state;
      } else {
        el.textContent = `${st.state}${unit}`;
      }
    });
  }

  // ---------- Events ----------

  _bind() {
    const root = this.shadowRoot;
    const $ = (sel, fn) => root.querySelectorAll(sel).forEach(fn);
    $("[data-open]", (el) => el.addEventListener("click", () => { this._cam = el.dataset.open; this._tab = "live"; this._error = ""; this._render(); }));
    $("[data-back]", (el) => el.addEventListener("click", () => { this._cam = null; this._clips = null; this._clipSrc = ""; this._error = ""; this._render(); }));
    $("[data-tab]", (el) => el.addEventListener("click", () => {
      this._tab = el.dataset.tab; this._error = "";
      if (this._tab === "aufnahmen") this._loadClips();
      else if (this._tab === "erkennung") this._loadDetection();
      else this._render();
    }));
    this._ptzBind(root);
    $("[data-det]", (el) => el.addEventListener("change", () => this._detSet(el)));
    $("[data-clip]", (el) => el.addEventListener("click", () => this._play(el.dataset.clip)));
    $("[data-close-modal]", (el) => el.addEventListener("click", () => { this._clipSrc = ""; this._clipName = ""; this._render(); }));
    $("[data-act]", (el) => {
      const eid = el.dataset.e;
      const dom = eid.split(".")[0];
      const call = (d, s, data) => this._hass.callService(d, s, data).catch((e) => { this._error = e.message || String(e); this._render(); });
      const act = el.dataset.act;
      if (act === "press") el.addEventListener("click", () => call("button", "press", { entity_id: eid }));
      else if (act === "toggle") el.addEventListener("change", () => call(dom, el.checked ? "turn_on" : "turn_off", { entity_id: eid }));
      else if (act === "brightness") el.addEventListener("change", () => call("light", "turn_on", { entity_id: eid, brightness: Number(el.value) }));
      else if (act === "number") {
        el.addEventListener("input", () => { const v = root.querySelector(`[data-val="${eid}"]`); if (v) v.textContent = el.value; });
        el.addEventListener("change", () => call("number", "set_value", { entity_id: eid, value: Number(el.value) }));
      } else if (act === "select") el.addEventListener("change", () => call("select", "select_option", { entity_id: eid, option: el.value }));
    });
  }
}

const STYLE = `
  :host {
    display: block;
    background: var(--primary-background-color, #fff);
    color: var(--primary-text-color, #000);
    min-height: 100%;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif;
    font-size: 16px;
  }
  .wrap {
    padding: max(16px, env(safe-area-inset-left)) max(16px, env(safe-area-inset-right));
    max-width: 1200px;
    margin: 0 auto;
  }
  h1 { font-size: 2.125em; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.02em; }
  h3 { font-size: 0.8125em; font-weight: 600; text-transform: uppercase; color: var(--secondary-text-color, #999); margin: 24px 0 12px; letter-spacing: 0.5px; }
  .muted { color: var(--secondary-text-color, #999); font-size: 0.9375em; }
  .err { background: var(--error-color, #ef5350); color: #fff; border-radius: 20px; padding: 8px 12px; font-size: 0.9375em; display: inline-block; }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
  }
  .tile {
    background: var(--card-background-color, #f5f5f5);
    border-radius: 20px;
    overflow: hidden;
    cursor: pointer;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    transition: all 150ms ease;
  }
  .tile:active { transform: scale(0.98); }
  .tile img, .noimg {
    width: 100%;
    aspect-ratio: 16/9;
    object-fit: cover;
    display: block;
    background: #000;
  }
  .noimg {
    color: #aaa;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.9375em;
  }
  .meta {
    padding: 12px 14px;
    display: flex;
    align-items: center;
    gap: 10px;
    background: rgba(0, 0, 0, 0.3);
    backdrop-filter: blur(20px) saturate(180%);
    color: #fff;
  }
  .meta b { flex: 1; font-weight: 600; font-size: 0.9375em; }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .dot.on { background: #30d158; box-shadow: 0 0 8px rgba(48, 209, 88, 0.5); }
  .dot.off { background: #aaa; }

  .head {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    margin-bottom: 16px;
    padding-top: max(0, env(safe-area-inset-top));
  }
  .back-btn {
    background: transparent;
    color: var(--primary-color, #0a84ff);
    border: 0;
    padding: 8px 0;
    font: inherit;
    cursor: pointer;
    font-size: 1.0625em;
    white-space: nowrap;
    flex-shrink: 0;
    transition: opacity 150ms ease;
  }
  .back-btn:active { opacity: 0.6; }
  .head-title { flex: 1; }
  .head-title h1 { margin: 0 0 2px; }
  .subhead { font-size: 0.8125em; color: var(--secondary-text-color, #999); margin: 0; }

  .tabs-seg {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    margin-bottom: 20px;
    padding: 0 max(0, env(safe-area-inset-left)) 0 max(0, env(safe-area-inset-right));
    scrollbar-width: none;
  }
  .tabs-seg::-webkit-scrollbar { display: none; }
  .tab {
    background: transparent;
    color: var(--secondary-text-color, #999);
    border: 0;
    padding: 8px 14px;
    font: inherit;
    cursor: pointer;
    font-size: 0.9375em;
    white-space: nowrap;
    border-bottom: 2px solid transparent;
    transition: all 150ms ease;
  }
  .tab.act {
    color: var(--primary-text-color, #000);
    border-bottom-color: var(--primary-color, #0a84ff);
    font-weight: 600;
  }

  .body { animation: fadeIn 150ms ease; }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  #stream, .big {
    width: 100%;
    aspect-ratio: 16/9;
    background: #000;
    border-radius: 20px;
    display: block;
    overflow: hidden;
  }
  .big { max-height: 75vh; object-fit: contain; }

  .section { margin-bottom: 24px; }
  .pills { display: flex; flex-wrap: wrap; gap: 10px; }
  .pill {
    background: var(--card-background-color, #f5f5f5);
    color: var(--secondary-text-color, #999);
    border: 0;
    padding: 8px 12px;
    border-radius: 20px;
    font-size: 0.8125em;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .pill::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--secondary-text-color, #999);
    flex-shrink: 0;
  }
  .pill.active {
    background: var(--primary-color, #0a84ff);
    color: #fff;
    font-weight: 600;
  }
  .pill.active::before { background: #fff; }

  .ctrls {
    display: flex;
    flex-direction: column;
    background: var(--card-background-color, #f5f5f5);
    border-radius: 18px;
    overflow: hidden;
  }
  .ctrl {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px;
    border-bottom: 1px solid rgba(0, 0, 0, 0.1);
  }
  .ctrl:last-child { border-bottom: 0; }
  .ctrl > label {
    font-size: 1.0625em;
    flex: 1;
  }
  .ctrl .in {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .toggle-wrap {
    position: relative;
    display: inline-block;
    width: 51px;
    height: 31px;
  }
  .toggle {
    display: none;
  }
  .toggle-track {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: #ccc;
    border-radius: 15.5px;
    cursor: pointer;
    transition: background 250ms ease;
  }
  .toggle-track::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 27px;
    height: 27px;
    background: #fff;
    border-radius: 50%;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
    transition: left 250ms ease;
  }
  .toggle:checked ~ .toggle-track { background: #30d158; }
  .toggle:checked ~ .toggle-track::after { left: 22px; }
  .toggle:disabled ~ .toggle-track { opacity: 0.5; }

  .hint { font-size: 0.75em; color: var(--secondary-text-color, #999); margin: 8px 4px 0; }
  .det-table { width: 100%; border-collapse: collapse; }
  .det-table th { font-size: 0.8125em; font-weight: 600; color: var(--secondary-text-color, #999); padding: 12px 16px 6px; text-align: center; }
  .det-table td { padding: 10px 16px; text-align: center; border-top: 1px solid rgba(0, 0, 0, 0.1); }
  .det-table td.det-name { text-align: left; font-size: 1.0625em; }
  .det-table td .toggle-wrap { vertical-align: middle; }
  ha-icon { --mdc-icon-size: 20px; vertical-align: middle; color: var(--secondary-text-color, #999); }
  h3 ha-icon { margin-right: 4px; }
  .det-mobile { display: none; }

  .slider {
    width: 140px;
    height: 4px;
    background: rgba(0, 0, 0, 0.1);
    border-radius: 2px;
    outline: 0;
    cursor: pointer;
    -webkit-appearance: none;
    appearance: none;
  }
  .slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 24px;
    height: 24px;
    background: var(--primary-color, #0a84ff);
    border-radius: 50%;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  }
  .slider::-moz-range-thumb {
    width: 24px;
    height: 24px;
    background: var(--primary-color, #0a84ff);
    border-radius: 50%;
    cursor: pointer;
    border: 0;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  }

  .dropdown {
    appearance: none;
    -webkit-appearance: none;
    background: transparent;
    border: 0;
    color: inherit;
    font: inherit;
    font-size: 1.0625em;
    cursor: pointer;
    padding-right: 20px;
    background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e");
    background-repeat: no-repeat;
    background-position: right 0 center;
    background-size: 16px;
  }

  .btn-pill {
    background: var(--primary-color, #0a84ff);
    color: #fff;
    border: 0;
    border-radius: 20px;
    padding: 8px 14px;
    font: inherit;
    font-size: 0.9375em;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 150ms ease;
  }
  .btn-pill:active { opacity: 0.7; }

  .val {
    color: var(--secondary-text-color, #999);
    text-align: right;
    font-size: 0.9375em;
  }

  .clips-container { animation: fadeIn 150ms ease; }
  .day-group { margin-bottom: 20px; }
  .day-group h3 { margin: 0 0 8px; }
  .clips-list {
    list-style: none;
    padding: 0;
    margin: 0;
    background: var(--card-background-color, #f5f5f5);
    border-radius: 18px;
    overflow: hidden;
  }
  .clips-list li {
    padding: 12px 16px;
    border-bottom: 1px solid rgba(0, 0, 0, 0.1);
    cursor: pointer;
    display: flex;
    gap: 10px;
    align-items: center;
    transition: all 150ms ease;
  }
  .clips-list li:last-child { border-bottom: 0; }
  .clips-list li:active { background: rgba(0, 0, 0, 0.05); }
  .clips-list li.act { background: var(--primary-color, #0a84ff); color: #fff; font-weight: 600; }
  .clips-list li.act .file { opacity: 0.8; }
  .time { font-weight: 600; min-width: 50px; }
  .file { font-size: 0.8125em; color: var(--secondary-text-color, #999); }
  .clips-list li.act .file { color: rgba(255, 255, 255, 0.8); }

  .player-modal {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.9);
    z-index: 1000;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
  }
  .close-modal {
    position: absolute;
    top: max(12px, env(safe-area-inset-top));
    right: max(12px, env(safe-area-inset-right));
    background: transparent;
    border: 0;
    color: #fff;
    cursor: pointer;
    font-size: 1.5em;
    width: 44px;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1001;
  }
  .player-modal video {
    width: 100%;
    max-height: 80vh;
    max-width: 100%;
    border-radius: 16px;
    background: #000;
  }
  .clip-name {
    color: rgba(255, 255, 255, 0.8);
    font-size: 0.8125em;
    margin-top: 12px;
  }

  .toast {
    position: fixed;
    bottom: max(16px, env(safe-area-inset-bottom));
    left: max(16px, env(safe-area-inset-left));
    right: max(16px, env(safe-area-inset-right));
    animation: slideUp 300ms ease;
    z-index: 999;
  }
  @keyframes slideUp { from { transform: translateY(100px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

  .live-wrap { display: grid; grid-template-columns: 1fr; gap: 16px; align-items: start; }
  .ptz-panel {
    background: var(--card-background-color, #f5f5f5);
    border-radius: 20px;
    padding: 4px 16px 16px;
    outline: 0;
    backdrop-filter: blur(20px) saturate(180%);
  }
  .ptz-panel summary { cursor: pointer; padding: 14px 0; min-height: 44px; box-sizing: border-box; font-weight: 600; }
  .ptz-panel > * + * { margin-top: 14px; }
  .dpad {
    position: relative; width: 180px; height: 180px; margin: 0 auto;
    display: grid; grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(3, 1fr);
    border-radius: 50%; background: rgba(127, 127, 127, 0.14);
    box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.15);
    touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  }
  .ptz-btn {
    border: 0; background: transparent; color: var(--primary-text-color, #000); font: inherit; font-size: 1.1em;
    min-width: 44px; min-height: 44px; cursor: pointer; border-radius: 50%;
    touch-action: none; user-select: none; -webkit-user-select: none; -webkit-tap-highlight-color: transparent;
    transition: background 100ms ease, transform 100ms ease;
  }
  .ptz-btn:disabled { opacity: 0.3; cursor: default; }
  .ptz-btn:active:not(:disabled), .ptz-btn.on { background: var(--primary-color, #0a84ff); color: #fff; transform: scale(0.94); }
  .dpad .u { grid-area: 1 / 2; } .dpad .l { grid-area: 2 / 1; } .dpad .r { grid-area: 2 / 3; } .dpad .d { grid-area: 3 / 2; }
  .dpad .ptz-mid { grid-area: 2 / 2; background: var(--card-background-color, #fff); box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25); }
  .ptz-zoom { display: flex; align-items: center; justify-content: center; gap: 16px; }
  .ptz-zoom .ptz-btn { width: 56px; height: 44px; border-radius: 22px; background: rgba(127, 127, 127, 0.14); font-size: 1.4em; touch-action: none; }
  .ptz-presets { justify-content: center; }
  .ptz-preset { cursor: pointer; min-height: 44px; padding: 8px 14px; font: inherit; font-size: 0.8125em; }
  .ptz-preset::before { display: none; }
  .ptz-preset:active { opacity: 0.7; }

  @media (min-width: 900px) {
    .live-wrap { grid-template-columns: 1fr 320px; }
  }

  @media (prefers-reduced-motion) {
    * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  }

  @media (max-width: 600px) {
    .wrap { padding: max(12px, env(safe-area-inset-left)) max(12px, env(safe-area-inset-right)); }
    h1 { font-size: 1.75em; }
    .head { gap: 12px; }
    .back-btn { padding: 4px 0; }
    .grid { grid-template-columns: 1fr; gap: 10px; }
    .det-desktop { display: none; }
    .det-mobile { display: block; }
    .det-mobile h3 { margin: 16px 0 8px; }
    .ctrl { padding: 12px 14px; }
    .ctrl > label { font-size: 1em; }
    .slider { width: 120px; }
  }
`;

customElements.define("kamera-zentrale-panel", KameraZentralePanel);
