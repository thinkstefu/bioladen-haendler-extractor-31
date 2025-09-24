# bioladen-haendler-extractor

Extrahiert Händlerdaten von **bioladen.de** über die Suche (PLZ + Radius 50km). Klickt pro Ergebnis auf **DETAILS** und speichert strukturierte Felder.

## Input
Optional via Actor-Input:
```json
{
  "postalCodes": ["20095","80331","50667","60311","70173"],
  "radiusKm": 50
}
```
Wenn leer, wird `plz_full.json` genutzt.

## Output (Dataset)
Felder:
- name, kategorie, strasse, plz, ort, telefon, email, website, oeffnungszeiten, source_plz

## Hinweise
- Cookie-Banner wird nur einmal akzeptiert.
- Kategorien **Bioläden**, **Marktstände** und **Lieferservice** werden (falls vorhanden) aktiviert.
- Radius wird **quer** gesetzt: Query-Parameter, Select-Feld + `change` + Formular-Submit.
