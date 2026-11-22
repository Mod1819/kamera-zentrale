/* Kamera-Zentrale – Panel v0.4.1 (iOS/macOS Design)
 * Daten: WebSocket kamera_zentrale/cameras/list + clips/list + detection/get|set + links/*, Werte live aus hass.states,
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
const fmtDate = (iso) => { const d = new Date(iso); const t = new Date(); const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); const diff = Math.round((day(t) - day(d)) / 86400000); if (diff === 0) return "Heute"; if (diff === 1) return "Gestern"; return d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" }); };

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

/** Objektive einer Kamera ermitteln (reine Funktion). `entities` = flache Liste {entity_id, domain, translation_key}.
 *  Gruppiert nach translation_key `main|sub_lens_<N>`; pro N gewinnt main_lens_N. Ohne Objektiv-Entitäten: eine Ansicht
 *  (erste camera-Entität, Label ""). Ergebnis: [{index, label, entity_id}] nach index sortiert. */
const LENS_NAMES = ["Weitwinkel", "Tele"];
function lensesOf(entities) {
  const cams = (entities || []).filter((e) => e.domain === "camera");
  const by = new Map();
  cams.forEach((e) => {
    const m = /^(main|sub)_lens_(\d+)$/.exec(e.translation_key || "");
    if (!m) return;
    const i = Number(m[2]);
    const cur = by.get(i);
    if (!cur || (m[1] === "main" && cur.kind !== "main")) by.set(i, { index: i, kind: m[1], entity_id: e.entity_id });
  });
  if (!by.size) return cams.length ? [{ index: 0, label: "", entity_id: cams[0].entity_id }] : [];
  return [...by.values()].sort((a, b) => a.index - b.index)
    .map(({ index, entity_id }) => ({ index, label: LENS_NAMES[index] || `Objektiv ${index}`, entity_id }));
}

/** Passenden Clip zu einer Bewegung wählen (reine Funktion). `at` = "YYYYMMDDHHMMSS" (lokale Zeit), `clips` = [{filename, time(ISO lokal)}].
 *  play: Start in [at-90s, at+30s], zeitlich nächster. wait: kein Kandidat und neuester Clip (oder keiner) vor at-90s.
 *  fallback: neuester Clip nach at+30s -> nächster Clip mit Start <= at (clip fehlt, wenn es keinen gibt). */
const AT_BEFORE_MS = 90000, AT_AFTER_MS = 30000;
function parseAt(at) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(at || ""));
  if (!m) return NaN;
  const d = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return d.getMonth() === m[2] - 1 ? d.getTime() : NaN; // 13. Monat etc. ablehnen
}
function pickClip(clips, at) {
  const t = typeof at === "number" ? at : parseAt(at);
  const list = (clips || []).map((c) => ({ c, t: new Date(c.time).getTime() })).filter((x) => !isNaN(x.t));
  const cands = list.filter((x) => x.t >= t - AT_BEFORE_MS && x.t <= t + AT_AFTER_MS);
  if (cands.length) return { state: "play", clip: cands.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a)).c };
  const newest = Math.max(-Infinity, ...list.map((x) => x.t));
  if (newest < t - AT_BEFORE_MS) return { state: "wait" };
  const before = list.filter((x) => x.t <= t);
  return before.length ? { state: "fallback", clip: before.reduce((a, b) => (b.t > a.t ? b : a)).c } : { state: "fallback" };
}

const AT_TIMEOUT_MS = 6 * 60000, AT_POLL_MS = 5000;

const LINK_TRIGGER_DOMAINS = ["light", "switch", "binary_sensor", "event", "input_boolean"];
const LINK_TARGET_DOMAINS = ["light", "switch", "siren"];
const LINK_SUGGESTION = {
  name: "Ring Garten-Licht → TrackMix-Scheinwerfer", trigger_entity: "light.garten_light",
  target_entities: ["light.garten_scheinwerfer"], mode: "follow", hold_seconds: 0, only_dark: false, enabled: true,
};

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
    this._page = null; // "links" = Verbund-Seite
    this._links = null; // Regelliste | {error}
    this._sheet = null; // Entwurf der Kopplung im Bottom-Sheet
    this._at = null; // Push-Link: {at, deadline, state: "wait"|"none"}
    this._atTimer = null;
    this._clipNote = "";
    this._onVis = () => {
      if (document.hidden) { this._ptzEnd(true); clearTimeout(this._atTimer); }
      else if (this._at && this._at.state === "wait") this._atPoll();
    };
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
    clearTimeout(this._atTimer);
  }

  async _load() {
    try {
      const res = await this._hass.callWS({ type: `${DOMAIN}/cameras/list` });
      this._cameras = res.cameras;
      const want = this._params.get("camera");
      if (want && this._cameras.some((c) => c.id === want)) {
        this._cam = want;
        if (parseAt(this._params.get("at")) > 0) {
          this._tab = "aufnahmen";
          this._at = { at: this._params.get("at"), deadline: Date.now() + AT_TIMEOUT_MS, state: "wait" };
          await this._loadClips();
          this._atEval();
          return;
        }
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
  _lenses(cam) { return lensesOf(cam.groups.flatMap((g) => g.entities)); }
  _sortOldest() { try { return localStorage.getItem("kz_sort") === "old"; } catch (e) { return false; } }
  _lensGet(id) { try { return Number(localStorage.getItem(`kz_lens_${id}`)); } catch (e) { return NaN; } }
  _lensSet(id, i) { try { localStorage.setItem(`kz_lens_${id}`, String(i)); } catch (e) { /* egal */ } }
  /** Anzuzeigende Kamera-Entität: Live = gemerktes Objektiv, Übersicht (overview) = Weitwinkel (Index 0). */
  _liveEntity(cam, overview = false) {
    const ls = this._lenses(cam);
    const want = overview ? 0 : this._lensGet(cam.id);
    return ls.find((l) => l.index === want) || ls[0];
  }
  _selectLens(cam, idx) {
    this._lensSet(cam.id, idx);
    const live = this._liveEntity(cam);
    const box = this.shadowRoot.getElementById("stream");
    if (box && live) { box.innerHTML = this._streamInner(live); this._mountStream(); }
    this.shadowRoot.querySelectorAll("[data-lens]").forEach((b) => b.classList.toggle("act", Number(b.dataset.lens) === idx));
  }
  /** Zoom/Steuerkreuz benutzt -> Tele (Index 1), falls vorhanden. */
  _autoTele() {
    const cam = this._camera();
    if (!cam) return;
    const tele = this._lenses(cam).find((l) => l.index === 1);
    if (tele && this._liveEntity(cam).index !== 1) this._selectLens(cam, 1);
  }
  _streamInner(live) { return `<img class="big" data-cam="${esc(live.entity_id)}" src="${esc(this._imgUrl(live.entity_id))}" alt="">`; }
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

  /** Push-Link auswerten: abspielen / weiter warten / Fallback / Zeitüberschreitung. */
  _atEval() {
    const a = this._at;
    if (!a) return;
    clearTimeout(this._atTimer);
    const r = this._clips && this._clips.clips ? pickClip(this._clips.clips, a.at) : { state: "wait" };
    if (r.state === "wait" && !(this._clips && this._clips.error) && Date.now() < a.deadline) {
      this._render();
      if (!document.hidden) this._atTimer = setTimeout(() => this._atPoll(), AT_POLL_MS);
      return;
    }
    this._atDone();
    if (r.clip && r.state === "play") {
      this._at = null;
      this._clipNote = "";
      this._play(r.clip.filename);
    } else {
      this._at = { ...a, state: "none" };
      this._render();
    }
  }

  async _atPoll() {
    const a = this._at;
    if (!a || a.state !== "wait" || !this._cam) return;
    try {
      this._clips = await this._hass.callWS({ type: `${DOMAIN}/clips/list`, camera_id: this._cam });
    } catch (e) { /* nächster Versuch in 5 s */ }
    if (this._at === a) this._atEval();
  }

  /** Warten beenden; at/clip aus URL entfernen, damit Neuladen nicht erneut wartet. */
  _atDone() {
    clearTimeout(this._atTimer);
    if (this._at) this._at = { ...this._at, state: "none" };
    this._params.delete("at"); this._params.delete("clip");
    try {
      const u = new URL(location.href);
      u.searchParams.delete("at"); u.searchParams.delete("clip");
      history.replaceState(history.state, "", u);
    } catch (e) { /* egal */ }
  }

  _atStop() { this._atDone(); this._at = null; }

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
    if (cam) return this._detailHtml(cam);
    return this._page === "links" ? this._linksHtml() : this._overviewHtml();
  }

  _overviewHtml() {
    const head = `<div class="ov-head"><h1>Kameras</h1><button class="btn-pill ghost" data-links><ha-icon icon="mdi:link-variant"></ha-icon> Verbund</button></div>`;
    if (!this._cameras.length) return `${head}<p class="muted">Keine Reolink-Kameras gefunden.</p>`;
    const tiles = this._cameras.map((c) => {
      const live = this._liveEntity(c, true);
      const st = live && this._state(live.entity_id);
      const online = st && st.state !== "unavailable";
      return `<div class="tile" data-open="${esc(c.id)}">
        ${live ? `<img data-cam="${esc(live.entity_id)}" src="${esc(this._imgUrl(live.entity_id))}" alt="">` : `<div class="noimg">kein Bild</div>`}
        <div class="meta"><b>${esc(c.name)}</b><span class="dot ${online ? "on" : "off"}"></span>${online ? "online" : "offline"}</div>
      </div>`;
    });
    return `${head}<div class="grid">${tiles.join("")}</div>`;
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
      const lenses = this._lenses(cam);
      const seg = lenses.length > 1
        ? `<div class="seg lens-seg">${lenses.map((l) => `<button class="${l.index === live.index ? "act" : ""}" data-lens="${l.index}">${esc(l.label)}</button>`).join("")}</div>` : "";
      const stream = `${seg}<div id="stream">${this._streamInner(live)}</div>`;
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
    this._autoTele();
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

  // ---------- Verbund (Kopplungen) ----------

  _isAdmin() { return !!(this._hass && this._hass.user && this._hass.user.is_admin); }
  _fname(eid) { const st = this._state(eid); return (st && st.attributes.friendly_name) || eid; }
  _entIds(domains) { return Object.keys(this._hass.states).filter((e) => domains.includes(e.split(".")[0])); }

  async _loadLinks(blank = true) {
    if (blank) this._links = null;
    this._render();
    try {
      this._links = await this._hass.callWS({ type: `${DOMAIN}/links/list` });
    } catch (e) {
      this._links = { error: e.message || String(e) };
    }
    this._render();
  }

  /** Re-Render der Verbund-Seite mit erhaltener Scrollposition des Sheets. */
  _linksRender() {
    const old = this.shadowRoot.querySelector(".sheet");
    const top = old ? old.scrollTop : 0;
    this._render();
    const sheet = this.shadowRoot.querySelector(".sheet");
    if (sheet) sheet.scrollTop = top;
  }

  async _linkCall(type, data, ok) {
    try {
      await this._hass.callWS({ type: `${DOMAIN}/links/${type}`, ...data });
    } catch (e) {
      this._toast(e.message || String(e));
      return false;
    }
    if (ok) this._toast(ok);
    return true;
  }

  _linksHtml() {
    const L = this._links;
    const admin = this._isAdmin();
    const head = `<div class="head"><button class="back-btn" data-links-back>‹ Kameras</button><div class="head-title"><h1>Verbund</h1>
      <p class="subhead">Geräte miteinander koppeln</p></div>${admin ? `<button class="btn-pill" data-rule-new>+ Neue Kopplung</button>` : ""}</div>`;
    if (!L) return `${head}<p class="muted">Lade Kopplungen …</p>`;
    if (L.error) return `${head}<p class="err">${esc(L.error)}</p>`;
    const S = LINK_SUGGESTION;
    const st = this._hass.states;
    const sug = admin && st[S.trigger_entity] && st[S.target_entities[0]]
      && !L.rules.some((r) => r.trigger_entity === S.trigger_entity && r.target_entities.includes(S.target_entities[0]))
      ? `<div class="section"><h3>Vorschlag</h3><div class="ctrls"><div class="ctrl"><label>${esc(S.name)}</label>
        <div class="in"><button class="btn-pill" data-rule-sug>Anlegen</button></div></div></div></div>` : "";
    const rows = L.rules.map((r) => {
      const info = `${r.mode === "pulse" ? "Impuls" : "Mitlaufen"} · Nachlauf ${r.hold_seconds} s${r.only_dark ? " · nur bei Dunkelheit" : ""}`;
      return `<div class="ctrl rule"><label><b>${esc(r.name)}</b><span class="muted rule-sub">Wenn ${esc(this._fname(r.trigger_entity))} → ${esc(r.target_entities.map((t) => this._fname(t)).join(", "))}</span>
        <span class="hint">${esc(info)}</span></label><div class="in">
        <label class="toggle-wrap"><input type="checkbox" class="toggle" data-rule-en="${esc(r.id)}"${r.enabled ? " checked" : ""}${admin ? "" : " disabled"}><div class="toggle-track"></div></label>
        ${admin ? `<button class="icon-btn" data-rule-edit="${esc(r.id)}" aria-label="Bearbeiten"><ha-icon icon="mdi:pencil"></ha-icon></button>
        <button class="icon-btn" data-rule-del="${esc(r.id)}" aria-label="Löschen"><ha-icon icon="mdi:delete"></ha-icon></button>` : ""}</div></div>`;
    }).join("");
    const list = L.rules.length ? `<div class="ctrls">${rows}</div>` : `<p class="muted">Noch keine Kopplungen.</p>`;
    return `${head}${sug}${list}${this._sheet ? this._sheetHtml() : ""}`;
  }

  /** Auswahlzeilen für Auslöser (kind="trig") oder Ziele (kind="tgt"), gefiltert nach Suchtext. */
  _pickRows(kind, q) {
    q = q.trim().toLowerCase();
    const d = this._sheet;
    const reo = new Set((this._cameras || []).flatMap((c) => c.groups.flatMap((g) => g.entities)).filter((e) => ["light", "siren"].includes(e.domain)).map((e) => e.entity_id));
    let ids = this._entIds(kind === "trig" ? LINK_TRIGGER_DOMAINS : LINK_TARGET_DOMAINS);
    const match = (e) => this._fname(e).toLowerCase().includes(q) || e.includes(q);
    if (q) ids = ids.filter(match);
    else if (kind === "tgt") ids = ids.filter((e) => reo.has(e));
    ids.sort((a, b) => (kind === "tgt" ? (reo.has(b) - reo.has(a)) : 0) || this._fname(a).localeCompare(this._fname(b)));
    ids = ids.slice(0, kind === "trig" ? 8 : 30);
    if (!ids.length) return `<p class="muted pick-empty">${q ? "Nichts gefunden." : "Keine Vorschläge – oben suchen."}</p>`;
    return ids.map((e) => {
      const on = kind === "trig" ? d.trigger_entity === e : d.target_entities.includes(e);
      return `<div class="pick-row" data-pick-${kind}="${esc(e)}"><span>${esc(this._fname(e))}<small>${esc(e)}</small></span><span class="chk">${on ? "✓" : ""}</span></div>`;
    }).join("");
  }

  _sheetHtml() {
    const d = this._sheet;
    const q = this._sheetQ || { trig: "", tgt: "" };
    const min = d.mode === "pulse" ? 10 : 0;
    const chips = d.target_entities.map((t) => `<button class="chip" data-untgt="${esc(t)}">${esc(this._fname(t))} ✕</button>`).join("");
    return `<div class="backdrop" data-sh-cancel></div><div class="sheet" role="dialog" aria-label="Kopplung">
      <h2>${d.id ? "Kopplung bearbeiten" : "Neue Kopplung"}</h2>
      <label class="fld">Name<input type="text" class="txt" data-sh="name" maxlength="60" value="${esc(d.name)}"></label>
      <h3>Auslöser</h3>
      ${d.trigger_entity ? `<div class="chips"><span class="chip sel">${esc(this._fname(d.trigger_entity))}</span></div>` : ""}
      <input type="search" class="txt" placeholder="Suchen …" data-sh="q-trig" value="${esc(q.trig)}">
      <div class="pick" id="sh-list-trig">${this._pickRows("trig", q.trig)}</div>
      <h3>Ziele</h3>
      ${chips ? `<div class="chips">${chips}</div>` : ""}
      <input type="search" class="txt" placeholder="Suchen …" data-sh="q-tgt" value="${esc(q.tgt)}">
      <div class="pick" id="sh-list-tgt">${this._pickRows("tgt", q.tgt)}</div>
      <h3>Verhalten</h3>
      <div class="seg"><button class="${d.mode === "follow" ? "act" : ""}" data-mode="follow">Mitlaufen</button><button class="${d.mode === "pulse" ? "act" : ""}" data-mode="pulse">Impuls</button></div>
      <div class="ctrls"><div class="ctrl"><label>Nachlaufzeit</label><div class="in"><input type="range" class="slider" min="${min}" max="600" step="5" value="${Math.max(min, d.hold_seconds)}" data-sh="hold"><span class="val" id="sh-hold-val">${Math.max(min, d.hold_seconds)} s</span></div></div>
      <div class="ctrl"><label>Nur bei Dunkelheit</label><div class="in"><label class="toggle-wrap"><input type="checkbox" class="toggle" data-sh="dark"${d.only_dark ? " checked" : ""}><div class="toggle-track"></div></label></div></div></div>
      <div class="sheet-btns">${d.id ? `<button class="btn-pill ghost" data-sh-test>Testen</button>` : ""}<span class="grow"></span>
        <button class="btn-pill ghost" data-sh-cancel>Abbrechen</button><button class="btn-pill" data-sh-save>Speichern</button></div>
    </div>`;
  }

  _sheetOpen(rule) {
    this._sheet = rule ? { ...rule, target_entities: [...rule.target_entities] }
      : { name: "", trigger_entity: "", target_entities: [], mode: "follow", hold_seconds: 0, only_dark: false, enabled: true };
    this._sheetQ = { trig: "", tgt: "" };
    this._linksRender();
  }

  async _sheetSave() {
    const d = this._sheet;
    const name = d.name.trim();
    if (!name) return this._toast("Bitte einen Namen eingeben.");
    if (!d.trigger_entity) return this._toast("Bitte einen Auslöser wählen.");
    if (!d.target_entities.length) return this._toast("Bitte mindestens ein Ziel wählen.");
    const rule = { name, enabled: d.enabled, trigger_entity: d.trigger_entity, target_entities: d.target_entities,
      mode: d.mode, hold_seconds: Math.round(d.hold_seconds), only_dark: d.only_dark };
    if (d.id) rule.id = d.id;
    if (await this._linkCall("save", { rule })) { this._sheet = null; this._loadLinks(false); }
  }

  _linksBind(root) {
    const $ = (sel, fn) => root.querySelectorAll(sel).forEach(fn);
    $("[data-rule-new]", (el) => el.addEventListener("click", () => this._sheetOpen(null)));
    $("[data-rule-edit]", (el) => el.addEventListener("click", () => this._sheetOpen(this._links.rules.find((r) => r.id === el.dataset.ruleEdit))));
    $("[data-rule-del]", (el) => el.addEventListener("click", async () => {
      const r = this._links.rules.find((x) => x.id === el.dataset.ruleDel);
      if (r && confirm(`Kopplung „${r.name}“ löschen?`) && await this._linkCall("delete", { rule_id: r.id })) this._loadLinks(false);
    }));
    $("[data-rule-en]", (el) => el.addEventListener("change", async () => {
      const r = this._links.rules.find((x) => x.id === el.dataset.ruleEn);
      if (!r) return;
      const { id, name, trigger_entity, target_entities, mode, hold_seconds, only_dark } = r;
      const ok = await this._linkCall("save", { rule: { id, name, trigger_entity, target_entities, mode, hold_seconds, only_dark, enabled: el.checked } });
      if (ok) this._loadLinks(false); else el.checked = !el.checked;
    }));
    $("[data-rule-sug]", (el) => el.addEventListener("click", async () => {
      if (await this._linkCall("save", { rule: LINK_SUGGESTION })) this._loadLinks(false);
    }));
    const d = this._sheet;
    if (!d) return;
    const val = (k) => root.querySelector(`[data-sh="${k}"]`);
    val("name").addEventListener("input", (ev) => { d.name = ev.target.value; });
    ["trig", "tgt"].forEach((k) => val(`q-${k}`).addEventListener("input", (ev) => {
      this._sheetQ[k] = ev.target.value;
      root.getElementById(`sh-list-${k}`).innerHTML = this._pickRows(k, ev.target.value);
    }));
    val("hold").addEventListener("input", (ev) => { d.hold_seconds = Number(ev.target.value); root.getElementById("sh-hold-val").textContent = `${ev.target.value} s`; });
    val("dark").addEventListener("change", (ev) => { d.only_dark = ev.target.checked; });
    $("[data-sh-cancel]", (el) => el.addEventListener("click", () => { this._sheet = null; this._linksRender(); }));
    $("[data-sh-save]", (el) => el.addEventListener("click", () => this._sheetSave()));
    $("[data-sh-test]", (el) => el.addEventListener("click", () => this._linkCall("test", { rule_id: d.id }, "Test läuft: Ziele 10 s an.")));
    $("[data-mode]", (el) => el.addEventListener("click", () => {
      d.mode = el.dataset.mode;
      if (d.mode === "pulse" && d.hold_seconds < 10) d.hold_seconds = 10;
      this._linksRender();
    }));
    $("[data-untgt]", (el) => el.addEventListener("click", () => { d.target_entities = d.target_entities.filter((t) => t !== el.dataset.untgt); this._linksRender(); }));
    // Auswahlzeilen ändern sich beim Tippen -> Delegation auf dem Sheet
    root.querySelector(".sheet").addEventListener("click", (ev) => {
      const t = ev.target.closest("[data-pick-trig]");
      const g = ev.target.closest("[data-pick-tgt]");
      if (t) { d.trigger_entity = t.dataset.pickTrig; this._sheetQ.trig = ""; this._linksRender(); }
      else if (g) {
        const e = g.dataset.pickTgt;
        d.target_entities = d.target_entities.includes(e) ? d.target_entities.filter((x) => x !== e) : [...d.target_entities, e];
        this._linksRender();
      }
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

    const a = this._at;
    const atOverlay = !a ? "" : a.state === "wait" ? `<div class="player-modal" id="at-wait">
      <button class="close-modal" data-at-cancel>✕</button>
      <div class="spinner"></div>
      <p class="clip-name">Clip wird verarbeitet …</p>
      <p class="clip-name">Bewegung um ${esc(new Date(parseAt(a.at)).toLocaleTimeString("de-DE"))} Uhr – dauert meist 1–3 Minuten</p>
      <button class="at-cancel" data-at-cancel>Abbrechen</button>
    </div>` : `<p class="err">Zur Bewegung um ${esc(new Date(parseAt(a.at)).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }))} Uhr gibt es kein Video. Die Kamera speichert nur die Typen, die unter Erkennung → FTP eingeschaltet sind.</p>`;
    const player = this._clipSrc ? `<div class="player-modal" id="player-modal">
      <button class="close-modal" data-close-modal>✕</button>
      <video controls playsinline autoplay src="${esc(this._clipSrc)}"></video>
      <p class="clip-name">${esc(this._clipName)}</p>${this._clipNote ? `<p class="clip-name">${esc(this._clipNote)}</p>` : ""}
    </div>` : "";

    const oldest = this._sortOldest();
    const sorted = [...c.clips].sort((x, y) => (x.time < y.time ? 1 : x.time > y.time ? -1 : 0));
    if (oldest) sorted.reverse();
    const grouped = {};
    sorted.forEach((x) => {
      const day = fmtDate(x.time);
      if (!grouped[day]) grouped[day] = [];
      grouped[day].push(x);
    });
    const days = Object.keys(grouped);
    const sortBar = c.clips.length ? `<div class="seg sort-seg"><button class="${oldest ? "" : "act"}" data-sort="new">Neueste zuerst</button><button class="${oldest ? "act" : ""}" data-sort="old">Älteste zuerst</button></div>` : "";
    const list = c.clips.length
      ? days.map((day) => {
        const clips = grouped[day].map((x) => `<li class="${x.filename === this._clipName ? "act" : ""}" data-clip="${esc(x.filename)}"><span class="time">${esc(fmtTime(x.time).split(" ")[1])}</span><span class="file">${esc(x.filename)}</span></li>`).join("");
        return `<div class="day-group"><h3>${day}</h3><ul class="clips-list">${clips}</ul></div>`;
      }).join("")
      : `<p class="muted">Keine Aufnahmen.</p>`;
    return `${atOverlay}${player}${sortBar}<div class="clips-container">${list}</div>`;
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
    $("[data-back]", (el) => el.addEventListener("click", () => { this._atStop(); this._cam = null; this._clips = null; this._clipSrc = ""; this._clipNote = ""; this._error = ""; this._render(); }));
    $("[data-lens]", (el) => el.addEventListener("click", () => this._selectLens(this._camera(), Number(el.dataset.lens))));
    $("[data-links]", (el) => el.addEventListener("click", () => { this._page = "links"; this._error = ""; this._loadLinks(); }));
    $("[data-links-back]", (el) => el.addEventListener("click", () => { this._page = null; this._sheet = null; this._render(); }));
    this._linksBind(root);
    $("[data-tab]", (el) => el.addEventListener("click", () => {
      this._tab = el.dataset.tab; this._error = ""; this._atStop();
      if (this._tab === "aufnahmen") this._loadClips();
      else if (this._tab === "erkennung") this._loadDetection();
      else this._render();
    }));
    this._ptzBind(root);
    $("[data-det]", (el) => el.addEventListener("change", () => this._detSet(el)));
    $("[data-clip]", (el) => el.addEventListener("click", () => this._play(el.dataset.clip)));
    $("[data-sort]", (el) => el.addEventListener("click", () => { try { localStorage.setItem("kz_sort", el.dataset.sort); } catch (e) { /* egal */ } this._render(); }));
    $("[data-close-modal]", (el) => el.addEventListener("click", () => { this._clipSrc = ""; this._clipName = ""; this._clipNote = ""; this._render(); }));
    $("[data-at-cancel]", (el) => el.addEventListener("click", () => { this._atStop(); this._render(); }));
    $("[data-act]", (el) => {
      const eid = el.dataset.e;
      const dom = eid.split(".")[0];
      const call = (d, s, data) => this._hass.callService(d, s, data).catch((e) => { this._error = e.message || String(e); this._render(); });
      const act = el.dataset.act;
      if (act === "press") el.addEventListener("click", () => call("button", "press", { entity_id: eid }));
      else if (act === "toggle") el.addEventListener("change", () => call(dom, el.checked ? "turn_on" : "turn_off", { entity_id: eid }));
      else if (act === "brightness") el.addEventListener("change", () => call("light", "turn_on", { entity_id: eid, brightness: Number(el.value) }));
      else if (act === "number") {
        el.addEventListener("input", () => {
          const v = root.querySelector(`[data-val="${eid}"]`); if (v) v.textContent = el.value;
          const cam = this._camera(); const p = cam && detectPtz(this._ptzEntities(cam));
          if (p && p.zoom === eid) this._autoTele();
        });
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
  .spinner { width: 40px; height: 40px; border: 4px solid rgba(255,255,255,.25); border-top-color: #fff; border-radius: 50%; animation: spin 1s linear infinite; margin-bottom: 16px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .at-cancel { margin-top: 20px; min-height: 44px; padding: 0 24px; border: 0; border-radius: 22px; background: rgba(255,255,255,.2); color: #fff; font-size: 1em; cursor: pointer; }
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

  .ov-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
  .ov-head h1 { margin: 0; }
  .btn-pill.ghost { background: var(--card-background-color, #f5f5f5); color: var(--primary-color, #0a84ff); display: inline-flex; align-items: center; gap: 6px; min-height: 36px; }
  .btn-pill.ghost ha-icon { color: inherit; --mdc-icon-size: 18px; }
  .icon-btn { background: transparent; border: 0; width: 44px; height: 44px; border-radius: 50%; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
  .icon-btn:active { background: rgba(127, 127, 127, 0.2); }
  .seg { display: flex; background: rgba(127, 127, 127, 0.16); border-radius: 12px; padding: 2px; margin: 0 0 12px; }
  .seg button { flex: 1; border: 0; background: transparent; color: var(--primary-text-color, #000); font: inherit; font-size: 0.9375em; min-height: 36px; border-radius: 10px; cursor: pointer; transition: all 150ms ease; }
  .seg button.act { background: var(--card-background-color, #fff); font-weight: 600; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2); }
  .rule { align-items: center; }
  .rule > label { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .rule-sub { overflow-wrap: anywhere; }
  .rule .in { flex-shrink: 0; gap: 4px; }
  .backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); z-index: 900; animation: fadeIn 150ms ease; }
  .sheet {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 901; max-height: 90vh; overflow-y: auto; box-sizing: border-box;
    max-width: 640px; margin: 0 auto; padding: 8px 16px max(16px, env(safe-area-inset-bottom));
    background: var(--primary-background-color, #fff); border-radius: 20px 20px 0 0; box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.25);
    animation: slideUp 250ms ease;
  }
  .sheet h2 { font-size: 1.25em; margin: 12px 0 8px; }
  .sheet h3 { margin: 18px 0 8px; }
  .fld { display: block; font-size: 0.8125em; color: var(--secondary-text-color, #999); }
  .txt { width: 100%; box-sizing: border-box; margin-top: 4px; padding: 10px 14px; min-height: 44px; font: inherit; font-size: 1em; color: inherit; background: var(--card-background-color, #f5f5f5); border: 0; border-radius: 12px; outline: 0; }
  .pick { margin-top: 8px; background: var(--card-background-color, #f5f5f5); border-radius: 14px; overflow: hidden; max-height: 220px; overflow-y: auto; }
  .pick-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 14px; min-height: 24px; cursor: pointer; border-bottom: 1px solid rgba(127, 127, 127, 0.2); }
  .pick-row:last-child { border-bottom: 0; }
  .pick-row small { display: block; color: var(--secondary-text-color, #999); font-size: 0.75em; }
  .pick-row .chk { color: var(--primary-color, #0a84ff); font-weight: 700; }
  .pick-empty { padding: 10px 14px; margin: 0; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .chip { border: 0; border-radius: 16px; padding: 6px 12px; font: inherit; font-size: 0.8125em; background: var(--primary-color, #0a84ff); color: #fff; cursor: pointer; }
  .sheet-btns { display: flex; align-items: center; gap: 8px; margin-top: 18px; }
  .grow { flex: 1; }

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
