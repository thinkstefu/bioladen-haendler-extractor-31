import { Actor, log } from 'apify';
import { chromium } from 'playwright';

/** Utility: wait a bit */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Extract clean text helper */
const t = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

/** Parse address lines into structured fields */
function parseAddress(raw) {
  const out = { strasse: null, plz: null, ort: null };
  if (!raw) return out;
  const line = raw.replace(/\s+/g, ' ').trim();
  const m = line.match(/(.*?),\s*(\d{5})\s+([^,]+)/);
  if (m) {
    out.strasse = m[1].trim();
    out.plz = m[2];
    out.ort = m[3].trim();
  } else {
    // Fallback: try splitting on line breaks or commas
    const parts = line.split(/,|\n/).map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const m2 = parts[1].match(/(\d{5})\s+(.+)/);
      if (m2) {
        out.strasse = parts[0];
        out.plz = m2[1];
        out.ort = m2[2];
      } else {
        out.strasse = parts[0];
        out.ort = parts.slice(1).join(', ');
      }
    } else {
      out.strasse = line;
    }
  }
  return out;
}

/** Ensure the cookie banner is accepted (idempotent) */
async function acceptCookies(page) {
  try {
    // Usercentrics variants
    const sel = [
      'button:has-text("Akzeptieren")',
      'button:has-text("Einverstanden")',
      'button:has-text("Alle akzeptieren")',
      '#usercentrics-accept-button',
      '[data-testid="uc-accept-all-button"]'
    ].join(', ');
    const btn = page.locator(sel).first();
    if (await btn.count()) {
      await btn.click({ timeout: 3000 });
      log.info('Cookie-Banner akzeptiert.');
      await sleep(300);
    }
  } catch { /* ignore */ }
}

/** Enforce radius=50 and set postal code via DOM, then submit */
async function setZipAndRadiusAndSearch(page, zip, radiusKm) {
  await page.waitForLoadState('domcontentloaded', { timeout: 20000 });
  await acceptCookies(page);

  await page.evaluate((zipArg, radiusArg) => {
    // set PLZ
    const zipInput = document.querySelector(
      'input[name*="searchplz"], input[placeholder*="PLZ"], input[aria-label*="Postleitzahl"], input[type="text"]'
    );
    if (zipInput) {
      zipInput.focus();
      zipInput.value = '';
      zipInput.value = zipArg;
      zipInput.dispatchEvent(new Event('input', { bubbles: true }));
      zipInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // set radius
    const radius = document.querySelector('select[name*="distance"], select#distance');
    if (radius) {
      radius.value = String(radiusArg);
      radius.dispatchEvent(new Event('input', { bubbles: true }));
      radius.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // ensure categories ON if present
    const checkIfExistsThenCheck = (labelText) => {
      const label = Array.from(document.querySelectorAll('label')).find(l => (l.textContent||'').match(new RegExp(labelText, 'i')));
      if (label) {
        const input = label.querySelector('input[type="checkbox"]');
        if (input && !input.checked) {
          input.click();
        }
      }
    };
    checkIfExistsThenCheck('Bioläden');
    checkIfExistsThenCheck('Marktstände');
    checkIfExistsThenCheck('Lieferservice');

    // submit form
    const form = document.querySelector('form[action*="bio-haendler-suche"]') || document.querySelector('form');
    let submit = form?.querySelector('button[type="submit"], input[type="submit"]');
    if (!submit) {
      submit = Array.from(document.querySelectorAll('button, input[type="submit"]')).find(b => /suchen|finden/i.test(b.textContent||''));
    }
    if (submit) submit.click();
  }, zip, radiusKm);

  // wait for results area presence/update
  const resultsRoot = page.locator('.biohaendler-suche, .tx-biohandel, .results, .container').first();
  await resultsRoot.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
}

/** Collect all "Details" buttons across categories */
async function findDetailButtons(page) {
  // try direct button/anchor text match
  let loc = page.locator('button:has-text("Details"), a:has-text("Details")');
  let cnt = await loc.count();
  if (cnt > 0) return loc;

  // fallback: any element that looks like a details trigger
  loc = page.locator('[data-bs-toggle="modal"], [data-toggle="modal"], .modal-trigger, .btn:has-text("Details")');
  cnt = await loc.count();
  if (cnt > 0) return loc;

  // final fallback: try to click cards sequentially (not ideal, but safer)
  return page.locator('.card, .result-item, .store-result').locator('button, a');
}

/** Extract one modal */
async function extractFromOpenModal(page, sourceZip) {
  const modal = page.locator('.modal.show, [role="dialog"][aria-modal="true"]').first();
  await modal.waitFor({ state: 'visible', timeout: 10000 });

  // Name: prefer modal title
  let name = await modal.locator('h3, h4, .modal-title, .h3, .h4').first().textContent().catch(() => '');
  name = (name || '').replace(/\s+/g, ' ').trim();

  // Gather all text once for robust parsing
  const text = (await modal.textContent() || '').replace(/\s+/g, ' ').trim();

  // Adresse: try explicit fields or lines
  let addressLine = '';
  const addrNode = await modal.locator('.address, .adresse, address').first().textContent().catch(() => '');
  addressLine = (addrNode || '').trim();
  if (!addressLine) {
    // try to locate street + zip lines by regex in full text
    const m = text.match(/([^\n,]+?),\s*(\d{5})\s+([A-Za-zÄÖÜäöüß\-\s]+)/);
    if (m) addressLine = `${m[1]}, ${m[2]} ${m[3]}`;
  }
  const { strasse, plz, ort } = parseAddress(addressLine);

  // Telefon
  let telefon = '';
  const phoneCandidate = text.match(/(?:Tel\.?|Telefon)\s*:?\s*([+\d][\d\s\-/()]+)(?!\S)/i);
  if (phoneCandidate) telefon = phoneCandidate[1].trim();

  // E-Mail
  let email = '';
  const emailNode = await modal.locator('a[href^="mailto:"]').first().getAttribute('href').catch(() => null);
  if (emailNode) email = emailNode.replace(/^mailto:/i, '').trim();
  if (!email) {
    const m = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (m) email = m[0];
  }

  // Website
  let web = '';
  const webHref = await modal.locator('a[href^="http"]').first().getAttribute('href').catch(() => null);
  if (webHref) web = webHref.trim();

  // Öffnungszeiten (grober Block)
  let oeffnungszeiten = '';
  const oh = text.match(/Öffnungszeiten[:\s]*([^]*?)(?:Kontakt|Telefon|E-Mail|Web|Website|$)/i);
  if (oh) oeffnungszeiten = oh[1].trim();

  // Kategorie: aus Modal-Labels ableiten
  let kategorie = '';
  const catHit = text.match(/Bioläden|Marktstände|Lieferservice/i);
  if (catHit) kategorie = catHit[0];

  return {
    name: name || null,
    kategorie: kategorie || null,
    strasse: strasse || null,
    plz: plz || null,
    ort: ort || null,
    telefon: telefon || null,
    email: email || null,
    web: web || null,
    oeffnungszeiten: oeffnungszeiten || null,
    lat: null,
    lng: null,
    sourceZip: String(sourceZip),
  };
}

async function runOnce(browser, zip, radiusKm, dataset, dedupSet) {
  const context = await browser.newContext();
  const page = await context.newPage();

  // Pre-seed URL with query args (helps server-side filter)
  const url = `https://www.bioladen.de/bio-haendler-suche?tx_biohandel_plg[searchplz]=${zip}&tx_biohandel_plg[distance]=${radiusKm}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});

  await setZipAndRadiusAndSearch(page, zip, radiusKm);

  // Collect details buttons
  const details = await findDetailButtons(page);
  const total = await details.count();
  log.info(`DETAILS buttons: ${total}`);

  let saved = 0;
  for (let i = 0; i < total; i++) {
    try {
      const btn = details.nth(i);
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ timeout: 8000 });
      const rec = await extractFromOpenModal(page, zip);

      // dedup key by name+strasse+plz
      const key = [rec.name||'', rec.strasse||'', rec.plz||''].join('|').toLowerCase();
      if (!dedupSet.has(key)) {
        dedupSet.add(key);
        await dataset.pushData(rec);
        saved++;
      }

      // Close modal
      const closeBtn = page.locator('.modal.show button:has-text("Schließen"), .modal.show button.btn-close').first();
      if (await closeBtn.count()) {
        await closeBtn.click({ timeout: 3000 }).catch(() => page.keyboard.press('Escape').catch(()=>{}));
      } else {
        await page.keyboard.press('Escape').catch(()=>{});
      }
      await sleep(120);
    } catch (e) {
      // try to recover modal state
      await page.keyboard.press('Escape').catch(()=>{});
    }
  }

  await context.close().catch(()=>{});
  return saved;
}

await Actor.main(async () => {
  const input = await Actor.getInput() || {};
  const radiusKm = Number(input.radiusKm ?? 50);
  let postalCodes = input.postalCodes;
  if (!postalCodes) {
    try {
      postalCodes = JSON.parse(await Actor.getValue('plz_full.json'));
    } catch {
      postalCodes = null;
    }
  }
  if (!postalCodes) {
    postalCodes = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./plz_full.json', import.meta.url)));
  }
  log.info(`PLZ in Lauf: ${postalCodes.length} (aus plz_full.json)`);

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const dataset = await Actor.openDataset();
  const dedupSet = new Set();

  for (let i = 0; i < postalCodes.length; i++) {
    const zip = String(postalCodes[i]).padStart(5, '0');
    log.info(`=== ${i+1}/${postalCodes.length} | PLZ ${zip} ===`);
    const saved = await runOnce(browser, zip, radiusKm, dataset, dedupSet);
    log.info(`PLZ ${zip}: ${saved} neue Datensätze gespeichert`);
  }

  await browser.close();
});
