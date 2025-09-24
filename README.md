# bioladen-haendler-extractor

Extrahiert alle Händler (Bioläden, Marktstände, Lieferservices) aus der Suche auf **bioladen.de** nach Postleitzahl mit **Radius 50 km**.

## Features
- Erzwingt **50 km Radius** (Dropdown + URL + Check).
- Aktiviert **alle Kategorien** (Bioläden, Marktstände, Lieferservice).
- Klickt **Details** und parst die Modal-Daten robust (Name, Adresse, PLZ/Ort, Telefon, E-Mail, Website).
- Fehlende Felder werden als `null` gespeichert.
- Blockiert Bilder/Schriften/Styles für mehr Geschwindigkeit.
- Dedupliziert auf Basis `name|street|zip|city|type`.

## Dateien
- `Dockerfile` – baut und startet Actor korrekt.
- `package.json` – Node 20 + Playwright/Apify.
- `main.js` – die Logik.
- `plz_full.json` – Beispiel-PLZ-Liste (5 Zentrums-PLZ). Ersetze sie bei Bedarf durch deine große Liste.

## Apify Hinweise
- Baue den Actor aus dieser ZIP.
- Timeout hochsetzen (z. B. 3600 s).
- Concurrency bei einem Worker auf 1 lassen (die Seite reagiert empfindlich bei zu viel Parallelität).
