import Apify from 'apify';
import { chromium } from 'playwright';

const START_URL = 'https://www.bioladen.de/bio-haendler-suche';
const RADIUS_KM = '50';
const INPUT_FILE = 'plz_full.json';

// --- helpers ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function blockAssets(page) {
  await page.route('**/*', route => {
    const req = route.request();
    const type = req.resourceType();
    if (['image','font','stylesheet','media'].includes(type)) return route.abort();
    // block some 3rd party noise
    const url = req.url();
    if (/google|facebook|doubleclick|analytics|fonts\.gstatic|fonts\.google/i.test(url)) return route.abort();
    return route.continue();
  });
}

async function acceptCookies(page) {
  try {
    const btns = page.locator('button, [role="button"]');
    for (const text of ['Alle akzeptieren','Akzeptieren','Zustimmen','Einverstanden']) {
      const btn = btns.filter({ hasText: new RegExp(text, 'i') }).first();
      if (await btn.count()) { await btn.click({ timeout: 2000 }); break; }
    }
  } catch { /* ignore */ }
}

async function setRadiusAndCategories(page) {
  // 1) Radius-Dropdown konsequent auf 50 setzen (mehrfach versuchen)
  const radiusSel = 'select[name*="distance"]';
  for (let i=0;i<2;i++) {
    try {
      await page.locator(radiusSel).first().selectOption(RADIUS_KM, { timeout: 2000 });
      const val = await page.locator(radiusSel).first().inputValue();
      if (val === RADIUS_KM) break;
    } catch { /* retry next loop */ }
  }

  // 2) Alle Kategorien aktivieren (Checkboxen: Bioläden, Marktstände, Lieferservice)
  const checkAll = async (label) => {
    try {
      const byLabel = page.getByLabel(new RegExp(label, 'i')).first();
      if (await byLabel.count()) {
        const checked = await byLabel.isChecked().catch(() => false);
        if (!checked) await byLabel.check({ timeout: 1000 });
        return;
      }
    } catch {}
    // Fallback: suche Checkboxen in Filtern
    const candidates = page.locator('input[type="checkbox"]');
    const count = await candidates.count();
    for (let i=0;i<count;i++) {
      const el = candidates.nth(i);
      const id = await el.getAttribute('id').catch(()=>null);
      const name = await el.getAttribute('name').catch(()=>'');
      const lab = id ? page.locator(`label[for="${id}"]`).first() : null;
      const labTxt = lab ? (await lab.innerText().catch(()=>'')) : '';
      if (/(bioladen|markt|liefer)/i.test(labTxt) || /(bioladen|markt|liefer)/i.test(name||'')) {
        const checked = await el.isChecked().catch(()=>false);
        if (!checked) await el.check({ timeout: 500 });
      }
    }
  };
  await checkAll('Bioläden');
  await checkAll('Marktstände');
  await checkAll('Lieferservice');
}

async function navigateWithQuery(page, zip) {
  // URL-Query nutzt PLZ + Distance
  const url = `${START_URL}?tx_biohandel_plg[searchplz]=${encodeURIComponent(zip)}&tx_biohandel_plg[distance]=${RADIUS_KM}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await acceptCookies(page);
  await setRadiusAndCategories(page);

  // Submit, falls es einen Submit-Button gibt (um sicher serverseitig zu suchen)
  const submitBtn = page.locator('form button[type="submit"], form input[type="submit"]').first();
  if (await submitBtn.count()) {
    await submitBtn.click({ timeout: 2000 }).catch(()=>{});
    await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(()=>{});
  }

  // Verifizieren, dass Radius 50 gesetzt ist
  try {
    const radiusSel = page.locator('select[name*="distance"]').first();
    const val = await radiusSel.inputValue();
    if (val !== RADIUS_KM) {
      await radiusSel.selectOption(RADIUS_KM).catch(()=>{});
      if (await submitBtn.count()) {
        await submitBtn.click({ timeout: 1500 }).catch(()=>{});
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(()=>{});
      }
    }
  } catch {/* ignore */}
}

function normalizeText(t) {
  return (t ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim() || null;
}

function parseAddressLines(lines) {
  let street = null, zip = null, city = null;
  for (const line of lines) {
    const L = line.trim();
    if (!L) continue;
    if (!street && /\d/.test(L)) street = L;
    const m = L.match(/(\d{5})\s+(.+)/);
    if (m) { zip = m[1]; city = m[2].trim(); }
  }
  return { street: street||null, zip: zip||null, city: city||null };
}

async function extractCards(page) {
  // Sammle Cards + dazugehörige Kategorie-Labels für spätere Zuordnung
  const cards = page.locator('.card, .tx_biohandel_plg .card');
  const n = await cards.count();
  const detailHandles = [];
  for (let i=0;i<n;i++) {
    const card = cards.nth(i);
    const catText = normalizeText(await card.innerText().catch(()=>''));
    let type = null;
    if (/lieferservice/i.test(catText)) type = 'Lieferservice';
    else if (/marktst(a|ä)nd/i.test(catText)) type = 'Marktstand';
    else if (/bioladen/i.test(catText)) type = 'Bioladen';

    // Suche Details-Trigger innerhalb der Card
    const detail = card.locator('a:has-text("Details"), button:has-text("Details")').first();
    if (await detail.count()) {
      detailHandles.push({ locator: detail, type });
    }
  }
  return detailHandles;
}

async function extractModalData(page) {
  // Modal-Container heuristisch finden
  const modal = page.locator('[role="dialog"], .modal, .modal-dialog, .modal-content').first();
  await modal.waitFor({ state: 'visible', timeout: 8000 }).catch(()=>{});

  const nameSel = await modal.locator('h1, h2, h3, .modal-title').first();
  const name = normalizeText(await nameSel.textContent().catch(()=>null));

  const websiteEl = modal.locator('a[href^="http"]');
  const website = await websiteEl.first().getAttribute('href').catch(()=>null);

  const phoneEl = modal.locator('a[href^="tel:"], .phone, .telefon').first();
  const phone = normalizeText(await phoneEl.textContent().catch(()=>null));

  const emailEl = modal.locator('a[href^="mailto:"], .email').first();
  const emailRaw = await emailEl.getAttribute('href').catch(()=>null);
  const email = emailRaw ? emailRaw.replace(/^mailto:/,'') : normalizeText(await emailEl.textContent().catch(()=>null));

  // Adresse: sammle alle p/li/div Zeilen und parse
  const addrText = await modal.locator('p, li, div').allTextContents().catch(()=>[]);
  const addrLines = (addrText || []).map(t => t.trim()).filter(t => t);
  const { street, zip, city } = parseAddressLines(addrLines);

  return {
    name: name || null,
    street: street || null,
    zip: zip || null,
    city: city || null,
    phone: phone || null,
    email: email || null,
    website: website || null
  };
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = [it.name, it.street, it.zip, it.city, it.type].map(v => (v||'').toLowerCase()).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

Apify.main(async () => {
  const input = await Apify.getInput() || {};
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await Apify.openKeyValueStore();
  const dataset = await Apify.openDataset();

  // PLZ-Liste laden
  const fs = await import('fs');
  const raw = fs.readFileSync(INPUT_FILE, 'utf8');
  const zips = JSON.parse(raw).postal_codes || [];
  Apify.utils.log.info(`PLZ in Lauf: ${zips.length} (aus ${INPUT_FILE})`);

  const page = await browser.newPage();
  await blockAssets(page);

  const allRows = [];

  for (let i=0;i<zips.length;i++) {
    const zip = zips[i];
    Apify.utils.log.info(`=== ${i+1}/${zips.length} | PLZ ${zip} ===`);

    await navigateWithQuery(page, zip);

    // Cards + Details-Buttons erfassen
    const details = await extractCards(page);
    Apify.utils.log.info(`DETAILS buttons: ${details.length}`);

    for (let j=0;j<details.length;j++) {
      try {
        await details[j].locator.click({ timeout: 8000 });
        const parsed = await extractModalData(page);
        const row = {
          zip_query: zip,
          type: details[j].type || null,
          name: parsed.name,
          street: parsed.street,
          zip: parsed.zip,
          city: parsed.city,
          phone: parsed.phone,
          email: parsed.email,
          website: parsed.website,
        };
        // Null-fill for stability
        for (const k of Object.keys(row)) if (row[k] === undefined) row[k] = null;
        allRows.push(row);
        // Modal schließen (ESC oder Close)
        await page.keyboard.press('Escape').catch(()=>{});
        const closeBtn = page.locator('button:has-text("Schließen"), button:has-text("Close"), .modal [data-bs-dismiss="modal"]').first();
        if (await closeBtn.count()) await closeBtn.click({ timeout: 1000 }).catch(()=>{});
        await sleep(100);
      } catch (e) {
        // Modal evtl. nicht aufgegangen – weiter
      }
    }

    // Zwischenstände speichern
    if (allRows.length) {
      const deduped = dedupe(allRows);
      await dataset.pushData(deduped.slice(-50)); // push batchweise letzte 50
    }
  }

  // finaler Save (dedupliziert)
  const final = dedupe(allRows);
  if (final.length) await dataset.pushData(final);
  await browser.close();
});
