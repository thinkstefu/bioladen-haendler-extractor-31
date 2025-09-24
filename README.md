# bioladen-haendler-extractor (final)

Stabiler Actor-Stand, der dir bereits ~90 Datensätze geliefert hat – jetzt mit
- erzwungenem 50-km-Radius (Querystring + optional Dropdown-Fix),
- robustem Modal-Scraping (Name, Adresse, Telefon, E-Mail, Website, Öffnungszeiten, Typ),
- Null-Feldern für fehlende Werte,
- Dedupe (Name+PLZ+Ort+Straße+Telefon),
- vollständiger `plz_full.json`.

## Build (Apify)
- Neues Actor-Build starten; dieses Repo enthält ein eigenes `Dockerfile`.
- Run-Command: (Standard) `node main.js` – Apify hängt automatisch ein xvfb an.

## Input
- `plz_full.json` enthält die zu suchenden PLZ. Du kannst optional die Umgebungsvariablen setzen:
  - `START_INDEX` (0-basiert)
  - `LIMIT` (Anzahl PLZ aus der Liste)
  - `RADIUS_KM` (Standard 50)
  - `HEADLESS` (true/false, default true)

## Output
- Datensätze landen in der Default Dataset (Apify). Jedes Feld ist vorhanden, nicht verfügbare als `null`.

## Hinweise
- Der Actor ruft direkt: `https://www.bioladen.de/bio-haendler-suche?tx_biohandel_plg[searchplz]=<PLZ>&tx_biohandel_plg[distance]=50`
- Falls kein Ergebnis/keine Buttons: er probiert erneut kurz, dann weiter zur nächsten PLZ.
