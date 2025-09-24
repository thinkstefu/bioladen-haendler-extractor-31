import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';

// ==== Selektor-Strategie (mehrere Fallbacks) ====
const SELECTORS = {
  // Eingaben
  zipInput: [
    'input[name="zip"]',
    'input[id*="zip"]',
    'input[placeholder*="PLZ"]',
    'input[type="search"][aria-label*="PLZ"]',
  ],
  radiusSelect: [
    'select[name*="radius"]',
    'select#radius',
    'select[aria-label*="Umkreis"]',
  ],
  radiusOpeners: [
    'label:has-text("Umkreis")',
    '[data-test="radius"]',
  ],
  radiusOption50: [
    'text=/^\s*50\s*km\s*$/',
    'option[label="50 km"]',
    'option:has-text("50 km")',
  ],
  searchButton: [
    'button:has-text("Suchen")',
    'button[type="submit"]',
    '[data-test="search"]',
  ],
  // Typen
  typeLabels: [
    { label: 'Bioläden',  selector: 'label:has-text("Bioläden") input[type="checkbox"]' },
    { label: 'Marktstände', selector: 'label:has-text("Marktstände") input[type="checkbox"]' },
    { label: 'Lieferservice', selector: 'label:has-text("Lieferservice") input[type="checkbox"]' },
  ],
  // Ergebnisliste
  resultCard: [
    '.result-card',
    '[data-test="result-card"]',
    'article:has(button:has-text("Details"))',
    'li:has(.details-button)',
    'article',
  ],
  // Felder in Karten
  name: ['h3','h2','.title','[data-test="name"]'],
  street: ['.street','[data-test="street"]','address','.addr'],
  zip: ['.zip','[data-test="zip"]'],
  city: ['.city','[data-test="city"]'],
  phone: ['a[href^="tel:"]','.phone','[data-test="phone"]'],
  websiteLink: ['a[href^="http"]'],
  // Details öffnen (optional)
  detailsOpeners: ['button:has-text("Details")','a:has-text("Details")','[data-test="details"]'],
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function clickIfVisible(page, selector, timeout = 1500) {
  try {
    const el = await page.waitForSelector(selector, { timeout });
    if (el) { await el.click({ delay: 20 }); return true; }
  } catch {}
  return false;
}

async function fillIfVisible(page, selector, value, timeout = 1500) {
  try {
    const el = await page.waitForSelector(selector, { timeout });
    if (el) { await el.fill(''); await el.type(value, { delay: 10 }); return true; }
  } catch {}
  return false;
}

async function selectRadius50(page) {
  // 1) Direktes <select> versuchen
  for (const sel of SELECTORS.radiusSelect) {
    try {
      const has = await page.$(sel);
      if (has) {
        const handled = await page.selectOption(sel, { label: '50 km' }).catch(()=>false);
        if (handled) return true;
      }
    } catch {}
  }
  // 2) Dropdown öffnen + Option klicken
  for (const open of SELECTORS.radiusOpeners) {
    const opened = await clickIfVisible(page, open, 800);
    if (opened) {
      for (const opt of SELECTORS.radiusOption50) {
        const ok = await clickIfVisible(page, opt, 600);
        if (ok) return true;
      }
    }
  }
  return false;
}

async function setTypes(page) {
  for (const t of SELECTORS.typeLabels) {
    try {
      const input = await page.$(t.selector);
      if (input) {
        const checked = await input.isChecked();
        if (!checked) await input.check();
      }
    } catch {}
  }
}

async function setZipAndRadiusUI(page, zip) {
  let zipOk = false;
  for (const sel of SELECTORS.zipInput) {
    if (await fillIfVisible(page, sel, String(zip))) { zipOk = true; break; }
  }
  const radiusOk = await selectRadius50(page);
  return { zipOk, radiusOk };
}

function buildUrlWithParams(baseUrl, zip, zipParam='zip', radiusParam='radius') {
  try {
    const u = new URL(baseUrl);
    u.searchParams.set(zipParam, String(zip));
    u.searchParams.set(radiusParam, '50');
    return u.toString();
  } catch {
    return null;
  }
}

async function ensureResultsLoaded(page) {
  // sanft warten, ohne hart zu scheitern
  await sleep(700);
  for (let i = 0; i < 3; i++) {
    const anyCard = await page.$(SELECTORS.resultCard.join(','));
    if (anyCard) return true;
    await sleep(800);
  }
  return false;
}

async function extractFromCard(card) {
  const getText = async (selectors) => {
    for (const sel of selectors) {
      try {
        const h = await card.$(sel);
        if (h) {
          const t = (await h.textContent())?.trim();
          if (t) return t;
        }
      } catch {}
    }
    return null;
  };
  const getAttr = async (selectors, attr) => {
    for (const sel of selectors) {
      try {
        const h = await card.$(sel);
        if (h) {
          const v = await h.getAttribute(attr);
          if (v) return v;
        }
      } catch {}
    }
    return null;
  };

  const name = await getText(SELECTORS.name);
  const street = await getText(SELECTORS.street);
  const zip = await getText(SELECTORS.zip);
  const city = await getText(SELECTORS.city);
  const phone = await getText(SELECTORS.phone);
  const website = await getAttr(SELECTORS.websiteLink, 'href');

  return {
    name: name ?? null,
    street: street ?? null,
    zip: zip ?? null,
    city: city ?? null,
    phone: phone ?? null,
    website: website ?? null,
  };
}

async function maybeOpenDetailsAndFill(page, cardHandle, rec) {
  if (rec.website && rec.phone) return rec; // schon gut genug

  for (const opener of SELECTORS.detailsOpeners) {
    try {
      const btn = await cardHandle.$(opener);
      if (btn) {
        await btn.click();
        // kurze Wartezeit für Details
        await sleep(500);
        // versuche erneut Felder zu lesen – diesmal seitenweit (nicht auf card beschränkt)
        const getText = async (selectors) => {
          for (const sel of selectors) {
            try {
              const h = await page.$(sel);
              if (h) {
                const t = (await h.textContent())?.trim();
                if (t) return t;
              }
            } catch {}
          }
          return null;
        };
        const getAttr = async (selectors, attr) => {
          for (const sel of selectors) {
            try {
              const h = await page.$(sel);
              if (h) {
                const v = await h.getAttribute(attr);
                if (v) return v;
              }
            } catch {}
          }
          return null;
        };

        rec.website = rec.website ?? await getAttr(SELECTORS.websiteLink, 'href');
        rec.phone   = rec.phone   ?? await getText(SELECTORS.phone);
        break;
      }
    } catch {}
  }
  return rec;
}

await Actor.init();
try {
  const input = (await Actor.getInput()) ?? {};
  // 1) baseUrl bestimmen
  let baseUrl = input.baseUrl;
  if (!baseUrl) {
    try {
      baseUrl = (await fs.readFile('BASE_URL.txt','utf8')).trim();
    } catch {}
  }
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    log.error('Keine gültige `baseUrl` gefunden. Bitte im Input oder in BASE_URL.txt setzen (Trefferlisten-Seite!).');
    await Actor.exit();
    process.exit(0);
  }

  // 2) PLZ-Liste laden
  let plzList = input.plzList;
  if (!plzList) {
    try { plzList = JSON.parse(await fs.readFile('plz_full.json','utf8')); }
    catch { plzList = ['20095','80331','50667','60311','70173']; }
  }
  if (!Array.isArray(plzList) || plzList.length === 0) {
    log.error('PLZ-Liste ist leer. Bitte `plzList` im Input setzen oder plz_full.json bereitstellen.');
    await Actor.exit();
    process.exit(0);
  }
  log.info(`PLZ in Lauf: ${plzList.length} (aus plz_full.json)`);

  const openDetailsIfMissing = !!input.openDetailsIfMissing;
  const zipParam = input.zipParam || 'zip';
  const radiusParam = input.radiusParam || 'radius';

  // 3) Browser
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  let savedTotal = 0;

  for (let i = 0; i < plzList.length; i++) {
    const zip = String(plzList[i]).padStart(5,'0');
    log.info(`=== ${i+1}/${plzList.length} | PLZ ${zip} ===`);

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});

    // Cookie Banner wegklicken
    for (const btn of ['button:has-text("Akzeptieren")','text=Alle akzeptieren','button:has-text("Zustimmen")']) {
      await clickIfVisible(page, btn, 1500);
    }
    // UI setzen
    const { zipOk, radiusOk } = await setZipAndRadiusUI(page, zip);

    if (!radiusOk || !zipOk) {
      // URL-Fallback
      const urlFb = buildUrlWithParams(baseUrl, zip, zipParam, radiusParam);
      if (urlFb) {
        await page.goto(urlFb, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
        log.info('UI-Setzen nicht vollständig – URL-Fallback mit 50 km & PLZ angewendet.');
      } else {
        log.warning('Weder UI-Setzen noch URL-Fallback möglich – überspringe diese PLZ.');
        continue;
      }
    }

    // Suchen auslösen (wenn vorhanden)
    let triggered = false;
    for (const sb of SELECTORS.searchButton) {
      if (await clickIfVisible(page, sb, 1000)) { triggered = True; break; }
    }
    await sleep(500);

    // Warten auf Ergebnisse
    const ok = await ensureResultsLoaded(page);
    const cards = await page.$$(SELECTORS.resultCard.join(','));
    log.info(`DETAILS buttons: (n/a) | Result-Cards: ${cards.length}`);

    let savedHere = 0;
    for (const card of cards) {
      let rec = await extractFromCard(card);
      rec = Object.assign({ zipInput: zip, source: 'list' }, rec);

      if (openDetailsIfMissing) {
        rec = await maybeOpenDetailsAndFill(page, card, rec);
      }
      // normalize: ensure keys exist
      rec = {
        name: rec.name ?? null,
        street: rec.street ?? null,
        zip: rec.zip ?? null,
        city: rec.city ?? null,
        phone: rec.phone ?? null,
        website: rec.website ?? null,
        zipInput: rec.zipInput ?? zip,
        source: rec.source ?? 'list'
      };
      await Actor.pushData(rec);
      savedHere++;
    }
    savedTotal += savedHere;
    log.info(`PLZ ${zip}: ${savedHere} neue Datensätze gespeichert`);
  }

  log.info(`Fertig. Insgesamt gespeichert: ${savedTotal}`);

  await page.close();
  await browser.close();
} catch (e) {
  log.exception(e, 'FATAL');
  throw e;
} finally {
  await Actor.exit();
}
