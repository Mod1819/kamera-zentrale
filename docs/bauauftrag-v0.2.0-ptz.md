# Bauauftrag v0.2.0 Teil 3 – PTZ-Steuerung im Live-Reiter

Arbeitsverzeichnis ~/kamera-zentrale. Design (Apple-Stil) beibehalten. Nur Panel-JS + Tests (+ ggf. cameras.py).

## Ziel
Im Reiter „Live“ unter (bzw. mobil unter, Desktop optional rechts neben) dem Live-Bild ein aufklappbares Bedienfeld „Steuerung“
(Standard: aufgeklappt, Zustand in localStorage merken, try/catch). Nur sichtbar, wenn die Kamera PTZ-Entitäten hat.
Der eigene Reiter „PTZ“ bleibt für die übrigen PTZ-Einstellungen bestehen.

## Entitäten (Reolink-Integration, über translation_key bzw. entity_id-Endung erkennen)
- button: ptz_left, ptz_right, ptz_up, ptz_down, ptz_stop, ptz_zoom_in, ptz_zoom_out (optional ptz_calibrate, guard_go_to)
- number: zoom (Zoom-Stufe), focus; select: ptz_preset; switch: auto_tracking; number: ptz_speed falls vorhanden
## Bedienung
- Rundes Steuerkreuz (D-Pad, ~180px, Glas-/Kartenoptik, Pfeile oben/unten/links/rechts, Mitte = Stopp bzw. Guard-Position falls guard_go_to existiert).
- Gedrückt halten = bewegen: pointerdown → `button.press` der Richtung; pointerup/pointerleave/pointercancel → `button.press` ptz_stop.
  Falls Dienst `reolink.ptz_move` existiert (hass.services.reolink?.ptz_move), stattdessen diesen mit `speed` (Schieberegler „Geschwindigkeit“ 1–64, Standard 25) auf der Richtungs-Button-Entität nutzen.
  Bei kurzem Tippen (<250ms) trotzdem kurz bewegen und stoppen. Haptik: navigator.vibrate?.(10) in try.
  Tastatur: Pfeiltasten wenn Panel fokussiert.
- Zoom: Buttons „−“/„+“ (gedrückt halten wie oben) und/oder Schieberegler der number zoom.
- Presets: Pillen-Liste/Dropdown aus select ptz_preset → `select.select_option`.
- Auto-Tracking: iOS-Toggle.
- Touch: `touch-action: none` auf dem D-Pad, kein Scrollen beim Halten; Touch-Ziele ≥ 44px; Pressed-Zustand sichtbar.
- Stopp-Sicherheit: bei Verlassen des Reiters/Seite (visibilitychange, disconnectedCallback) immer ptz_stop senden, falls Bewegung aktiv.

## Tests
node --check; falls JS-Testinfrastruktur vorhanden: Erkennung der PTZ-Entitäten aus Entitätsliste als reine Funktion testen.
Alle Python-Tests weiterhin grün. Kein Commit, kein Push. Kurze Zusammenfassung.
