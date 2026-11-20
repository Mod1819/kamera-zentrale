# Bauauftrag v0.2.0 Teil 2 – Erkennungs-Schalter je Objekttyp

Arbeitsverzeichnis ~/kamera-zentrale. Design aus Teil 1 (Apple-Stil, iOS-Toggles, Grouped Inset List) weiterverwenden.
Zuerst prüfen, warum aktuell 1 Test „skipped“ ist, und das beheben (alle Tests sollen laufen).

## Kamera-API (live an TrackMix WiFi FW v3.2.0.5931 getestet)
Zugriff NICHT mit eigener Verbindung, sondern über die bestehende HA-Reolink-Integration:
Config-Entry der Domain `reolink` zum Gerät finden (device.config_entries) → `entry.runtime_data.host.api`
(reolink_aio `Host`). Robust machen: wenn Attribut fehlt/Entry nicht geladen → klare Fehlermeldung „Reolink-Integration nicht bereit“.
Kanal: aus Geräte-Identifier `(reolink, "<uid>_ch<N>")` lesen, sonst 0.

Lesen: `await api.send([{"cmd":"<Cmd>","action":0,"param":{"channel":ch}}], expected_response_type="json")` → `r[0]["value"]`.
Schreiben (Teil-Update, andere Schlüssel bleiben erhalten – getestet):
- Aktionen: Push=`GetPushV20/SetPushV20` Schlüssel `Push`, Aufnahme=`GetRecV20/SetRecV20` `Rec`, FTP=`GetFtpV20/SetFtpV20` `Ftp`,
  E-Mail=`GetEmailV20/SetEmailV20` `Email`. Tabelle: `value[<Schlüssel>]["schedule"]["table"]` mit Einträgen
  `AI_PEOPLE`, `AI_VEHICLE`, `AI_DOG_CAT`, `MD`, (`TIMING` ignorieren); je 168 Zeichen ('1' = Stunde aktiv, 7×24).
  Set: `{"cmd":"SetPushV20","param":{"Push":{"schedule":{"channel":ch,"table":{"AI_PEOPLE":"0"*168}}}}}`
  Status „an“ = mindestens eine '1'. Einschalten = alles '1', Ausschalten = alles '0'.
  Nur Schlüssel anzeigen, die die Kamera liefert; Befehle, die mit Fehler antworten (code != 0), weglassen.
- Tracking (nur wenn GetAiCfg erfolgreich): `GetAiCfg` → `value["AiDetectType"]` = {people, vehicle, dog_cat, face}.
  Set: `{"cmd":"SetAiCfg","param":{"channel":ch,"AiDetectType":{"dog_cat":0}}}`. `face` nur zeigen, wenn 1 oder von Kamera unterstützt? → weglassen.
- Nach jedem Set Wert neu lesen und zurückgeben (Bestätigung).

## Backend
Neue Datei `detection.py` (reine Funktionen testbar: Tabelle→bool, bool→Tabelle, Antwort→Matrix) +
WebSocket `kamera_zentrale/detection/get {camera_id}` → `{types:[people,vehicle,dog_cat,md], actions:{push:{people:true,...}, rec:{...}, ftp:{...}, email:{...}}, tracking:{people:true,...}|null}`
WebSocket `kamera_zentrale/detection/set {camera_id, action: push|rec|ftp|email|tracking, type: people|vehicle|dog_cat|md, enable: bool}` (nur Admin, `websocket_api.require_admin`) → neue Matrix.
Validierung per voluptuous (vol.In).

## Panel
Reiter „Erkennung“: oben Live-Status (wie Teil 1), dann neue Gruppe „Erkennen & Reagieren“ als Matrix:
Zeilen = Person, Fahrzeug, Tier, Bewegung (mit mdi-Icons account, car, paw, motion-sensor);
Spalten/Toggles = Push, Aufnahme, FTP, E-Mail (mobil: pro Typ eine Grouped-Liste mit Toggles, Desktop: Tabelle).
Darunter Gruppe „Verfolgen (Tracking)“ mit Toggles je Typ (nur wenn tracking != null).
Toggle optimistisch umschalten, bei Fehler zurück + Toast. Hinweis klein darunter: „Einschalten aktiviert rund um die Uhr; Zeitpläne aus der App werden überschrieben.“
Darunter wie bisher Empfindlichkeiten/Verzögerungen.

## Tests
detection.py Unit-Tests; WebSocket get/set mit gemocktem reolink-Entry (runtime_data.host.api.send AsyncMock), Admin-Pflicht für set,
Fehlerfall Entry fehlt. Alle Tests grün, keiner skipped. node --check fürs JS.
Kein Commit, kein Push. Kurze Zusammenfassung am Ende.
