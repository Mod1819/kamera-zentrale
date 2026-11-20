# Bauauftrag v0.4.0 – Push-Link öffnet den passenden Clip

Arbeitsverzeichnis ~/kamera-zentrale. Design beibehalten. Tests: .venv/bin/python -m pytest + node-Tests. version 0.4.0, README-Changelog
(+ README-Abschnitt „Push-Link“ mit Beispiel-Automation).

## Hintergrund
Push kommt ~3 s nach der Bewegung, der Clip liegt erst ~1–3 min später im Speicher (Aufnahme-Ende + FTP + Zusammenfügen).
Clip-Dateiname `event_YYYYMMDDHHMMSS.mp4` = Startzeit (lokale Zeit, inkl. Voraufnahme ein paar Sekunden vor der Bewegung).

## URL
`/kameras?camera=<device_id>&at=<YYYYMMDDHHMMSS>` (lokale Zeit der Bewegung). Bestehendes `clip=` bleibt.
Beim Öffnen mit `at`: Detailansicht der Kamera, Reiter „Aufnahmen“, und:
1. Kandidat = Clip mit Start in [at−90 s, at+30 s], bei mehreren der zeitlich nächste → sofort im Player-Overlay abspielen.
2. Kein Kandidat und neuester Clip startet vor at−90 s → Overlay „Clip wird verarbeitet …“ (Spinner, Uhrzeit der Bewegung,
   Hinweis „dauert meist 1–3 Minuten“), Clip-Liste alle 5 s neu laden (clips/list), sobald Kandidat da → automatisch abspielen.
   Abbrechen-Knopf. Nach 6 min Zeitüberschreitung: Meldung „Kein passender Clip gefunden“ + Liste offen lassen.
3. Neuester Clip startet nach at+30 s (Bewegung ohne eigenen Clip): Clip mit Start ≤ at, der am nächsten ist, abspielen + kleiner Hinweis.
- Reine Funktion `pickClip(clips, at)` → {state: "play"|"wait"|"fallback", clip?} + node-Tests (Grenzen, mehrere Kandidaten, wait, fallback, leere Liste).
- URL-Parameter nach Verarbeitung per history.replaceState entfernen, damit ein Neuladen nicht erneut wartet.
- Polling stoppen bei Verlassen/disconnectedCallback/visibility hidden (bei Rückkehr weiter, solange Frist läuft).

Kein Commit, kein Push. Kurze Zusammenfassung.
