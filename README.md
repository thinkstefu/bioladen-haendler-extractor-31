# Bioladen-Händler-Extractor (stabiler Build)

Dieses Paket ist so gebaut, dass es ohne zusätzliche Playwright-Installs läuft
(Base-Image `apify/actor-node-playwright-chrome:20`). Es nutzt Apify v3
korrekt mit `Actor.main` und setzt den Umkreis auf 50 km per UI, mit
robustem URL-Fallback.

## Start (Apify)
- **Optionaler Input (JSON):**
  ```json
  {
    "baseUrl": "https://DEINE-HAENDLERSUCHE-URL",
    "startAt": 0,
    "maxZips": 200,
    "slowMode": false
  }
  ```
  Wenn `baseUrl` nicht gesetzt ist, wird ein **Default** genutzt. Trage hier am besten die
  Trefferlisten-Seite deiner Händlersuche ein.

- **Run options:**
  - Timeout: mind. 1h für große Läufe
  - Memory: 2048 MB oder mehr (je nach Umfang)

## Hinweise
- Der Actor interagiert zuerst per UI (PLZ tippen, Radius 50 km wählen, Kategorien setzen).
  Wenn das scheitert, versucht er **mehrere** URL-Varianten:
  `?plz=XXXXX&radius=50`, `?zip=XXXXX&distance=50`, `?postalCode=XXXXX&umkreis=50`.
- Wenn für eine PLZ **0 Treffer** festgestellt werden, wird ein **Screenshot** gespeichert.
- Alle Felder sind **null-sicher**; wenn etwas nicht gefunden wird, landet `null` in der Spalte.
- Selektoren sind zentral in `SELECTORS` definierbar.

## Output
- Datensätze werden in das Standard-Apify-Dataset geschrieben.
- Screenshots landen im Key-Value Store (nur bei Debug/Fehlerfällen).

## Bekannte Ursachen für „0 Ergebnisse“
- Falsche/abweichende Parameternamen im Fallback (daher mehrere Varianten implementiert)
- Die Seite verlangt **Geocoding** durch Enter-Auswahl (UI-Modus kümmert sich darum)
- Lazy Loading der Liste (wir scrollen + warten)
- Rate-Limits/Anti-Bot (wir haben Delays/Retry-Strategie eingebaut)
