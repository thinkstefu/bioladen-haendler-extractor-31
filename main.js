// ESM + Apify v3
import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const SITE = 'https://www.bioladen.de/bio-haendler-suche';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function normalizeNullable(s) {
  if (!s) return null;
  const t = String(s).trim();
  return t.length ? t : null;
}

function keyForDedup(it) {
  return [it.name||'', it.street||'', it.zip||'', it.city||'', it.type||''].join('|').toLowerCase();
}

async function ensureRadius50(page) {
  // triple enforcement: URL param already set by goto, but enforce UI too
  try {
    const sel = page.locator('select[name*="distance"]');
    if (await sel.count()) {
      await sel.selectOption('50');
      await page.waitForLoadState('domcontentloaded');
    }
  } catch {}
}

async function acceptCookies(page) {
  // try several common selectors/texts
  const variants = [
    'button:has-text("Akzeptieren")',
    'button:has-text("Einverstanden")',
    'button:has-text("Alle akzeptieren")',
    'text=Akzeptieren',
  ];
  for (const v of variants) {
    const el = page.locator(v);
    if (await el.count()) {
      try { await el.first().click({ timeout: 2000 }); break; } catch {}
    }
  }
}

async function enableCategories(page) {
  const labels = ['Bioläden', 'Marktstände', 'Lieferservice'];
  for (const label of labels) {
    try {
      const cb = page.getByLabel(label, { exact: false });
      if (await cb.count()) {
        const isChecked = await cb.first().isChecked().catch(()=>false);
        if (!isChecked) await cb.first().check({ timeout: 2000 });
      } else {
        // fallback: query by input value/name fragment
        const candidate = page.locator('input[type="checkbox"]');
        const n = await candidate.count();
        for (let i=0;i<n;i++){
          const it = candidate.nth(i);
          const txt = (await it.evaluate(el => el.closest('label')?.innerText || '')).toLowerCase();
          if (txt.includes(label.toLowerCase())) { await it.check({ timeout: 2000 }); break; }
        }
      }
    } catch {}
  }
}

async function openAllDetailsAndExtract(page) {
  const records = [];
  // First try the explicit DETAILS buttons
  let buttons = page.locator('button, a').filter({ hasText: 'Details' });
  let count = await buttons.count();
  if (count === 0) {
    // fallback: any card links that open detail modals
    buttons = page.locator('a[href*="#"][data-bs-toggle="modal"], a[href*="modal"]');
    count = await buttons.count();
  }
  if (count === 0) {
    // ultimate fallback: take card items
    buttons = page.locator('.tx_biohandel_plg .card a, .card a:has-text("Details")');
    count = await buttons.count();
  }

  // iterate
  for (let i = 0; i < count; i++) {
    try {
      const btn = buttons.nth(i);
      await btn.scrollIntoViewIfNeeded();
      await btn.click();
      // wait for modal/dialog
      const modal = page.locator('.modal.show, [role="dialog"][open]');
      await modal.waitFor({ state: 'visible', timeout: 8000 }).catch(()=>{});
      const html = await page.content();

      const item = await modal.evaluate((root) => {
        const pick = (sel) => root.querySelector(sel);

        const getText = (sel) => {
          const n = pick(sel);
          return n ? n.textContent.trim() : null;
        };

        // Try headings for name
        let name = getText('h2, h3, .modal-title, .card-title') || null;

        // address block heuristics
        const block = pick('.address, .kontakt, .contact, .modal-body, .card-body') || root;
        const txt = block.textContent || '';

        // Regexes
        const phone = (txt.match(/(?:Telefon|Tel\.?|Phone)\s*[:]?\s*([+0-9\s\/()-]{6,})/i) || [])[1] || null;
        const email = (txt.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [])[0] || null;
        const website = (txt.match(/https?:\/\/[\w.-]+(?:\/[\w./#?-]*)?/i) || [])[0] || null;
        // Address lines
        let street = null, zip = null, city = null;
        const lines = txt.split(/\n|\r/).map(s => s.trim()).filter(Boolean);
        for (const line of lines) {
          const m = line.match(/^(\d{5})\s+(.+)$/);
          if (m) { zip = m[1]; city = m[2]; continue; }
          // crude street guess
          if (!street && /\d/.test(line) && /(str\.|straße|weg|platz|allee|gasse|ring)/i.test(line)) street = line;
        }

        // type based on badges/text in modal
        let type = null;
        const lower = txt.toLowerCase();
        if (lower.includes('lieferservice')) type = 'Lieferservice';
        else if (lower.includes('marktstand') || lower.includes('wochenmarkt')) type = 'Marktstand';
        else type = 'Bioladen';

        return { name, street, zip, city, phone, email, website, type };
      });

      // normalize
      for (const k of Object.keys(item)) item[k] = item[k] && typeof item[k] === 'string' ? item[k].trim() : item[k];
      records.push({
        name: normalizeNullable(item.name),
        street: normalizeNullable(item.street),
        zip: normalizeNullable(item.zip),
        city: normalizeNullable(item.city),
        phone: normalizeNullable(item.phone),
        email: normalizeNullable(item.email),
        website: normalizeNullable(item.website),
        type: normalizeNullable(item.type),
      });

      // close modal
      try { await page.keyboard.press('Escape'); } catch {}
      try { await page.locator('.modal.show .btn-close, .modal.show [data-bs-dismiss="modal"]').click({ timeout: 1000 }); } catch {}
      await sleep(100);
    } catch (e) {
      log.debug(`Modal iteration error: ${e.message}`);
    }
  }
  return records;
}

async function setZipAndSearch(page, zip) {
  const url = `${SITE}?tx_biohandel_plg[searchplz]=${zip}&tx_biohandel_plg[distance]=50`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await acceptCookies(page);
  await ensureRadius50(page);
  await enableCategories(page);
  // Some pages require explicit submit
  try {
    const submit = page.locator('form button[type="submit"], form input[type="submit"]');
    if (await submit.count()) { await submit.first().click({ timeout: 2000 }); await page.waitForLoadState('domcontentloaded'); }
  } catch {}
}

Actor.main(async () => {
  const inputZips = JSON.parse(await fs.readFile('./plz_full.json', 'utf8')).map(String);
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const page = await (await browser.newContext()).newPage();

  // block heavy resources
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image','font','stylesheet'].includes(type)) route.abort();
    else route.continue();
  });

  const dataset = await Actor.openDataset();
  const seen = new Set();
  let saved = 0;

  for (let i = 0; i < inputZips.length; i++) {
    const zip = inputZips[i];
    log.info(`=== ${i+1}/${inputZips.length} | PLZ ${zip} ===`);
    try {
      await setZipAndSearch(page, zip);
      const recs = await openAllDetailsAndExtract(page);
      // dedupe and save
      const uniques = [];
      for (const r of recs) {
        const key = keyForDedup(r);
        if (seen.has(key)) continue;
        seen.add(key);
        // ensure all keys present / null default
        uniques.push({
          name: r.name ?? null,
          street: r.street ?? null,
          zip: r.zip ?? null,
          city: r.city ?? null,
          phone: r.phone ?? null,
          email: r.email ?? null,
          website: r.website ?? null,
          type: r.type ?? null,
          source_zip: zip,
        });
      }
      if (uniques.length) {
        await dataset.pushData(uniques);
        saved += uniques.length;
      }
      log.info(`PLZ ${zip}: ${uniques.length} neue Datensätze gespeichert (total ${saved})`);
    } catch (e) {
      log.warning(`PLZ ${zip} Fehler: ${e.message}`);
    }
  }

  await browser.close();
  log.info(`Fertig. Insgesamt gespeichert: ${saved}`);
});
