/* Kamera-Zentrale – Panel (Web-Component, kein Build-Schritt).
 * Daten: WebSocket kamera_zentrale/cameras/list + clips/list, Werte live aus hass.states,
 * Schreiben ausschließlich über normale HA-Dienste (hass.callService).
 */
const DOMAIN = "kamera_zentrale";
const TABS = [
  ["live", "Live"], ["aufnahmen", "Aufnahmen"], ["licht", "Licht"], ["erkennung", "Erkennung"],
  ["aufnahme", "Aufnahme"], ["ptz", "PTZ"], ["audio", "Audio"], ["system", "System"], ["sonstiges", "Sonstiges"],
];
const REFRESH_MS = 2000;

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTime = (iso) => new Date(iso).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "medium" });

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
    this._timer = null;
    this._params = new URLSearchParams(location.search);
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._load();
    else this._updateValues();
  }

  connectedCallback() {
    this._timer = setInterval(() => this._refreshImages(), REFRESH_MS);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
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
    return `<div class="head"><button data-back>←</button><h1>${esc(cam.name)}</h1>
      <span class="muted">${esc(cam.model || "")} ${esc(cam.sw_version || "")}</span></div>
      <div class="tabs">${nav}</div>
      ${this._error ? `<p class="err">${esc(this._error)}</p>` : ""}
      <div class="body">${this._tabHtml(cam)}</div>`;
  }

  _tabHtml(cam) {
    if (this._tab === "live") {
      const live = this._liveEntity(cam);
      if (!live) return `<p class="muted">Keine Kamera-Entität.</p>`;
      return `<div id="stream"><img class="big" data-cam="${esc(live.entity_id)}" src="${esc(this._imgUrl(live.entity_id))}" alt=""></div>`;
    }
    if (this._tab === "aufnahmen") return this._clipsHtml();
    const g = cam.groups.find((x) => x.key === this._tab);
    return g ? `<div class="ctrls">${g.entities.map((e) => this._ctrlHtml(e)).join("")}</div>` : "";
  }

  _clipsHtml() {
    const c = this._clips;
    if (!c) return `<p class="muted">Lade Aufnahmen …</p>`;
    if (c.error) return `<p class="err">${esc(c.error)}</p>`;
    const player = this._clipSrc
      ? `<video controls playsinline autoplay src="${esc(this._clipSrc)}"></video><p class="muted">${esc(this._clipName)}</p>` : "";
    const list = c.clips.length
      ? c.clips.map((x) => `<li class="${x.filename === this._clipName ? "act" : ""}" data-clip="${esc(x.filename)}">${esc(fmtTime(x.time))}</li>`).join("")
      : `<li class="muted">Keine Aufnahmen.</li>`;
    return `${player}<ul class="clips">${list}</ul>`;
  }

  /** Ein Steuerelement je Entität nach Domain; Werte setzt _updateValues(). */
  _ctrlHtml(e) {
    const id = esc(e.entity_id);
    const st = this._state(e.entity_id);
    const label = esc(e.name || (st && st.attributes.friendly_name) || e.entity_id);
    let input;
    switch (e.domain) {
      case "switch": case "siren":
        input = `<input type="checkbox" data-act="toggle" data-e="${id}">`; break;
      case "light": {
        const modes = (st && st.attributes.supported_color_modes) || [];
        const dim = modes.some((m) => m !== "onoff");
        input = `<input type="checkbox" data-act="toggle" data-e="${id}">` +
          (dim ? `<input type="range" min="1" max="255" data-act="brightness" data-e="${id}">` : "");
        break;
      }
      case "number": {
        const a = (st && st.attributes) || {};
        input = `<input type="range" min="${esc(a.min ?? 0)}" max="${esc(a.max ?? 100)}" step="${esc(a.step ?? 1)}" data-act="number" data-e="${id}"><span class="val" data-val="${id}"></span>`;
        break;
      }
      case "select": {
        const opts = ((st && st.attributes.options) || []).map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("");
        input = `<select data-act="select" data-e="${id}">${opts}</select>`; break;
      }
      case "button":
        input = `<button data-act="press" data-e="${id}">Ausführen</button>`; break;
      case "update":
        input = `<span class="val" data-val="${id}"></span>`; break;
      default: // sensor, binary_sensor, sonstige: nur Anzeige
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
      if (this._tab === "aufnahmen") this._loadClips(); else this._render();
    }));
    $("[data-clip]", (el) => el.addEventListener("click", () => this._play(el.dataset.clip)));
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
  :host { display: block; background: var(--primary-background-color); color: var(--primary-text-color); min-height: 100%; font-family: var(--paper-font-body1_-_font-family, sans-serif); }
  .wrap { padding: 16px; max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 1.4em; margin: 0 0 12px; }
  .muted { color: var(--secondary-text-color); } .err { color: var(--error-color, #db4437); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
  .tile { background: var(--card-background-color); border-radius: 12px; overflow: hidden; cursor: pointer; box-shadow: var(--ha-card-box-shadow, 0 1px 3px #0003); }
  .tile img, .noimg { width: 100%; aspect-ratio: 16/9; object-fit: cover; display: block; background: #000; }
  .noimg { color: #888; display: flex; align-items: center; justify-content: center; }
  .meta { padding: 8px 12px; display: flex; align-items: center; gap: 8px; } .meta b { flex: 1; }
  .dot { width: 10px; height: 10px; border-radius: 50%; } .dot.on { background: var(--success-color, #43a047); } .dot.off { background: var(--error-color, #db4437); }
  .head { display: flex; align-items: center; gap: 12px; } .head h1 { margin: 0; }
  button { background: var(--primary-color); color: var(--text-primary-color, #fff); border: 0; border-radius: 8px; padding: 8px 14px; font: inherit; cursor: pointer; }
  .tabs { display: flex; gap: 6px; overflow-x: auto; margin: 12px 0; }
  .tab { background: var(--card-background-color); color: var(--primary-text-color); white-space: nowrap; }
  .tab.act { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .big { width: 100%; max-height: 75vh; object-fit: contain; background: #000; border-radius: 12px; display: block; }
  video { width: 100%; max-height: 70vh; background: #000; border-radius: 12px; }
  .clips { list-style: none; padding: 0; margin: 12px 0; }
  .clips li { padding: 12px; border-bottom: 1px solid var(--divider-color); cursor: pointer; } .clips li.act { background: var(--secondary-background-color); font-weight: 600; }
  .ctrl { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 0; border-bottom: 1px solid var(--divider-color); }
  .ctrl .in { display: flex; align-items: center; gap: 10px; } input[type=range] { min-width: 140px; } select { font: inherit; padding: 6px; }
  .val { min-width: 3em; text-align: right; }
  @media (max-width: 600px) { .wrap { padding: 8px; } .ctrl { flex-direction: column; align-items: stretch; } }
`;

customElements.define("kamera-zentrale-panel", KameraZentralePanel);
