# Bauauftrag v0.6.0 – Licht-Verbund (gegenseitig) + Zusatzgeräte

Arbeitsverzeichnis ~/kamera-zentrale. Bestehendes links.py (Kopplungen „Wenn A → B“) bleibt unverändert nutzbar.
Tests: .venv/bin/python -m pytest (alle grün), node --check. version 0.6.0, README-Changelog + Abschnitt „Licht-Verbund“.

## Regeltyp `group` (im selben Store kamera_zentrale.links, Feld `kind`: "link" (bisher, Default bei Altregeln) | "group")
Felder: `{id, kind:"group", name, enabled, members:[light/switch…], followers:[light/switch/siren…], triggers:[binary_sensor/event/light/switch…],
hold_seconds (0–3600), only_dark}`. Validierung: members ≥ 2 ODER (members ≥ 1 und triggers ≥ 1); keine Entität doppelt über die Listen; alle existieren.

## Logik (links.py, neue Klasse/Funktionen, Zustand je Regel)
- Eigene Schaltungen erkennen über HA-Context: jeder Dienstaufruf der Regel mit eigenem `Context()`; dessen id in einem Set merken
  (auf ~50 begrenzen). Zustandsänderung mit `new_state.context.id` in diesem Set (oder parent_id darin) = „von uns“ → kein Auslöser.
- Initiatoren: Mitglied, das NICHT von uns eingeschaltet wurde und an ist; oder Trigger-Sensor an (binary_sensor/light/switch == "on");
  event-Entität = Impuls (gilt als aktiv für max(hold_seconds, 30) s).
- Verbund wird aktiv, sobald ein Initiator da ist (only_dark: nur wenn sun.sun below_horizon, falls vorhanden; Prüfung nur beim Aktivieren):
  alle Mitglieder + Zusatzgeräte, die aus sind, einschalten (homeassistant.turn_on, eigener Context) → als `owned` merken.
- Verbund endet, wenn kein Initiator mehr aktiv ist: nach hold_seconds (Timer, Abbruch bei erneutem Initiator) alle `owned` ausschalten (eigener Context).
- Mitglied, das wir eingeschaltet haben und das extern (nicht unser Context) ausgeschaltet wird: aus `owned` entfernen, sonst nichts.
- Mitglied, das wir eingeschaltet haben, wird extern erneut „an“ gemeldet: bleibt owned (kein neuer Initiator).
- Ein Mitglied, das schon an war, als der Verbund aktiv wurde, ist nicht owned (wird nie von uns ausgeschaltet).
- HA-Start/old_state None: ignorieren. Regel ändern/deaktivieren/löschen/Unload: owned ausschalten, Timer weg, Listener weg (wie bisher).
- links/test für group: alle Mitglieder+Zusatzgeräte 10 s an (owned-Logik), danach aus.

## WebSocket
links/save akzeptiert beide kinds (voluptuous mit vol.Any/Schema je kind). list liefert kind mit.

## Panel (Verbund-Seite)
- „+ Neu“ fragt zuerst: „Kopplung (Wenn → Dann)“ oder „Licht-Verbund“.
- Licht-Verbund-Sheet: Name; „Mitglieder (schalten sich gegenseitig)“ Mehrfachauswahl light/switch (Reolink-Lichter + Ring-Lichter oben vorgeschlagen);
  „Zusatzgeräte (laufen nur mit)“ Mehrfachauswahl light/switch/siren mit Suche; „Zusätzliche Auslöser (optional)“ binary_sensor/event mit Suche
  (Vorschlag: Clip-Auslöser- und Person-Sensoren der Kameras, Ring-Bewegung); Nachlaufzeit-Slider 0–600 s; „Nur bei Dunkelheit“; Testen.
- Karte zeigt „Verbund: A ⇄ B (+ Zusatzgeräte)“, Status-Punkt „aktiv“ wenn Verbund gerade an (Feld `active` in list mitliefern).
- Schnellvorschlag, wenn beide existieren und noch keine group mit beiden: „Garten-Licht-Verbund“ members [light.garten_light, light.garten_scheinwerfer],
  hold 0, only_dark false. Hinweis: bestehende Kopplung „Ring Garten-Licht → TrackMix-Scheinwerfer“ wird dann überflüssig → beim Anlegen anbieten,
  sie zu deaktivieren (Bestätigung).

## Tests
A an (extern) → B + Zusatzgerät an; A aus → B + Zusatz aus; B an (extern) → A an (Gegenrichtung); keine Schleife (unsere Contexts lösen nichts aus);
schon an gewesenes Mitglied wird nicht ausgeschaltet; Nachlauf + Abbruch; Trigger-Sensor allein aktiviert; event-Impuls; only_dark;
extern ausgeschaltetes owned-Mitglied; Unload räumt auf; Validierung; Altregeln ohne kind laufen weiter.
Kein Commit, kein Push. Kurze Zusammenfassung.
