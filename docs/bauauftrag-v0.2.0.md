# Bauauftrag v0.2.0 – Neues Design (Apple-Stil) + Status-Anzeige

Arbeitsverzeichnis ~/kamera-zentrale. Nur custom_components/kamera_zentrale/www/kamera-zentrale-panel.js
(+ ggf. cameras.py-Kleinigkeiten, Tests, manifest version 0.2.0, README-Changelog). Funktionen bleiben, Optik neu.

## 1. Fehler: Status-Sensoren sehen aus wie Schalter
binary_sensor und sensor NIE als Schalter/Knopf darstellen. Stattdessen:
- binary_sensor: „Statuspille“ mit Punkt – an: farbig (Akzent/Rot bei motion/person/vehicle/animal/pet/visitor) „Erkannt“, aus: grau „Ruhig“.
- Im Reiter Erkennung oben eigener Block „Live-Status“ (Pillen nebeneinander), darunter „Einstellungen“ (Empfindlichkeiten, Verzögerungen).
- sensor: Wert + Einheit rechtsbündig, grau.

## 2. Design: modern, iOS/macOS-Stil
- Schrift: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif`; klare Hierarchie (Titel 28–34px semibold, Abschnittsüberschriften 13px uppercase grau, Zeilen 16–17px).
- Farben über HA-Variablen mit Fallback, hell/dunkel automatisch (`--primary-background-color`, `--card-background-color`, `--primary-text-color`, `--secondary-text-color`, `--primary-color`), Akzent iOS-Blau #0A84FF als Fallback, Grün #30D158 für „an“.
- Karten: Radius 18–22px, keine harten Rahmen, sehr weicher Schatten (hell) bzw. leicht abgehobene Fläche (dunkel), großzügige Abstände (16/24px).
- Einstellungen als „Grouped Inset List“ wie iOS-Einstellungen: Gruppen-Karte, Zeilen mit dünnem Trenner (ab Textanfang), Label links, Steuerelement rechts.
- Steuerelemente selbst gebaut (kein Material-Look): iOS-Toggle (51×31, grün an, weicher Übergang), Slider mit dünner Spur und großem runden Knopf + Wert-Bubble, Dropdowns als native `<select>` mit Chevron, Buttons als Pillen (gefüllt Akzent / getönt).
- Reiter als Segmented Control (Pille mit verschiebbarem Hintergrund), auf schmalen Bildschirmen horizontal scrollbar.
- Übersicht: Kamera-Kacheln 16:9 mit abgerundetem Live-Bild, Name + Status als Glas-Overlay unten (`backdrop-filter: blur(20px) saturate(180%)`, halbtransparent), Online-Punkt grün/grau. Grid responsiv (1 Spalte mobil, 2–3 Desktop).
- Detail: großes Live-Bild oben (abgerundet), darunter Segmented Control, darunter Inhalt. Zurück-Button „‹ Kameras“ wie iOS.
- Aufnahmen: Liste gruppiert nach Tag („Heute“, „Gestern“, Datum), Zeile mit Uhrzeit groß + Dateihinweis klein, Tippen öffnet Player in einer Bottom-Sheet/Modal-Karte (abgerundet, Glas-Hintergrund, Schließen-Knopf), Video füllt Breite.
- Sanfte Animationen (150–250ms ease), `prefers-reduced-motion` respektieren.
- Fehlermeldungen als dezente Toast-Pille unten.
- Mobil (Companion-App, 375px) zuerst denken; Touch-Ziele ≥ 44px; Safe-Area-Padding.
- Icons: `ha-icon` mit mdi-Icons wo sinnvoll (Reiter, Zeilen), sonst keine.

## 3. Qualität
- Keine externen Abhängigkeiten/Fonts/CDNs. Shadow DOM, CSS im Komponenten-String.
- Bestehende Funktionen (callService, camera_proxy, sign_path, ?camera=&clip=, ha-camera-stream) unverändert erhalten.
- Tests: bestehende grün + JS-Test erweitern (node --check; falls vorhanden tests/js: Renderfunktion für binary_sensor erzeugt keine Toggle-Klasse).
- version 0.2.0 in manifest.json, Changelog im README.
- Kein Commit, kein Push. Am Ende kurze Zusammenfassung.
