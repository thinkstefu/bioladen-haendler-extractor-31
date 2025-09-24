# bioladen-haendler-extractor (robuste Version)

Diese Version ist auf Stabilität getrimmt und entspricht der Strategie des erfolgreichen Laufs
(≈90 Treffer): **PLZ & 50-km-Umkreis per UI setzen**, alle Typen aktivieren (Bioläden, Marktstände,
Lieferservice), Ergebnis-Karten direkt aus der Trefferliste parsen. Fehlende Felder werden als `null`
gespeichert.

## Quickstart (Apify Console)
1. Erstelle einen neuen Actor und lade dieses ZIP hoch (oder pushe nach GitHub & verlinke).
2. **Input > JSON** Beispiel:
   ```json
   {
     "baseUrl": "HIER-DIE-TREFFERLISTEN-URL-EINTRAGEN",
     "openDetailsIfMissing": false,
     "zipParam": "zip",
     "radiusParam": "radius"
   }
   ```
   - `baseUrl` = Trefferlisten-Seite deiner Händlersuche (nicht die Start-/Splash-Seite).
   - Wenn du `baseUrl` nicht setzt, versucht das Skript `BASE_URL.txt` zu lesen. Ist auch dort nichts
     eingetragen, wird ein Fehler geloggt und der Run beendet sich sauber.
3. **Run options**: Timeout z. B. auf 60 Minuten erhöhen.
4. Output findest du im **Dataset** des Runs (CSV/JSON).

## Wichtige Merkmale
- **UI-First:** PLZ und Umkreis werden über die sichtbaren UI-Elemente gesetzt (mehrere Selektoren).
  Erst wenn das nicht klappt, wird ein URL-Query-Fallback versucht (`zipParam`/`radiusParam`).
- **Alle Typen aktiv:** Checkboxen „Bioläden“, „Marktstände“, „Lieferservice“ werden explizit aktiviert.
- **Resultate direkt von der Liste:** Für Geschwindigkeit werden Felder direkt aus den Karten
  extrahiert. Fehlt z. B. `website` oder `phone`, kann optional `openDetailsIfMissing=true` gesetzt
  werden, damit pro Karte die Detailansicht geöffnet wird (langsamer).
- **Null statt leere Strings:** Jedes erwartete Feld ist vorhanden; nicht gefundene Werte sind `null`.
- **Robuste Fehlerlogs:** Globale Handler für unerwartete Exceptions, Warnungen statt harter Abbrüche.

## Konfigurierbare Selektoren (falls sich das Ziel-HTML ändert)
- In `main.js` ganz oben findest du `SELECTORS`. Passe sie bei Bedarf an. Es gibt mehrere Fallbacks pro Feld.

## Dateien
- `Dockerfile` – fixes Build (keine EACCES-Probleme) mit Playwright-Chrome Base-Image.
- `package.json` – Apify v3 (`Actor.*`-API) & Playwright.
- `main.js` – die eigentliche Logik.
- `plz_full.json` – vollständige PLZ-Liste (aus deinem Upload; Fallback drin).
- `BASE_URL.txt` – optionaler Ort, um die Trefferlisten-URL statisch zu hinterlegen.

Viel Erfolg! ✨
