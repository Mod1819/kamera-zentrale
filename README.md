# Kamera-Zentrale

Home-Assistant-Integration (HACS) mit Seitenleisten-Panel **Kameras** (`mdi:cctv`).
Sie baut keine eigene Kameraverbindung auf, sondern nutzt die Entitäten der offiziellen
**Reolink-Integration**. Jede Reolink-Kamera in HA erscheint automatisch (Mehrkamera).

## Funktionen (v0.1.0)
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
