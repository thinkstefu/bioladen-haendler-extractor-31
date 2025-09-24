# Bioladen-Händler-Extractor (stabil)

Dieses Paket ist auf **Apify** (oder lokal mit dem Base-Image) lauffähig und vermeidet die Fehler aus dem bisherigen Verlauf:
- Playwright-Browser kommt vom Base-Image (`apify/actor-node-playwright-chrome:20`), **keine** Browser-Nachinstallation.
- **CommonJS** + `Actor.main` (kein `Apify.main`-Fehler).
- `npm install` als **root** + Besitzrechte an `myuser`, dadurch keine **EACCES**-Fehler.
- UI‑Auswahl **50 km** Radius; Fallback über URL‑Parameter.
- Cookie‑Banner‑Handling.
- Robuste Extraktion von **Name, Adresse, Telefon, Website, Typ** mit `null`‑Defaults.
- **Screenshots** bei 0 Treffern.

## Input (Apify)
```json
{
  "baseUrl": "HIER-DIE-TREFFERLISTEN-URL-ANGEBEN",
  "startAt": 0,
  "maxZips": 999999,
  "slowMode": false,
  "headful": false
}
```

- `baseUrl` muss die **Trefferlisten-Seite** der Händlersuche sein (die Seite, auf der die Resultate erscheinen). Genau diese hast du bei dem Lauf mit ~90 Ergebnissen benutzt.
- Timeout im Actor auf **>= 60 Minuten** stellen, RAM >= 2048 MB.

## Ausgabe
- Daten landen im **Dataset** (Apify) mit konsistenter Schema-Form.
- Felder, die nicht gefunden werden, sind **null**.
- Pro PLZ mit 0 Treffern wird ein Screenshot `no_results_<ZIP>.png` im Key-Value-Store gespeichert.

## Lokal testen (optional)
```bash
docker build -t bio-extractor .
docker run --rm -e APIFY_INPUT='{"baseUrl":"https://example.com/suche"}' bio-extractor
```