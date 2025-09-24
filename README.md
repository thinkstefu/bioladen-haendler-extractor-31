# Bioladen Händler Extractor (stabil)

Diese Version entspricht funktional der Variante, die dir ~90 Datensätze geliefert hat – mit robusteren Selektoren,
50-km-Radius erzwungen, allen Kategorien (Bioläden, Marktstände, Lieferservice) sowie Null-Fallbacks für fehlende Felder.
Zudem ist das Docker-Setup stabil (keine `playwright install`-Probleme, keine `EACCES`-Fehler).

## Schnellstart (Apify)
1. Erstelle einen neuen Actor mit diesem Repo (oder ZIP).
2. **Timeout** in den Run-Optionen auf mind. **60 Minuten** setzen (besser: in Batches laufen).
3. Input z. B.:
   ```json
   {
     "baseUrl": "https://example.com/haendlersuche",
     "headless": true,
     "debug": false,
     "startIndex": 0,
     "limit": 500
   }
   ```
   > **Wichtig:** `baseUrl` muss die Trefferliste-Seite sein. Falls sich die Seite ändert, kannst du Selektoren
   > in `CONFIG.SELECTORS` in `main.js` anpassen.

## Was ist neu/robust?
- Radius **immer 50 km** (UI + URL-Fallback).
- **Alle Kategorien** werden aktiv gesetzt.
- **Pagination** der Trefferliste wird vollständig durchlaufen.
- Details werden **entweder** per Direktlink (wenn vorhanden) **oder** per Klick/Modal extrahiert.
- Einheitliches Schema; fehlende Felder werden als `null` gespeichert.
- Dedup pro Lauf (Hash über Name+Adresse).
- Dockerfile auf `apify/actor-node-playwright-chrome:20`, Installation als root → keine EACCES-Probleme.

## Input-Parameter
- `baseUrl` (required): URL der Händlersuche.
- `headless` (bool, default `true`): Headless-Mode.
- `debug` (bool, default `false`): Zusätzliche Logs + langsamere Wartezeiten.
- `startIndex` (int, default `0`): Index in `plz_full.json`.
- `limit` (int|null): Anzahl PLZs ab `startIndex`. Falls `null`, werden alle ab `startIndex` verarbeitet.
- `maxConcurrency` (int, default `4`): Parallele Detailseiten (nur bei echten Links).
- `delayMs` (int, default `200`): leichte Verzögerung zwischen Interaktionen.

## Output-Schema (Beispiel)
```json
{
  "name": "Bio Musterladen",
  "street": "Musterstraße 1",
  "zip": "20095",
  "city": "Hamburg",
  "lat": 53.55,
  "lng": 10.0,
  "phone": "+49 40 123456",
  "email": "info@example.de",
  "website": "https://example.de",
  "categories": ["Bioladen", "Marktstand"],
  "openingHoursRaw": "Mo-Fr 9-18, Sa 10-14",
  "sourceUrl": "https://.../details/123",
  "plzQuery": "20095",
  "timestamp": "2025-09-24T12:34:56.000Z"
}
```

## Tipps
- Große Läufe in **Batches**: z. B. `startIndex=0&limit=500`, dann `500/500`, etc.
- Bei Strukturänderungen der Website Selektoren in `CONFIG.SELECTORS` anpassen.
- Setze `debug=true`, um die Step-Logs zu sehen.