# Kamera-Zentrale

Home-Assistant-Integration (HACS) mit Seitenleisten-Panel **Kameras** (`mdi:cctv`).
Sie baut keine eigene Kameraverbindung auf, sondern nutzt die Entitäten der offiziellen
**Reolink-Integration**. Jede Reolink-Kamera in HA erscheint automatisch (Mehrkamera).

## Funktionen

### v0.3.0 (Aktuell: Objektiv-Umschalter + Verbund)
- **Objektiv-Umschalter**: Kameras mit mehreren Objektiven (z. B. TrackMix) zeigen im Live-Reiter „Weitwinkel | Tele“. Pro Objektiv wird `main_lens_N` bevorzugt, sonst `sub_lens_N`. Zoom (Slider/±) oder Steuerkreuz schaltet automatisch auf Tele; die Auswahl wird pro Kamera gemerkt. Die Übersicht zeigt das Weitwinkel. (Behebt: Zoom „wirkte nicht“, weil das Weitwinkel-Bild gezeigt wurde.)
- **Verbund** (Knopf oben rechts in der Übersicht): Kopplungen Auslöser → Ziele, z. B. Ring-Gartenlicht schaltet den TrackMix-Scheinwerfer mit. Modus *Mitlaufen* (Ziele folgen dem Auslöser, optional mit Nachlaufzeit) oder *Impuls* (Ziele für mind. 10 s an, erneuter Impuls verlängert; Event-Entitäten wirken immer als Impuls), optional nur bei Dunkelheit (`sun.sun`). Es werden nur Ziele ausgeschaltet, die die Regel selbst eingeschaltet hat. Regeln liegen im HA-Store (`kamera_zentrale.links`), Bearbeiten nur für Admins. Es wird keine Regel automatisch angelegt; ein Vorschlag erscheint nur zum Antippen.
- WebSocket: `kamera_zentrale/links/list|save|delete|test` (`delete`/`test` mit `rule_id`).
- Nach HA-Neustart laufende Nachlauf-Timer entfallen (nicht persistiert).

### v0.2.0 (Apple-Stil + Status-Anzeige)
- **Design**: Modern, iOS/macOS-Stil – Apple-Systemschriften, HA-Farbvariablen, weiche Schatten, großzügige Abstände
- **Status-Sensoren**: binary_sensor jetzt Statuspille (Dot + Text), nicht Toggle
- **Erkennung-Reiter**: Neu strukturiert – „Live-Status" (Pillen oben) + „Einstellungen" (darunter)
- **Erkennungs-Matrix** (Admin): je Objekttyp (Person, Fahrzeug, Tier, Bewegung) Push/Aufnahme/FTP/E-Mail sowie Tracking direkt an der Kamera schalten, über die bestehende Reolink-Integration (`kamera_zentrale/detection/get|set`). Einschalten = rund um die Uhr, App-Zeitpläne werden überschrieben.
- **Steuerelemente**: iOS-Toggle (grün an), Slider mit rundem Knopf, Dropdowns mit Chevron, Buttons als Pillen
- **Reiter**: Segmented Control statt Buttons
- **Übersicht**: Responsive Grid, Glass-Overlay für Name + Status auf Kacheln
- **Aufnahmen**: Gruppiert nach Tag („Heute", „Gestern", Datum), Tippen öffnet Player in Modal
- **Mobile-First**: 44px+ Touch-Ziele, Safe-Area-Padding, Companion-App-ready
- **Animationen**: 150–250ms ease, `prefers-reduced-motion` respektiert

### v0.1.0
- Übersicht: Kachel je Kamera mit Live-Standbild (alle 2 s) und Online-Status
- Detailansicht mit Reitern: Live, Aufnahmen, Licht, Erkennung, Aufnahme, PTZ, Audio, System, Sonstiges
  (nur Reiter mit Inhalt). Steuerung über normale HA-Dienste, Werte live aus `hass.states`
- Aufnahmen: Clips aus einer nginx-Verzeichnisliste (FTP-Speicher), Wiedergabe über signierte URL
  (mit Range-Unterstützung zum Spulen)
- Direktlink: `/kameras?camera=<device_id>&clip=event_YYYYMMDDHHMMSS.mp4`

## Installation
1. HACS → Benutzerdefinierte Repositories → dieses Repo als *Integration* hinzufügen
2. Kamera-Zentrale installieren, HA neu starten
3. Einstellungen → Geräte & Dienste → Integration hinzufügen → „Kamera-Zentrale“

## Konfiguration
Ein Feld: **Basis-URL der Clip-Ablage** (Standard `http://192.168.0.251:8080`).
Erwartete Struktur: `{URL}/{Kameraname}/events/event_YYYYMMDDHHMMSS.mp4` (nginx `autoindex on`).
Der Ordnername ist der Gerätename der Kamera und darf nur `A-Z a-z 0-9 _ -` enthalten.
Änderbar über die Optionen der Integration.

## Entwicklung
```
uv venv -p 3.12 .venv && uv pip install -p .venv pytest-homeassistant-custom-component
.venv/bin/python -m pytest
```

## Lizenz
MIT
