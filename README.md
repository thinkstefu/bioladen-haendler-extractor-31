# Bioladen Händler Extractor

Extrahiert Händler-Datensätze (Bioläden, Marktstände, Lieferservice) aus der Suche auf **bioladen.de** per PLZ + 50km.

## Build auf Apify
- Neues Actor-Repo mit diesen Dateien erstellen
- Build starten (Dockerfile nutzt `apify/actor-node-playwright-chrome:20` → Browser sind schon dabei)
- Run starten

## Optionaler Input (JSON)
```json
{
  "zips": ["20095", "80331", "50667", "60311", "70173"],
  "radius": 50
}
```
Wenn leer, nutzt der Actor `plz_full.json`.

## Output
- Schreibt pro Details-Dialog einen Datensatz in den Default-Dataset mit Feldern:
  `name, category, street, zip, city, phone, email, website, source_zip, source_url, raw_text`