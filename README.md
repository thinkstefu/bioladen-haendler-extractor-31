# Bioladen Händler Extractor

Stabilisierte Actor-Version mit folgenden Fixes:
- **EACCES**-Probleme beim Build behoben (Installation als `myuser`, `COPY --chown=...`, `WORKDIR` + `chown`).
- Radius **robust auf 50 km** (Dropdown → URL-Fallback).
- **Kategorien** werden **alle** aktiviert (Bioläden, Marktstände, Lieferservice).
- **Parsing** säubert Felder, füllt fehlende mit `null` und setzt **Name** korrekt.
- **Timeout**/Chunking parametrisierbar (Input).

## Run-Optionen (Input JSON)
```json
{
  "startIndex": 0,
  "limit": 500,
  "radiusKm": 50,
  "plzSource": "file"  // "file" = aus plz_full.json lesen, "embedded" = interne Liste
}
```
> Hinweis: Für die vollständigen 7.9k PLZ in einem Run bitte Timeout >= 60 Min setzen oder in Batches laufen lassen (`startIndex` + `limit`).

## Starten
Apify UI/CLI startet automatisch `node main.js` (im Image headless mit xvfb).

## Output
- Alle Datensätze werden in das Apify Dataset gepusht (mit `null`-Defaults).
- Zusätzlich wird unter `/mnt/data/outputs/` ein CSV/JSONL je Run abgelegt.
