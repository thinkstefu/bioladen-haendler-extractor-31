# Bioladen Händler Extractor (stabil)

Diese Version setzt sicher den 50‑km‑Radius, aktiviert optional die Kategorien (Bioläden, Marktstände, Lieferservice) und nutzt eine URL‑Fallback‑Strategie, falls die UI‑Selektoren nicht greifen. Die Ergebnisliste wird zuerst ausgelesen; Detailseiten werden nur geöffnet, wenn wesentliche Felder (z. B. Website) fehlen. Alle Felder werden mit `null` vorbelegt, damit die CSV keine Mix-Fragmente enthält.

## Run-Optionen (Actor input)
```json
{
  "startIndex": 0,
  "limit": 200,
  "maxZips": null,
  "headless": true
}
```
- `startIndex`/`limit`: Chunking über die PLZ-Liste `plz_full.json`
- `maxZips`: maximal zu verarbeitende PLZ (kürzt die Liste)
- `headless`: steuert den Browsermodus

## Hinweis
- Docker-Image: `apify/actor-node-playwright-chrome:20` (Browser bereits enthalten)
- Keine `npx playwright install` nötig.
