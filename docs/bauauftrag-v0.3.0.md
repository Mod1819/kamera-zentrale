# Bauauftrag v0.3.0 – Objektiv-Umschalter + Verbund (Kopplungen)

Arbeitsverzeichnis ~/kamera-zentrale. Design (Apple-Stil) beibehalten. Tests mit .venv/bin/python -m pytest, alle grün.
version 0.3.0, Changelog im README.

## 1. Fehler: Zoom „wirkt nicht“ – falsches Objektiv
TrackMix hat 2 Objektive. HA-Entitäten (live ausgelesen):
camera.garten_standardauflosung_objektiv_0 (translation_key sub_lens_0, Weitwinkel),
camera.garten_standardauflosung_objektiv_1 (sub_lens_1, Tele, das zoomt), main_lens_0/1 meist deaktiviert.
Das Panel zeigt bisher die erste camera-Entität (Weitwinkel).
- Kamera-Entitäten pro Gerät nach Objektiv gruppieren (translation_key `*_lens_<N>`; ohne Objektiv = eine Ansicht).
  Pro Objektiv bevorzugt main_lens_N, wenn aktiviert, sonst sub_lens_N.
- Live-Reiter: Segmented Control „Weitwinkel | Tele“ über dem Bild (nur wenn ≥2 Objektive). Benennung: Objektiv 0 = Weitwinkel, 1 = Tele, weitere „Objektiv N“.
- Bei Benutzung von Zoom (Slider/±) oder Steuerkreuz automatisch auf Tele umschalten (falls vorhanden). Auswahl pro Kamera in localStorage merken (try/catch).
- Übersichts-Kachel: Weitwinkel.
- Reine Funktion `lensesOf(entities)` + Test.

## 2. Verbund (Kopplungen zwischen Geräten)
Zweck: z. B. Ring-Gartenkamera schaltet ihr Licht ein → TrackMix-Scheinwerfer geht mit an und mit aus.
### Backend `links.py`
- Regeln in HA-Store (`homeassistant.helpers.storage.Store`, key `kamera_zentrale.links`, version 1). Regel:
  `{id, name, enabled, trigger_entity, target_entities:[...], mode: "follow"|"pulse", hold_seconds:int (0–3600), only_dark:bool}`
- Logik:
  - Auslöser „an“: light/switch/binary_sensor/input_boolean state == "on"; event-Entität: jede Zustandsänderung (neuer Zeitstempel) = Impuls.
  - follow: Auslöser an → Ziele `homeassistant.turn_on`; Auslöser aus → nach hold_seconds Ziele aus (Timer abbrechen, wenn zwischendurch wieder an).
    Event-Auslöser bei follow wie pulse behandeln.
  - pulse: bei Auslöser-an/Impuls Ziele an, nach hold_seconds (min 10) aus; erneuter Impuls verlängert.
  - only_dark: nur auslösen wenn `sun.sun` state == "below_horizon" (falls sun.sun fehlt: ignorieren).
  - Ziele nur ausschalten, die die Regel selbst eingeschaltet hat (waren vorher aus) – manuell eingeschaltetes Licht nicht abschalten.
  - Listener via `async_track_state_change_event`; bei Regeländerung neu aufsetzen; beim Unload alles abräumen. HA-Startzustand nicht als Auslöser werten (old_state None ignorieren).
- WebSocket: `kamera_zentrale/links/list`, `/links/save {rule}` (anlegen/ändern, Admin), `/links/delete {id}` (Admin), `/links/test {id}` (Ziele 10 s an, Admin).
  Validierung per voluptuous; entity_ids müssen existieren.
- Beim ersten Start (Store leer) KEINE Regel automatisch anlegen.
### Panel
- In der Übersicht oben rechts Knopf „Verbund“ (mdi:link-variant) → eigene Seite im gleichen Stil:
  Liste der Regeln als Karten (Name, „Wenn <Auslöser-Name> → <Ziel-Namen>“, Toggle aktiv, Bearbeiten, Löschen).
  „+ Neue Kopplung“ öffnet Bottom-Sheet: Name; Auslöser (Suchfeld über alle light/switch/binary_sensor/event/input_boolean-Entitäten in hass.states, mit Friendly Name);
  Ziele (Mehrfachauswahl, vorgeschlagen zuerst light/siren der Reolink-Geräte, Suche über alle light/switch/siren);
  Modus Segmented „Mitlaufen | Impuls“; Nachlaufzeit (Slider 0–600 s, bei Impuls min 10); Toggle „Nur bei Dunkelheit“; Knopf „Testen“.
  Vorschlag oben als Schnellanlage, wenn beide existieren: „Ring Garten-Licht → TrackMix-Scheinwerfer“
  (trigger light.garten_light, target light.garten_scheinwerfer, follow, hold 0, only_dark false) – nur anlegen auf Tippen.
- Nur Admins sehen Bearbeiten/Löschen.

## Tests
lensesOf (JS, node), links-Logik: follow an/aus mit Nachlauf, Wiedereinschalten bricht Timer ab, pulse verlängert, only_dark, event-Impuls,
manuell eingeschaltetes Ziel wird nicht abgeschaltet, old_state None ignoriert, Unload räumt auf, WebSocket save/list/delete/Admin-Pflicht/Validierung.
Zeit per `async_fire_time_changed`. Kein Commit, kein Push. Kurze Zusammenfassung.
