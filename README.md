# Bioladen-Händler-Extractor

Extrahiert alle Händler (Bioläden, Marktstände, Lieferservice) von **bioladen.de** anhand einer PLZ-Liste.
- Radius wird **erzwingend** auf **50 km** gesetzt.
- Cookie-Banner wird **einmal** akzeptiert.
- Deduplizierung über `name+strasse+plz`.
- Fehlt ein Feld → `null`.
- Ergebnisse landen im Apify Dataset (CSV/JSON verfügbar).

## Input (optional)
```json
{
  "plz": ["20095","80331","50667","60311","70173"],
  "concurrency": 1
}
```

Wenn `plz` fehlt, wird `plz_full.json` verwendet.

## Build & Run auf Apify
- Standard Dockerfile nutzt `apify/actor-node-playwright-chrome:20`, Browser ist enthalten.
- Kein zusätzliches `xvfb-run` nötig.
- `npm start` → `node main.js`.
```bash
npm start
```
