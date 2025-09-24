# Bioladen-Händler-Extractor

Playwright + Apify Actor (SDK v3). Reused single page, sets **PLZ** + **Radius 50 km**, clicks cookie-banner nur einmal,
klickt alle **Details**-Buttons und extrahiert Name, Typ (Bioladen/Marktstand/Lieferservice), Straße, PLZ, Ort, Telefon, E-Mail, Webseite, Öffnungszeiten.

## Start (lokal)
```bash
npm install
node main.js
```

## Auf Apify
- Dieses Repo als Actor-Source verwenden.
- `Dockerfile` unverändert lassen (Image installiert Browser und führt `node main.js` aus).
- Input optional: `{ "plz": ["20095","80331",...], "concurrency": 1 }`

## Dateien
- `Dockerfile`: robuster Build ohne Permission-Fehler
- `package.json`: ESM + SDK v3
- `main.js`: Logik
- `plz_full.json`: Beispiel-PLZ-Liste (Hamburg, München, Köln, Frankfurt, Stuttgart). Ersetze durch deine 7.9k PLZ.

