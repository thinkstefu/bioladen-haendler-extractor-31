# bioladen-haendler-extractor

Actor, der die bioladen.de-Händlersuche über PLZ + Radius **50 km** crawlt, alle Kategorien mitnimmt, Modals direkt parst und saubere CSV/JSON ausgibt.

## Quickstart (Apify)
1) Actor aus diesem ZIP bauen (Dockerfile ist enthalten).
2) `plz_full.json` ggf. mit deiner großen Liste ersetzen.
3) Run starten – Ergebnisse landen im Dataset.

## Spalten
name, kategorie, strasse, plz, ort, telefon, email, website, oeffnungszeiten, source_plz, source_url, lat, lon
