# Bioladen Händler Extractor

- **Start-URL:** https://www.bioladen.de/bio-haendler-suche
- **Vorgehen:** Einmalige Navigation, Cookie-Banner akzeptieren, PLZ + Radius=50 km setzen,
  alle Kategorien (Bioläden, Marktstände, Lieferservice) aktivieren, dann alle `Details`-Modals öffnen
  und Daten extrahieren.
- **Input (optional):**
```json
{
  "postalCodes": ["20095","80331","50667","60311","70173"],
  "radiusKm": 50
}
```
- **Output:** Apify Dataset (JSON/CSV), Felder: `name, kategorie, strasse, plz, ort, telefon, email, web, oeffnungszeiten, lat, lng, sourceZip`

## Apify Build
Actor kann ohne eigenes Browser-Install gebaut werden (Chrome ist im Base-Image vorhanden).

