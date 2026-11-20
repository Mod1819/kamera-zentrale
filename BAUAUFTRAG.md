# Bauauftrag Kamera-Zentrale v0.1.0 (Phase 2: Grundgerüst)

Arbeitsverzeichnis: ~/kamera-zentrale (Git-Repo, Remote github.com/Mod1819/kamera-zentrale).
Vorlage für Aufbau, Stil, Panel-Technik und Tests: ~/ha-addon-refs/Heitzungs-tool (custom_components/smart_heating).
Code-Kommentare, UI-Texte und README auf Deutsch.

## Ziel
Custom Integration `kamera_zentrale` (HACS) mit Seitenleisten-Panel „Kameras“ (mdi:cctv).
Sie baut KEINE eigene Kameraverbindung auf, sondern nutzt die Entitäten der offiziellen
HA-Reolink-Integration (Domain `reolink`). Jede Reolink-Kamera in HA erscheint automatisch (Mehrkamera).

## Dateien
- hacs.json (name "Kamera-Zentrale", homeassistant "2025.1.0"), README.md, LICENSE (MIT), .gitignore, pytest.ini wie Vorlage
- custom_components/kamera_zentrale/: manifest.json (version 0.1.0, config_flow true, single_config_entry true,
  dependencies http, websocket_api; after_dependencies frontend, panel_custom, reolink; iot_class local_polling),
  __init__.py, const.py, config_flow.py, panel.py, websocket.py, cameras.py, clips.py, translations/de.json+en.json, strings.json,
  www/kamera-zentrale-panel.js (Web-Component ohne Build-Schritt, wie Vorlage)

## Config-Flow
Ein Schritt, ein Feld: `clip_base_url` (Default `http://192.168.0.251:8080`) = nginx-autoindex des FTP-Speichers.
Options-Flow zum Ändern desselben Felds.

## cameras.py (reine, testbare Logik)
- Alle Geräte aus dem Device-Registry, die zu einem Config-Entry der Domain `reolink` gehören.
- Pro Gerät: id, name, model, sw_version, alle Entitäten (entity registry, nicht deaktiviert) mit
  entity_id, domain, translation_key, name.
- Einordnen in Gruppen nach translation_key/entity_id (Schlüsselwörter, Fallback „Sonstiges“):
  live (camera.*), licht (ir_lights, floodlight, spotlight, status_led, light.*), erkennung (sensitivity, ai_*, delay,
  binary_sensor motion/person/vehicle/pet/animal/visitor), aufnahme (record, ftp, push, email, manual_record),
  ptz (ptz, auto_track, preset, zoom, focus, guard, pan, tilt), audio (siren, volume, audio, alarm), system (restart, update,
  sensor wifi/storage/hdd, reboot), sonstiges.
- Ausgabe nach Gruppen sortiert; Funktion ohne hass-Abhängigkeit testbar (Eingabe: Listen von Dicts).

## clips.py
- Ordnername je Kamera = Gerätename (z. B. "Garten"), überschreibbar später.
- `list_clips(camera_folder)`: GET `{clip_base_url}/{folder}/events/` (nginx autoindex HTML), parsen der Links `event_YYYYMMDDHHMMSS.mp4`,
  Rückgabe neueste zuerst (max 200) mit Dateiname und ISO-Zeitstempel (lokale Zeit). Parser als reine Funktion testbar.
- Authentifizierte HTTP-View `/api/kamera_zentrale/clip/{folder}/{filename}` (requires_auth=True), streamt die Datei vom
  nginx durch, reicht `Range`-Header weiter (Status 206, Content-Range, Accept-Ranges, Content-Type video/mp4).
  Dateiname strikt per Regex `^event_\d{14}\.mp4$` bzw. `latest.mp4` prüfen, folder `^[A-Za-z0-9_-]+$` (kein Path-Traversal).
  Abspielen im Panel per signierter URL: `hass.callWS({type:"auth/sign_path", path})`.

## websocket.py
- `kamera_zentrale/cameras/list` → Geräte mit gruppierten Entitäten (jeder angemeldete Benutzer)
- `kamera_zentrale/clips/list {camera_id}` → Clips der Kamera
Schreibvorgänge macht das Panel über normale HA-Dienste (`hass.callService`), keine eigenen Schreibbefehle.

## Panel (www/kamera-zentrale-panel.js)
- Übersicht: Kachel je Kamera mit Live-Standbild (`/api/camera_proxy/<entity>?token=<access_token-Attribut>`, alle 2 s neu),
  Name, Online-Status. Klick → Detailansicht.
- Detailansicht mit Reitern: Live | Aufnahmen | Licht | Erkennung | Aufnahme | PTZ | Audio | System | Sonstiges (nur Reiter mit Inhalt).
  - Live: großes Bild (`ha-camera-stream` falls verfügbar, sonst Standbild-Refresh).
  - Aufnahmen: Liste (Datum/Uhrzeit), Klick spielt Clip in `<video controls playsinline>` über signierte URL.
  - Steuer-Reiter generisch nach Domain rendern, Werte live aus `hass.states`:
    switch/light → Schalter (light zusätzlich Helligkeit falls unterstützt), number → Schieberegler mit min/max/step + Wert,
    select → Dropdown, button → Knopf, siren → Ein/Aus, sensor/binary_sensor → Anzeige, update → Anzeige.
- URL-Parameter: `?camera=<device_id>&clip=<dateiname>` öffnet direkt den Clip (für Push-Links, Phase 3).
- Mobil tauglich (Companion-App), helles/dunkles Theme über HA-CSS-Variablen.
- `require_admin=False` (Ansehen für alle).

## Tests (pytest + pytest-homeassistant-custom-component, wie Vorlage)
- cameras: Gruppierung inkl. Mehrkamera, deaktivierte Entitäten ausgeschlossen, Fallback.
- clips: autoindex-Parser, Sortierung, Validierung Dateiname/Ordner (Traversal abgelehnt).
- Setup/Unload des Config-Entry, websocket cameras/list mit gemockten Registry-Einträgen.
- Panel-JS: mindestens `node --check`.
Venv: `uv venv -p 3.12 .venv && uv pip install pytest-homeassistant-custom-component` (Version passend zu HA 2025.x).

## Abschluss
- Alle Tests grün. `python -m py_compile` auf alle Dateien. JSON-Dateien valide.
- NICHT pushen, NICHT taggen. Kein Commit. Am Ende kurze Zusammenfassung: Dateien, Testergebnis, offene Punkte.
