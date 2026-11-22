# Bauauftrag v0.5.0 – Sensor „Clip-Auslöser“ (Push passt automatisch zur FTP-Einstellung)

Arbeitsverzeichnis ~/kamera-zentrale. Tests: .venv/bin/python -m pytest (alle grün). version 0.5.0, README-Changelog + Abschnitt
„Push-Automation“ (Beispiel mit dem neuen Sensor, Ersatz für das bisherige Beispiel).

## Ziel
Pro Reolink-Kamera ein binary_sensor der Integration kamera_zentrale: „Clip-Auslöser“
(unique_id `kamera_zentrale_<device_id>_clip_trigger`, translation_key `clip_trigger`, device_class motion, has_entity_name,
device_info mit den identifiers des Reolink-Geräts → hängt am bestehenden Kamera-Gerät; erwartete entity_id z. B. `binary_sensor.garten_clip_ausloser`).
- AN, solange mindestens ein Reolink-Erkennungssensor dieses Geräts an ist, dessen Typ in der FTP-Matrix (detection, Aktion "ftp") eingeschaltet ist.
- Attribute: `type` (zuletzt auslösender Typ: people|vehicle|dog_cat|md), `type_label` (Person|Fahrzeug|Tier|Bewegung),
  `enabled_types` (Liste aus FTP-Matrix), `source_entity`, `matrix_updated` (ISO-Zeit).
- Typ → Reolink-binary_sensor über translation_key: people→person, vehicle→vehicle, dog_cat→pet|animal|dog_cat, md→motion
  (Fallback entity_id-Endung; nur Entitäten des Geräts, platform reolink, nicht deaktiviert).
- Matrix-Quelle: detection.async_get (FTP-Spalte). Aktualisieren: beim Setup (nach HA-Start), alle 10 min, und sofort nach jedem
  erfolgreichen `kamera_zentrale/detection/set` (Signal per dispatcher). Kamera nicht erreichbar → letzte bekannte Matrix behalten;
  noch nie gelesen → Sensor verfügbar, Fallback: alle Typen außer md gelten als aktiv (Attribut `matrix_updated: null`).
- Zustandswechsel per async_track_state_change_event auf die Quell-Sensoren; Neuberechnung auch bei Matrixänderung.
- Neue Kameras (Gerät taucht später auf) beim nächsten 10-min-Lauf bzw. Reload ergänzen; einfacher Ansatz ok: Reload der
  Integration legt fehlende an.
- Config-Entry: Plattform binary_sensor forwarden (async_forward_entry_setups / unload_platforms).
- Übersetzungen de/en: „Clip-Auslöser“ / „Clip trigger“.

## Panel
Im Reiter Erkennung unter „Erkennen & Reagieren“ kleine Info-Zeile: „Push/Automationen: binary_sensor.… folgt automatisch der FTP-Spalte.“
(entity_id aus cameras/list mitliefern, wenn vorhanden.)

## Tests
Mapping Typ→Quellsensor, Zustand an/aus je nach Matrix, Matrixänderung schaltet Bewertung um, Fallback ohne Matrix,
Kamera-Fehler behält alte Matrix, Attribute, Dispatcher nach detection/set, Unload.
Kein Commit, kein Push. Kurze Zusammenfassung inkl. tatsächlicher entity_id-Bildung.
