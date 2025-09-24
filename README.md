# bioladen-haendler-extractor

Apify Actor zum Extrahieren von Händlern (Bioläden, Marktstände, Lieferservice) von bioladen.de
per PLZ-Suche und 50 km Radius.

## Highlights
- Erzwingt 50 km Radius (URL-Param, Dropdown, Fallback-submit)
- Aktiviert alle drei Kategorien
- Liest Details aus dem Modal; fehlende Felder -> `null`
- Dedupe über `name|street|zip|city|type`
- Robust gegen Cookie-Banner
- Keine doppelten `xvfb-run`-Aufrufe (Apify fügt das selbst hinzu)

## Start
- `plz_full.json` anpassen (deine komplette PLZ-Liste einsetzen)
