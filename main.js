import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const SITE = 'https://www.bioladen.de/bio-haendler-suche';

/**
 * Utility: wait for some ms
 */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Ensures cookie banner is accepted once.
 */
async function acceptCookiesIfVisible(page) {
  try {
    // Try common selectors/texts
    const btn = page.locator('button:has-text("Akzeptieren"), button:has-text("Einverstanden"), button[aria-label*="Akzept"]');
    if (await btn.first().isVisible({ timeout: 1000 }).catch(()=>false)) {
      await btn.first().click({ timeout: 2000 }).catch(()=>{});
      log.info('Cookie-Banner akzeptiert.');
      await sleep(300);
    }
  } catch {}
}

/**
 * Sets ZIP and radius to 50km, submits the form properly.
 * Also ensures all three category filters are ON (if present).
 */
async function setZipRadiusAndFilters(page, zip, radiusKm = 50) {
  // Navigate with params first (fast path)
  const url = new URL(SITE);
  url.searchParams.set('tx_biohandel_plg[searchplz]', zip);
  url.searchParams.set('tx_biohandel_plg[distance]', String(radiusKm));
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 25000 });

  await acceptCookiesIfVisible(page);

  // Make sure the distance select is really set to 50 and trigger the form submit.
  await page.evaluate(({ r }) => {
    const sel = document.querySelector('select[name="tx_biohandel_plg[distance]"]');
    if (sel) {
      sel.value = String(r);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const zipInput = document.querySelector('input[name="tx_biohandel_plg[searchplz]"]');
    if (zipInput) zipInput.dispatchEvent(new Event('change', { bubbles: true }));
  }, { r: radiusKm });

  // Ensure categories are checked (if the site exposes these)
  const categoryLabels = ['Bioläden', 'Marktstände', 'Lieferservice', 'Lieferservices'];
  for (const label of categoryLabels) {
    const lab = page.locator(`label:has-text("${label}")`);
    if (await lab.first().count().then(c=>c>0)) {
      // click only if it's not checked yet
      const input = await lab.first().locator('input[type="checkbox"]').elementHandle().catch(() => null);
      if (input) {
        const isChecked = await input.evaluate(el => el.checked);
        if (!isChecked) await lab.first().click().catch(()=>{});
      } else {
        // some templates place input elsewhere; just click label
        await lab.first().click().catch(()=>{});
      }
    }
  }

  // Submit the form (robust: try a few ways)
  // 1) Explicit submit button (typical)
  const submitBtn = page.locator('form button[type="submit"], form input[type="submit"]');
  if (await submitBtn.first().count().then(c=>c>0)) {
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: 20000 }),
      submitBtn.first().click().catch(()=>{}),
    ]);
  } else {
    // 2) Fallback: press Enter in the ZIP field
    const zipInput = page.locator('input[name="tx_biohandel_plg[searchplz]"]');
    if (await zipInput.count() > 0) {
      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 20000 }),
        zipInput.press('Enter').catch(()=>{}),
      ]);
    }
  }

  // Small wait for dynamic content
  await sleep(600);
}

/**
 * Extracts all "Details" links/buttons on the result list.
 */
async function getDetailsButtons(page) {
  const candidates = page.locator('a:has-text("Details"), button:has-text("Details")');
  const count = await candidates.count();
  log.info(`DETAILS buttons: ${count}`);
  return candidates;
}

/**
 * Parse a modal content after opening a Details link.
 * Tries to extract clean fields. Missing fields -> nulls.
 */
async function parseCurrentModal(page) {
  // Wait for modal-ish container
  const modal = page.locator('[role="dialog"], .modal, .reveal, .popup, .c-popup, .mfp-content').first();
  await modal.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

  // Pull text and links from the visible modal area
  const text = await modal.innerText().catch(() => '');
  const name = await modal.locator('h1, h2, h3, .title, .shop-title').first().innerText().catch(() => null);

  // Extract commonly structured fields
  const email = await modal.locator('a[href^="mailto:"]').first().getAttribute('href').catch(()=>null);
  const phone = await modal.locator('a[href^="tel:"]').first().getAttribute('href').catch(()=>null);
  const website = await modal.locator('a[href^="http"]').first().getAttribute('href').catch(()=>null);

  // Address chunks (very heuristic)
  let street = null, zip = null, city = null;
  if (text) {
    const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
    // Find line with 5-digit ZIP
    for (const line of lines) {
      const m = line.match(/(\d{5})\s+(.+)/);
      if (m) { zip = m[1]; city = m[2].replace(/^D-/, '').trim(); }
    }
    // Street likely appears before ZIP/City
    const zipIdx = lines.findIndex(l => /\d{5}\s+/.test(l));
    if (zipIdx > 0) street = lines[zipIdx - 1];
  }

  // Type (Bioladen/Marktstand/Lieferservice) – try to infer from modal text
  let kind = null;
  if (text) {
    const t = text.toLowerCase();
    if (t.includes('marktstand')) kind = 'Marktstand';
    else if (t.includes('lieferservice') || t.includes('lieferdienst')) kind = 'Lieferservice';
    else kind = 'Bioladen';
  }

  // Öffnungszeiten (collect block that includes weekday names)
  let opening_hours = null;
  if (text) {
    const block = text.split('\n').filter(l => /(mo|di|mi|do|fr|sa|so)\.?/i.test(l)).join(' | ');
    opening_hours = block || null;
  }

  const norm = (v) => v ?? null;
  return {
    name: norm(name),
    kind: norm(kind),
    street: norm(street),
    zip: norm(zip),
    city: norm(city),
    phone: phone ? phone.replace(/^tel:/, '') : null,
    email: email ? email.replace(/^mailto:/, '') : null,
    website: website || null,
    opening_hours: norm(opening_hours),
  };
}

/**
 * Close modal (try a few common ways).
 */
async function closeModal(page) {
  // clickable close buttons
  const closeSelectors = [
    'button[aria-label="Schließen"]',
    'button[aria-label="Close"]',
    'button:has-text("Schließen")',
    '.mfp-close',
    '.modal-close, .close'
  ];
  for (const sel of closeSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.count() > 0 && await btn.isVisible().catch(()=>false)) {
      await btn.click().catch(()=>{});
      await sleep(150);
      return;
    }
  }
  // fallback: press Escape
  await page.keyboard.press('Escape').catch(()=>{});
  await sleep(150);
}

async function runOnce(page, zip) {
  await setZipRadiusAndFilters(page, zip, 50);
  const details = await getDetailsButtons(page);
  const n = await details.count();
  const results = [];
  const seen = new Set();

  for (let i = 0; i < n; i++) {
    // open in same tab
    const btn = details.nth(i);
    await btn.scrollIntoViewIfNeeded().catch(()=>{});
    await btn.click().catch(()=>{});
    await sleep(300);

    const rec = await parseCurrentModal(page).catch(() => null);
    await closeModal(page);

    if (!rec) continue;
    // dedupe key
    const key = [rec.name, rec.street, rec.zip, rec.city].map(v => (v || '').toLowerCase()).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(rec);
  }

  log.info(`PLZ ${zip}: ${results.length} Datensätze extrahiert`);
  // push to default dataset
  for (const r of results) await Actor.pushData(r);
}

await Actor.init();

// read input, fallback to local json
const input = await Actor.getInput() || {};
let plzList = input.plz;
if (!plzList || !Array.isArray(plzList) || plzList.length === 0) {
  const raw = await fs.readFile(new URL('./plz_full.json', import.meta.url), 'utf-8').catch(()=>null);
  if (raw) plzList = JSON.parse(raw).plz;
}
if (!plzList) plzList = ['20095']; // last resort

const concurrency = Math.max(1, Math.min(4, Number(input.concurrency) || 1));
log.info(`PLZ in Lauf: ${plzList.length}`);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

// Reuse single page sequentially (Actor concurrency=1 by default here)
for (let i = 0; i < plzList.length; i++) {
  const zip = plzList[i];
  log.info(`=== ${i+1}/${plzList.length} | PLZ ${zip} ===`);
  try {
    await runOnce(page, zip);
  } catch (e) {
    log.warning(`PLZ ${zip} Fehler: ${e.message}`);
  }
}

await browser.close();
await Actor.exit();
