const Apify = require('apify');
const { chromium } = require('playwright');

const BASE_URL = 'https://www.bioladen.de/bio-haendler-suche';

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

async function acceptCookies(page) {
  // Try multiple selectors / texts
  const candidates = [
    'button:has-text("Akzeptieren")',
    'button:has-text("Alle akzeptieren")',
    'button[aria-label*="akzept"]',
    'button.cookie-accept',
    'button#accept-all',
  ];
  for (const sel of candidates) {
    const btn = page.locator(sel);
    if (await btn.first().isVisible().catch(() => false)) {
      await btn.first().click({ timeout: 2000 }).catch(()=>{});
      await sleep(300);
      return true;
    }
  }
  // Fallback: click any button that includes "akzept"
  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const cand = buttons.find(b => /akzept/i.test(b.textContent || ''));
    if (cand) { cand.click(); return true; }
    return false;
  }).catch(()=>false);
  return clicked;
}

async function ensureRadius50(page) {
  // Try select element with "distance"
  const ok = await page.evaluate(() => {
    const fire = (el, type) => el && el.dispatchEvent(new Event(type, { bubbles: true }));
    const selects = Array.from(document.querySelectorAll('select'));
    // prefer name contains distance
    let sel = selects.find(s => /distance/i.test(s.name || s.id || '')) || selects[0];
    if (!sel) return false;
    // Try exact value "50" or option text includes "50"
    let value = '50';
    const optByValue = sel.querySelector('option[value="50"], option[value="50 km"], option[value="50km"]');
    if (optByValue) value = optByValue.value;
    else {
      const optByText = Array.from(sel.options || []).find(o => /(^|\s)50(\s|$)/.test((o.textContent||'').replace(/\s+/g,' ')));
      if (optByText) value = optByText.value;
    }
    sel.value = value;
    fire(sel, 'input'); fire(sel, 'change');
    return true;
  }).catch(()=>false);

  // If we changed it, submit by hitting Enter in the form or clicking the submit
  const submitSel = 'form button[type="submit"], form input[type="submit"]';
  const submit = page.locator(submitSel).first();
  if (await submit.isVisible().catch(()=>false)) {
    await submit.click({ timeout: 2000 }).catch(()=>{});
  } else {
    // Press Enter in PLZ input if present
    const plzField = page.locator('input[name*="searchplz"], input[placeholder*="PLZ"], input[type="search"]').first();
    if (await plzField.isVisible().catch(()=>false)) {
      await plzField.press('Enter').catch(()=>{});
    }
  }
  // short settle
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(()=>{});
  await sleep(250);
  return ok;
}

async function setCategories(page) {
  // Ensure all three: Bioläden, Marktstände, Lieferservice (if present)
  await page.evaluate(() => {
    const clickLabel = (txts) => {
      const labels = Array.from(document.querySelectorAll('label, span, a, button'));
      const lab = labels.find(l => txts.some(t => (l.textContent||'').toLowerCase().includes(t)));
      if (!lab) return false;
      // try to find checkbox within label or previous sibling
      let cb = lab.querySelector('input[type="checkbox"]');
      if (!cb) {
        const prev = lab.previousElementSibling;
        if (prev && prev.matches('input[type="checkbox"]')) cb = prev;
      }
      if (cb && !cb.checked) { cb.click(); return true; }
      // If no checkbox, try clicking label itself (some UIs toggle pills)
      lab.click();
      return true;
    };
    clickLabel(['bioläden','bioladen']);
    clickLabel(['marktstände','marktstand']);
    clickLabel(['liefer','lieferservice']);
  }).catch(()=>{});
}

async function fillZipAndSubmit(page, zip) {
  // Fill PLZ field
  const field = page.locator('input[name*="searchplz"], input[placeholder*="PLZ"], input[aria-label*="Postleitzahl"], input[type="search"], input[type="text"]').first();
  if (await field.isVisible().catch(()=>false)) {
    await field.fill('');
    await field.type(String(zip), { delay: 10 }).catch(()=>{});
    // Press Enter
    await field.press('Enter').catch(()=>{});
  }
  // Also try clicking submit
  const submit = page.locator('form button[type="submit"], form input[type="submit"]').first();
  if (await submit.isVisible().catch(()=>false)) {
    await submit.click().catch(()=>{});
  }
  // Wait for results to render a bit
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(()=>{});
  await sleep(300);
}

async function navigateForZip(page, zip, radius) {
  // Direct URL first (fast path)
  const url = `${BASE_URL}?tx_biohandel_plg[searchplz]=${encodeURIComponent(zip)}&tx_biohandel_plg[distance]=${encodeURIComponent(radius)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(250);
  await acceptCookies(page).catch(()=>{});
  await ensureRadius50(page).catch(()=>{});
  await setCategories(page).catch(()=>{});
  // Double-ensure zip is in field (some backends require form submit)
  await fillZipAndSubmit(page, zip).catch(()=>{});
}

async function countDetailButtons(page) {
  // Count visible Details triggers
  const n = await page.evaluate(() => {
    const isDetails = (el) => {
      const txt = (el.textContent || '').trim().toLowerCase();
      return /^details$/.test(txt) || txt === 'details »' || txt === '» details' || txt.includes('details');
    };
    const btns = Array.from(document.querySelectorAll('a, button'));
    return btns.filter(isDetails).length;
  });
  return n;
}

async function extractFromModal(page) {
  return await page.evaluate(() => {
    const modal = document.querySelector('.modal.show, .modal.fade.show, .modal[style*="display: block"], [role="dialog"].show, [role="dialog"]');
    if (!modal) return null;

    const getText = (sel) => {
      const el = modal.querySelector(sel);
      return el ? (el.textContent || '').replace(/\u00a0/g,' ').trim() : null;
    };
    const raw = (modal.innerText || '').replace(/\u00a0/g,' ').trim();

    // Heuristics for fields
    let name = getText('h4, h3, .modal-title, .dealer-title, .leaflet-popup-content h4');
    const links = Array.from(modal.querySelectorAll('a[href]'));
    let phone = null, email = null, website = null;
    const telEl = modal.querySelector('a[href^="tel:"]'); if (telEl) phone = telEl.getAttribute('href').replace(/^tel:/i,'').trim();
    const mailEl = modal.querySelector('a[href^="mailto:"]'); if (mailEl) email = mailEl.getAttribute('href').replace(/^mailto:/i,'').trim();
    const siteLink = links.find(a => /^https?:/i.test(a.getAttribute('href')||'') && !/bioladen\.de/i.test(a.href));
    if (siteLink) website = siteLink.href;

    // Address lines: find a line with 5-digit zip
    let street=null, zip=null, city=null;
    const lines = raw.split(/\n+/).map(s => s.trim()).filter(Boolean);
    for (let i=0;i<lines.length;i++){
      const m = lines[i].match(/(\d{5})\s+(.+)/);
      if (m) {
        zip = m[1];
        city = m[2].trim();
        street = (i>0) ? lines[i-1] : null;
        break;
      }
    }
    if (street && /^(Tel\.|Telefon|E-?Mail)/i.test(street)) street = null;
    if (!name) {
      // Often first line is the name
      name = lines[0] && lines[0] !== street ? lines[0] : name;
    }

    // Category guess
    let category = null;
    const catLine = lines.find(s => /(Bio.?laden|Marktstand|Liefer(service)?)/i.test(s));
    if (catLine) {
      if (/Marktstand/i.test(catLine)) category = 'Marktstand';
      else if (/Liefer/i.test(catLine)) category = 'Lieferservice';
      else category = 'Bioladen';
    }

    return { name, category, street, zip, city, phone, email, website, raw_text: raw };
  });
}

async function clickCloseModal(page) {
  const closeSel = '.modal.show [data-bs-dismiss="modal"], .modal.show .btn-close, .modal.show button.close, .modal.show .modal-footer button';
  const btn = page.locator(closeSel).first();
  if (await btn.isVisible().catch(()=>false)) {
    await btn.click({ timeout: 2000 }).catch(()=>{});
    await page.waitForTimeout(150);
    return;
  }
  // Fallback: press Escape
  await page.keyboard.press('Escape').catch(()=>{});
  await page.waitForTimeout(150);
}

async function scrapeZip(page, zip, radius, dataset) {
  await navigateForZip(page, zip, radius);
  // Wait a bit for cards to appear
  await page.waitForTimeout(800);
  let total = await countDetailButtons(page).catch(()=>0);
  Apify.utils.log.info(`DETAILS buttons: ${total}`);

  let saved = 0;
  for (let i = 0; i < total; i++) {
    // Re-query nth Details to keep handles fresh
    const locator = page.locator('a:has-text("Details"), button:has-text("Details")').nth(i);
    const exists = await locator.count().catch(()=>0);
    if (!exists) continue;
    await locator.scrollIntoViewIfNeeded().catch(()=>{});
    await locator.click({ timeout: 5000 }).catch(()=>{});
    // Wait for modal content
    await page.waitForSelector('.modal.show, .modal[style*="display: block"], [role="dialog"].show', { timeout: 8000 }).catch(()=>{});
    const data = await extractFromModal(page).catch(()=>null);
    if (data) {
      data.source_zip = String(zip);
      data.source_url = page.url();
      await dataset.pushData(data);
      saved++;
    }
    await clickCloseModal(page).catch(()=>{});
    await page.waitForTimeout(120);
  }
  Apify.utils.log.info(`PLZ ${zip}: ${saved} Datensätze gespeichert`);
}

Apify.main(async () => {
  const input = await Apify.getInput() || {};
  const radius = Number(input.radius || 50);
  let zips = Array.isArray(input.zips) && input.zips.length ? input.zips.map(z=>String(z)) : null;
  if (!zips) {
    // load from plz_full.json
    const fs = require('fs');
    const path = require('path');
    const p = path.join(__dirname, 'plz_full.json');
    const content = fs.readFileSync(p, 'utf8');
    zips = JSON.parse(content);
  }
  Apify.utils.log.info(`PLZ in Lauf: ${zips.length} (aus plz_full.json)`);

  const dataset = await Apify.openDataset();

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-dev-shm-usage']
  });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();

  for (let i=0;i<zips.length;i++) {
    const zip = zips[i];
    Apify.utils.log.info(`=== ${i+1}/${zips.length} | PLZ ${zip} ===`);
    try {
      await scrapeZip(page, zip, radius, dataset);
    } catch (err) {
      Apify.utils.log.warning(`PLZ ${zip} Fehler: ${err && err.message ? err.message : err}`);
    }
  }

  await browser.close();
  Apify.utils.log.info('Fertig.');
});