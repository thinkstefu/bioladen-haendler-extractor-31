
const { Actor, log } = require('apify');
const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

// Website der Händlersuche (bei dir hat diese Methode bereits 90 Ergebnisse geliefert)
const BASE_URL = 'https://www.biomarkt.de/haendler/';

// Selektor-Sets (mehrere Varianten zur Robustheit)
const SEL = {
  zipInput: [
    'input[name*="[zip]"]',
    'input[name*="[plz]"]',
    'input[name*="zip"]',
    'input[placeholder*="PLZ"]',
  ],
  distanceSelect: [
    'select[name*="[distance]"]',
    'select[name*="distance"]',
  ],
  submit: [
    'button[type="submit"]',
    'button:has-text("Suchen")',
    'button:has-text("Suche")',
  ],
  catLabels: {
    bio: ['Bioläden', 'Bioladen', 'Bio-Laden', 'Bio-Läden', 'Biomarkt'],
    market: ['Marktstände', 'Marktstand'],
    delivery: ['Lieferservice', 'Lieferdienst'],
  },
  detailsButton: [
    'a:has-text("Details")',
    'button:has-text("Details")',
    'a.details',
    'button.details',
  ],
  resultCard: [
    '.dealer', '.result', '.shop', 'article', '.card'
  ],
  name: ['.dealer__title', '.result__title', '.shop__title', '.dealer-name', 'h3', 'h2'],
  addressBlock: ['address', '.dealer__address', '.result__address', '.address'],
  phoneLink: ['a[href^="tel:"]'],
  webLink: ['a[href^="http"]', 'a:has-text("Website")', 'a:has-text("Webseite")', 'a:has-text("Zur Website")', 'a:has-text("zur Website")'],
  hours: ['.opening-hours', '.hours', 'table.hours', 'dl.hours', 'div:has-text("Öffnungszeiten")'],
};

function nonEmpty(s) { return (typeof s === 'string' && s.trim().length > 0) ? s.trim() : null; }

async function queryFirst(page, selectors) {
  for (const s of selectors) {
    const el = page.locator(s);
    if (await el.count() > 0) return el.first();
  }
  return null;
}
async function setValueIfExists(page, selectors, value) {
  for (const s of selectors) {
    const el = page.locator(s);
    if (await el.count() > 0) {
      await el.fill('');
      await el.type(String(value), { delay: 10 }).catch(()=>{});
      return true;
    }
  }
  return false;
}
async function clickIfExists(page, selectors) {
  for (const s of selectors) {
    const el = page.locator(s);
    if (await el.count() > 0) {
      await el.first().click({ timeout: 5000 }).catch(()=>{});
      return true;
    }
  }
  return false;
}

async function acceptCookies(page) {
  const candidates = [
    'button:has-text("Alle akzeptieren")',
    'button:has-text("Zustimmen")',
    'button:has-text("Akzeptieren")',
    '[data-accept*="cookie"]',
    '.cookie-accept',
  ];
  for (const s of candidates) {
    const btn = page.locator(s);
    if (await btn.count() > 0) {
      await btn.first().click({ timeout: 2000 }).catch(()=>{});
      log.info('Cookie-Banner akzeptiert.');
      return;
    }
  }
}

function parseAddressLines(text) {
  const lines = (text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  let street = null, plz = null, city = null;
  for (const line of lines) {
    const m = line.match(/(\d{5})\s+(.+)/);
    if (m) { plz = m[1]; city = m[2]; continue; }
    if (!street && /[A-Za-zÄÖÜäöüß]/.test(line) && /\d/.test(line)) street = line;
  }
  return { street, plz, city };
}

async function extractCardData(scope) {
  // Name
  let name = null;
  for (const sel of SEL.name) {
    const el = scope.locator(sel);
    if (await el.count() > 0) {
      name = nonEmpty(await el.first().innerText().catch(()=>null));
      if (name) break;
    }
  }
  // Adresse
  let street=null, plz=null, city=null;
  for (const sel of SEL.addressBlock) {
    const el = scope.locator(sel);
    if (await el.count() > 0) {
      const txt = await el.first().innerText().catch(()=>null);
      const { street: s, plz: p, city: c } = parseAddressLines(txt || '');
      street = street ?? s;
      plz = plz ?? p;
      city = city ?? c;
      if (street || plz || city) break;
    }
  }
  // Telefon
  let phone = null;
  for (const sel of SEL.phoneLink) {
    const el = scope.locator(sel);
    if (await el.count() > 0) {
      const href = await el.first().getAttribute('href').catch(()=>null);
      if (href) { phone = href.replace(/^tel:/, ''); break; }
    }
  }
  // Website
  let website = null;
  for (const sel of SEL.webLink) {
    const el = scope.locator(sel);
    if (await el.count() > 0) {
      const href = await el.first().getAttribute('href').catch(()=>null);
      if (href && /^https?:\/\//i.test(href)) { website = href; break; }
    }
  }
  // Öffnungszeiten (wenn vorhanden)
  let openingHours = null;
  for (const sel of SEL.hours) {
    const el = scope.locator(sel);
    if (await el.count() > 0) {
      openingHours = nonEmpty(await el.first().innerText().catch(()=>null));
      if (openingHours) break;
    }
  }

  return {
    name: name ?? null,
    street: street ?? null,
    zip: plz ?? null,
    city: city ?? null,
    phone: phone ?? null,
    website: website ?? null,
    opening_hours: openingHours ?? null,
  };
}

async function ensureCategories(page) {
  // Versuch per Label-Text
  const byLabel = async (texts) => {
    for (const t of texts) {
      const lbl = page.locator(`label:has-text("${t}")`);
      if (await lbl.count() > 0) {
        await lbl.first().click({ timeout: 3000 }).catch(()=>{});
        return true;
      }
    }
    return false;
  };
  await byLabel(SEL.catLabels.bio);
  await byLabel(SEL.catLabels.market);
  await byLabel(SEL.catLabels.delivery);

  // Zusatz: Falls es einen "Alle" Filter gibt
  await clickIfExists(page, ['label:has-text("Alle")', 'button:has-text("Alle")']);
}

async function setRadius50(page) {
  // 1) Dropdown
  for (const s of SEL.distanceSelect) {
    const el = page.locator(s);
    if (await el.count() > 0) {
      try {
        await el.selectOption('50');
        // Check value
        const selected = await el.evaluate(e => e.value).catch(()=>null);
        if (selected === '50') { log.info('Radius auf 50 km gesetzt (Dropdown).'); return true; }
      } catch {}
    }
  }
  // 2) URL-Fallback
  const u = new URL(page.url());
  u.searchParams.set('tx_biohandel_plg[distance]', '50');
  await page.goto(u.toString(), { waitUntil: 'domcontentloaded' });
  log.info('Radius auf 50 km gesetzt (URL-Fallback).');
  return true;
}

async function searchOnce(page, zip, radiusKm) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await acceptCookies(page);

  // PLZ
  const okZip = await setValueIfExists(page, SEL.zipInput, zip);
  if (!okZip) log.warning('PLZ-Feld nicht gefunden – versuche dennoch fortzufahren.');

  // Radius
  await setRadius50(page);

  // Kategorien
  await ensureCategories(page);

  // Submit
  const submitted = await clickIfExists(page, SEL.submit);
  if (!submitted) {
    // Manche Seiten suchen onChange – zur Sicherheit ENTER im PLZ-Feld
    const zipEl = await queryFirst(page, SEL.zipInput);
    if (zipEl) await zipEl.press('Enter').catch(()=>{});
  }

  // Warten bis Ergebnisse gerendert sind
  await page.waitForTimeout(1000);

  const detailLocators = SEL.detailsButton.map(s => page.locator(s));
  let totalDetails = 0;
  for (const loc of detailLocators) totalDetails += await loc.count().catch(()=>0);
  if (totalDetails === 0) {
    // Manche Seiten zeigen ohne "Details" bereits Karten – in dem Fall zählen wir Karten
    const cards = await queryFirst(page, SEL.resultCard);
    if (cards) {
      totalDetails = await page.locator(SEL.resultCard.join(',')).count().catch(()=>0);
    }
  }
  log.info(`DETAILS buttons: ${totalDetails}`);

  const results = [];
  // Strategie A: Falls Details-Buttons existieren, klicke sie nacheinander
  let detailButtons = page.locator(SEL.detailsButton.join(', '));
  const count = await detailButtons.count().catch(()=>0);

  if (count > 0) {
    for (let i = 0; i < count; i++) {
      try {
        const btn = detailButtons.nth(i);
        await btn.scrollIntoViewIfNeeded().catch(()=>{});
        await btn.click({ timeout: 5000 }).catch(()=>{});
        await page.waitForTimeout(200); // kurze Wartezeit für expandierte Inhalte

        // Suche die nächstliegende Karte
        let scope = btn;
        for (const sel of SEL.resultCard) {
          const parent = btn.locator(`xpath=ancestor-or-self::*[contains(@class, "${sel.replace('.', '')}")]`).first();
          if (await parent.count() > 0) { scope = parent; break; }
        }
        const rec = await extractCardData(scope);
        rec.plz_searched = String(zip);
        rec.category = null; // Seite liefert Kategorie i.d.R. implizit, hier als Platzhalter
        // Null-Default garantieren
        for (const k of ['name','street','zip','city','phone','website','opening_hours','category']) {
          if (typeof rec[k] === 'undefined') rec[k] = null;
        }
        results.push(rec);
      } catch (e) {
        log.warning(`Fehler beim DETAILS ${i+1}/${count}: ${e?.message || e}`);
      }
    }
  } else {
    // Strategie B: Parse Karten ohne Details
    const cardsSel = SEL.resultCard.join(', ');
    const cards = page.locator(cardsSel);
    const c = await cards.count().catch(()=>0);
    for (let i = 0; i < c; i++) {
      const scope = cards.nth(i);
      const rec = await extractCardData(scope);
      rec.plz_searched = String(zip);
      rec.category = null;
      for (const k of ['name','street','zip','city','phone','website','opening_hours','category']) {
        if (typeof rec[k] === 'undefined') rec[k] = null;
      }
      results.push(rec);
    }
  }

  return results;
}

async function loadPLZ(plzSource) {
  if (plzSource === 'embedded') {
    // Fallback: Minimal-Set (kann bei Bedarf erweitert werden)
    return ["20095","80331","50667","60311","70173"];
  }
  // Default: Datei
  const filePath = path.join(__dirname, 'plz_full.json');
  const buf = await fs.readFile(filePath, 'utf8');
  const data = JSON.parse(buf);
  return Array.isArray(data) ? data.map(String) : [];
}

Actor.main(async () => {
  const input = (await Actor.getInput()) || {};
  const startIndex = Number.isInteger(input.startIndex) ? input.startIndex : 0;
  const limit = Number.isInteger(input.limit) ? input.limit : null;
  const radiusKm = input.radiusKm || 50;
  const plzSource = input.plzSource || 'file';

  const plzList = await loadPLZ(plzSource);
  const slice = plzList.slice(startIndex, limit ? startIndex + limit : undefined);
  log.info(`PLZ in Lauf: ${slice.length} (${plzSource === 'file' ? 'aus plz_full.json' : 'embedded'})`);

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(10000);

  let saved = 0;

  for (let i = 0; i < slice.length; i++) {
    const zip = slice[i];
    log.info(`=== ${i+1}/${slice.length} | PLZ ${zip} ===`);
    try {
      const results = await searchOnce(page, zip, radiusKm);
      if (results.length > 0) {
        await Actor.pushData(results);
        saved += results.length;
        log.info(`PLZ ${zip}: ${results.length} neue Datensätze gespeichert`);
      } else {
        log.info(`PLZ ${zip}: 0 neue Datensätze gespeichert`);
      }
    } catch (e) {
      log.warning(`Fehler bei PLZ ${zip}: ${e?.message || e}`);
    }
  }

  // Zusätzlich lokale Dateien ablegen
  const outDir = '/mnt/data/outputs';
  await fs.mkdir(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonlPath = path.join(outDir, `bioladen_${ts}.jsonl`);
  const csvPath = path.join(outDir, `bioladen_${ts}.csv`);

  // JSONL
  const dataset = await Actor.openDataset();
  const all = await dataset.getData();
  const items = all?.items || [];
  await fs.writeFile(jsonlPath, items.map(o => JSON.stringify(o)).join('\n'), 'utf8');

  // Simple CSV writer
  const headers = ['name','street','zip','city','phone','website','opening_hours','category','plz_searched'];
  const toCell = (v) => {
    if (v === null || typeof v === 'undefined') return '';
    const s = String(v).replace(/"/g, '""');
    return `"${s}"`;
  }
  const csv = [headers.map(h => `"${h}"`).join(',')].concat(
    items.map(it => headers.map(h => toCell(it[h])).join(','))
  ).join('\n');
  await fs.writeFile(csvPath, csv, 'utf8');

  log.info(`Fertig. Insgesamt gespeichert: ${saved}`);
  log.info(`Lokale Dateien: ${jsonlPath} | ${csvPath}`);

  await browser.close();
});
