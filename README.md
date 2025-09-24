# bioladen-haendler-extractor (final)

- Robust gegen Cookie-Banner
- Setzt Radius *garantiert* auf 50 km (verifiziert)
- Aktiviert alle Kategorien (Bioläden, Marktstände, Lieferservice), sofern Filter vorhanden sind
- Extrahiert Name, Straße, PLZ, Ort, Telefon, E-Mail, Website, Kategorie, Öffnungszeiten, Rohtext
- Füllt fehlende Felder mit `null`
- Dedup anhand (name + plz + ort + strasse)
- Läuft mit `apify/actor-node-playwright-chrome:20`

## Start
```bash
node main.js
```

## Input (optional)
```json
{
  "limit": 500,           // max. Anzahl PLZs (Default: alle)
  "startIndex": 0         // Startindex in der PLZ-Liste (Default: 0)
}
```
