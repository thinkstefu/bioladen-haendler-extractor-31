// @ts-check
import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const DEFAULT_BASE_URL = process.env.BASE_URL || 'https://example.com/haendlersuche';
const DEFAULT_CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const DEFAULT_PAUSE_MS = Number(process.env.PAUSE_MS || 150); // leichte Pause pro Detail für Stabilität

/** Utility to sleep */
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/** Try to safely click one of several selectors */
async function tryClick(page, selectors, options={}) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel);
      if (await loc.count()) {
        await loc.first().click({ timeout: 3000, ...options });
        return true;
      }
    } catch (_) {}
  }
  return false;
}

/** Accept cookie banners heuristically */
async function acceptCookies(page) {
  const ok = await tryClick(page, [
    'button:has-text("Alle akzeptieren")',
    'button:has-text("Zustimmen")',
    'button:has-text("Akzeptieren")',
    'button[aria-label*="accept" i]',
    '[id*="accept"]',
    'text=/Alle.*akzeptieren/i',
  ], { force: TrueIfSupported() });
  if (ok) log.info('Cookie-Banner akzeptiert.');
}

/** Workaround for Playwright boolean option across versions */
function TrueIfSupported() { return true; }

/** Fill PLZ, pick 50km, select categories, submit. Fallback: navigate with URL params */
async function setZipRadiusCategories(page, baseUrl, zip) {
  let usedUrlFallback = false;

  // try UI first
  try {
    // zip input
    const zipSel = await page.locator('input[name*="plz" i], input[name*="zip" i], input[placeholder*="PLZ" i], input[type="search"]').first();
    if (await zipSel.count()) {
      await zipSel.fill(String(zip));
    } else {
      log.warn('PLZ-Feld nicht gefunden – versuche dennoch fortzufahren.');
      usedUrlFallback = true;
    }

    // radius 50km
    if (!usedUrlFallback) {
      const select50 = page.locator('select').filter({ hasText: /50\s*km/i }).first();
      const anySelect = page.locator('select[name*="radius" i], select[name*="umkreis" i]').first();
      let setViaSelect = false;
      if (await select50.count()) {
        try { await select50.selectOption({ label: /50\s*km/i }); setViaSelect = true; } catch {}
      }
      if (!setViaSelect && await anySelect.count()) {
        try { await anySelect.selectOption({ label: /50\s*km/i }); setViaSelect = true; } catch {}
      }
      if (!setViaSelect) usedUrlFallback = true;
    }

    // categories
    const ensureChecked = async (label) => {
      try {
        const loc = page.getByLabel(new RegExp(label, 'i'));
        if (await loc.count()) {
          const el = loc.first();
          try { await el.check({ force: true }); } catch {}
        } else {
          // sometimes it's a toggle by text
          await tryClick(page, [`text=${label}`]);
        }
      } catch {}
    };
    await ensureChecked('Bioladen|Bioläden|Biomarkt');
    await ensureChecked('Marktstand|Marktstände|Wochenmarkt');
    await ensureChecked('Lieferservice|Lieferung');

    // submit
    await tryClick(page, [
      'button:has-text("Suchen")',
      'input[type="submit"]',
      'button[aria-label*="suchen" i]'
    ]);

  } catch {
    usedUrlFallback = true;
  }

  if (usedUrlFallback) {
    // URL fallback with params
    const sep = baseUrl.includes('?') ? '&' : '?';
    const url = `${baseUrl}${sep}plz=${encodeURIComponent(String(zip))}&radius=50&types=bioladen,markt,liefer`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    log.info('Radius auf 50 km gesetzt (URL-Fallback).');
  }
}

/** Extract text helper */
const txt = async (locator) => {
  try { return (await locator.innerText({ timeout: 1000 })).trim(); } catch { return null; }
};

/** Normalize value or set to null */
const nn = (v) => (v === undefined || v === '' ? null : v);

/** Extract single result from a container */
async function extractFromContainer(container, fallbackZip) {
  const allText = (await container.allInnerTexts().catch(() => [])).join('\n');
  const extract = (re) => {
    const m = allText.match(re);
    return m ? m[1].trim() : null;
  };

  // Try explicit fields by common selectors
  const name = await txt(container.locator('h3, h2, .name, .store-name').first()) || extract(/^\s*([^\n]+)\n/);
  const street = await txt(container.locator('.street, [itemprop="streetAddress"]').first()) ||
    extract(/([\wÄÖÜäöüß\-\.\s]+(?:straße|str\.|weg|platz|allee|gasse|ring)[^\n,]*)/i);
  const zipCity = await txt(container.locator('.zip-city, .postal, [itemprop="postalCode"]').first()) ||
    extract(/(\d{5})\s+([A-Za-zÄÖÜäöüß\-\s]+)/);
  let plz = null, city = null;
  if (zipCity) {
    const m = zipCity.match(/(\d{5})\s+(.+)/);
    if (m) { plz = m[1]; city = m[2].trim(); }
  } else {
    // try split lines
    const m = allText.match(/(\d{5})\s+([A-Za-zÄÖÜäöüß\-\s]+)/);
    if (m) { plz = m[1]; city = m[2].trim(); }
  }
  const phone = extract(/(?:Tel\.?|Telefon)\s*[:\s]*([+()\d\/\-\s]+)/i);
  const emailMatch = allText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const email = emailMatch ? emailMatch[0] : null;
  const website = await container.locator('a[href^="http"]').first().getAttribute('href').catch(() => null);
  const categories = ['Bioladen','Marktstand','Lieferservice'].filter(c => new RegExp(c, 'i').test(allText)).join(',') || null;

  // Öffnungszeiten (raw blob)
  const opening = extract(/Öffnungszeiten\s*:?\s*([\s\S]+)/i);

  return {
    name: nn(name),
    street: nn(street),
    zip: nn(plz || fallbackZip),
    city: nn(city),
    phone: nn(phone ? phone.replace(/\s+/g, ' ').trim() : null),
    email: nn(email),
    website: nn(website),
    opening_hours_raw: nn(opening),
    categories: nn(categories),
    source_zip: nn(fallbackZip),
  };
}

await Actor.main(async () => {
  const input = await Actor.getInput() || {};
  const baseUrl = input.baseUrl || DEFAULT_BASE_URL;
  const maxZips = Number(input.maxZips || 0); // 0 = all
  const startAt = Number(input.startAt || 0);
  const pauseMs = Number(input.pauseMs || DEFAULT_PAUSE_MS);

  // Load PLZs embedded
  let plzList = [];
  try {
    const p = path.join(process.cwd(), 'plz_full.json');
    plzList = JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    plzList = Array.isArray(input.plzList) ? input.plzList : [];
  }
  if (!Array.isArray(plzList) || plzList.length === 0) {
    throw new Error('Keine PLZs gefunden (plz_full.json oder input.plzList).');
  }

  const slice = plzList.slice(startAt, maxZips ? startAt + maxZips : undefined);
  log.info(`PLZ in Lauf: ${slice.length} (aus plz_full.json)`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  let savedTotal = 0;

  for (let i = 0; i < slice.length; i++) {
    const zip = String(slice[i]).padStart(5, '0');
    log.info(`=== ${i + 1}/${slice.length} | PLZ ${zip} ===`);

    // Go to base URL (list page) and accept cookies
    try {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch {}
    await acceptCookies(page);

    // Setup UI or URL fallback
    await setZipRadiusCategories(page, baseUrl, zip);

    // Wait for results to render
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // Find result containers or details buttons
    let detailButtons = page.locator('button:has-text("Details"), a:has-text("Details")');
    let count = await detailButtons.count().catch(() => 0);

    // fallback: card containers if no explicit details buttons
    let containers = null;
    if (count === 0) {
      containers = page.locator('[data-testid*="result"], .result, .search-result, .store-card, li:has(.store)');
      const cCount = await containers.count().catch(() => 0);
      log.info(`DETAILS buttons: ${count} | Result-Cards: ${cCount}`);
      if (cCount === 0) {
        log.info(`PLZ ${zip}: 0 neue Datensätze gespeichert`);
        continue;
      }
      const results = [];
      for (let idx = 0; idx < cCount; idx++) {
        const cont = containers.nth(idx);
        const row = await extractFromContainer(cont, zip);
        results.push(row);
        await wait(pauseMs);
      }
      if (results.length) {
        await Actor.pushData(results);
        savedTotal += results.length;
        log.info(`PLZ ${zip}: ${results.length} neue Datensätze gespeichert`);
      } else {
        log.info(`PLZ ${zip}: 0 neue Datensätze gespeichert`);
      }
      continue;
    }

    log.info(`DETAILS buttons: ${count}`);

    const results = [];
    for (let idx = 0; idx < count; idx++) {
      try {
        const btn = detailButtons.nth(idx);
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await btn.click({ timeout: 5000 }).catch(() => {});

        // after expanding, use nearest container
        const container = btn.locator('..').locator('..');
        const row = await extractFromContainer(container, zip);
        results.push(row);
        await wait(pauseMs);
      } catch {}
    }

    if (results.length) {
      await Actor.pushData(results);
      savedTotal += results.length;
      log.info(`PLZ ${zip}: ${results.length} neue Datensätze gespeichert`);
    } else {
      log.info(`PLZ ${zip}: 0 neue Datensätze gespeichert`);
    }
  }

  await browser.close();
  log.info(`Fertig. Insgesamt gespeichert: ${savedTotal}`);
});
