# bioladen-haendler-extractor (stabil)

Stabiler Apify Actor mit Playwright:
- **Keine** Abhängigkeit von `npm ci` (Build-fail fix).
- Dockerfile installiert als `root` → keine **EACCES**-Fehler, danach Wechsel zu `myuser`.
- **Actor.main** (Apify v3) → kein `Apify.main is not a function` mehr.
- 50 km Radius via **UI** oder **URL-Fallback**.
- Kategorien **Bioläden / Marktstände / Lieferservice** werden erzwungen (UI / Text / Fallback).
- **Alle PLZ** aus `plz_full.json` (kann per Input begrenzt werden).
- Sauberes Output-Schema; fehlende Felder werden als `null` gespeichert.

## Input (optional)
```json
{
  "baseUrl": "https://BEISPIEL.DOMAIN/haendlersuche",
  "maxZips": 0,
  "startAt": 0,
  "pauseMs": 150
}
```
- **baseUrl**: Trefferlisten-Seite der Händlersuche. Wenn NICHT gesetzt, wird `DEFAULT_BASE_URL` im Code verwendet.
- **maxZips**: 0 = alle. Zum Testen z. B. 50.
- **startAt**: Startindex in der PLZ-Liste.
- **pauseMs**: kleine Pause pro Detail (Stabilität vs. Speed).

Alternativ über Umgebungsvariablen:

- `BASE_URL` (überschreibt Default)
- `CONCURRENCY` (derzeit nicht genutzt, vorbereitet)
- `PAUSE_MS`

## Apify Run-Optionen
- **Timeout**: mind. **3600 s** (1 h) oder höher.
- **Memory**: 1024 MB+.
- **CPU concurrency**: 1 (eine Seite), internes Paging erledigt das Script.

## Hinweise
- Wenn das UI-Setzen von Radius/PLZ scheitert, wird automatisch eine URL mit Query-Parametern aufgerufen (`plz=XXXXX&radius=50&types=bioladen,markt,liefer`).
- Die Felder im Datensatz sind: `name, street, zip, city, phone, email, website, opening_hours_raw, categories, source_zip`.
- Alle Felder sind **nullable**; leere Felder werden als `null` gespeichert.

Viel Erfolg!
