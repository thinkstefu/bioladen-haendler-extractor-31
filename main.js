import { Actor } from 'apify';
import { chromium } from 'playwright';

const BASE = 'https://www.bioladen.de/bio-haendler-suche';

// helpful wait
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function acceptCookiesOnce(page) {
  try {
    // Try multiple known selectors/texts.
    const buttons = page.locator('button:has-text("Akzeptieren"), button:has-text("Einverstanden"), button:has-text("Zustimmen"), #uc-btn-accept-all, [data-cc="accept"]');
    if (await buttons.count() > 0) {
      await buttons.first().click({ timeout: 3000 }).catch(()=>{});
      await wait(300);
      Actor.log.info('Cookie-Banner akzeptiert.');
    }
  } catch {}
}

async function ensureCategories(page) {
  // Try to ensure Bioläden, Marktstände, Lieferservice sind aktiv, falls Checkboxen existieren
  const labelTexts = ['Bioläden', 'Bioladen', 'Marktstände', 'Marktstand', 'Lieferservice', 'Lieferservices'];
  for (const t of labelTexts) {
    const lab = page.locator(`label:has-text("${t}")`);
    if (await lab.count()) {
      // click if not already checked (label->input[type=checkbox])
      const input = lab.first().locator('input[type="checkbox"]');
      if (await input.count()) {
        const checked = await input.isChecked().catch(()=>false);
        if (!checked) await lab.first().click().catch(()=>{});
      } else {
        // sometimes just toggle-able buttons
        await lab.first().click().catch(()=>{});
      }
    }
  }
}

async function setZipRadiusAndSearch(page, zip) {
  // Fülle PLZ
  const zipSel = 'input[name*="searchplz"], input[name*="[searchplz]"]';
  await page.waitForSelector(zipSel, { timeout: 15000 });
  await page.fill(zipSel, '');
  await page.type(zipSel, String(zip), { delay: 30 });

  // Setze Radius via <select>
  const distSel = 'select[name*="distance"], select[name*="[distance]"]';
  await page.waitForSelector(distSel, { timeout: 5000 });
  await page.selectOption(distSel, { value: '50' }).catch(async () => {
    // Fallback: set via JS + dispatch change
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) { el.value = '50'; el.dispatchEvent(new Event('change', { bubbles: true })); }
    }, distSel);
  });

  // Search submit
  const form = await page.locator('form').first();
  if (await form.count()) {
    // try button with text 'Suchen'
    const btn = form.locator('button[type="submit"], input[type="submit"], button:has-text("Suchen")');
    if (await btn.count()) {
      await btn.first().click().catch(()=>{});
    } else {
      // last resort submit via JS
      await page.evaluate(() => {
        const f = document.querySelector('form');
        if (f) f.submit();
      });
    }
  }

  // Warte auf Results oder Hinweis
  await Promise.race([
    page.waitForSelector('a:has-text("Details"), button:has-text("Details")', { timeout: 12000 }).catch(()=>{}),
    page.waitForSelector('text=keine Treffer', { timeout: 12000 }).catch(()=>{}),
    page.waitForLoadState('networkidle').catch(()=>{}),
  ]);

  // verify distance really 50 (URL or selected value)
  const selectedVal = await page.$eval(distSel, el => el && el.value, ).catch(()=>null);
  if (selectedVal !== '50') {
    await page.selectOption(distSel, { value: '50' }).catch(()=>{});
    const btn2 = page.locator('button[type="submit"], input[type="submit"]');
    if (await btn2.count()) await btn2.first().click().catch(()=>{});
    await page.waitForLoadState('networkidle').catch(()=>{});
  }
}

function parseBlockText(txt) {
  // normalize whitespace
  return txt.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
}

function parseModalTextToFields(text) {
  // Initialize fields
  const out = {
    name: null,
    typ: null,
    strasse: null,
    plz: null,
    ort: null,
    telefon: null,
    email: null,
    website: null,
    oeffnungszeiten: null
  };
  const t = text;

  // Try email
  const email = t.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (email) out.email = email[0];

  // Try phone
  const phone = t.match(/(?:Tel\.?|Telefon)[:\s]*([+0-9][0-9\s\-/()]{5,})/i);
  if (phone) out.telefon = phone[1].trim();

  // Website: any http(s) link not pointing to bioladen.de (if multiple, take first)
  const site = t.match(/https?:\/\/[^\s)]+/ig);
  if (site && site.length) {
    const first = site.find(u => !/bioladen\.de/i.test(u)) || site[0];
    out.website = first;
  }

  // Type
  if (/Lieferservice/i.test(t)) out.typ = 'Lieferservice';
  else if (/Marktstand/i.test(t)) out.typ = 'Marktstand';
  else if (/Bioladen/i.test(t)) out.typ = 'Bioladen';

  // Address lines – look for PLZ + Ort pattern
  const plzOrt = t.match(/\b(\d{5})\s+([A-Za-zÄÖÜäöüß\-\.\s]+)/);
  if (plzOrt) {
    out.plz = plzOrt[1];
    out.ort = plzOrt[2].replace(/[,;].*$/, '').trim();
  }
  // street heuristic: first line before plzOrt containing a number
  const lines = t.split(/\n+/).map(s => s.trim()).filter(Boolean);
  let streetCandidate = null;
  for (let i = 0; i < lines.length; i++) {
    if (plzOrt && lines[i].includes(plzOrt[0])) {
      // previous non-empty line
      for (let j = i - 1; j >= 0; j--) {
        if (/\d+/.test(lines[j])) { streetCandidate = lines[j]; break; }
      }
      break;
    }
  }
  out.strasse = streetCandidate || null;

  // Name: try modal title first, else first line not equal to street, not phone/email keywords
  // (Will be overridden by parseModal() that passes the modal title separately)
  // Opening hours: grab block around "Öffnungszeiten"
  const oh = t.split(/\n/).reduce((acc, line) => {
    if (/Öffnungszeiten/i.test(line)) acc.push(''); // marker
    else if (acc.length) acc.push(line);
    return acc;
  }, []);
  if (oh && oh.length) {
    out.oeffnungszeiten = oh.join('\n').trim() || null;
  }

  return out;
}

async function extractFromModal(modal) {
  const rawText = parseBlockText(await modal.innerText());
  const title = await modal.locator('h2, h3, .modal-title, .card-title').first().innerText().catch(()=>null);
  const data = parseModalTextToFields(rawText);
  if (!data.name && title) data.name = title.trim();
  // Ensure nulls
  for (const k of Object.keys(data)) if (data[k] === undefined) data[k] = null;
  return data;
}

async function processZip(page, zip) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await acceptCookiesOnce(page);
  await ensureCategories(page);
  await setZipRadiusAndSearch(page, zip);

  // collect all details buttons
  const details = page.locator('a:has-text("Details"), button:has-text("Details")');
  const count = await details.count();
  Actor.log.info(`DETAILS buttons: ${count}`);
  if (count === 0) return [];

  const results = [];
  for (let i = 0; i < count; i++) {
    // open modal
    await details.nth(i).click({ trial: false }).catch(()=>{});

    // wait for modal/dialog
    const modal = page.locator('[role="dialog"], .modal, .modal-dialog').first();
    await modal.waitFor({ state: 'visible', timeout: 10000 }).catch(()=>{});

    if (await modal.count()) {
      const item = await extractFromModal(modal);
      // set source zip
      item.quelle_plz = String(zip);
      results.push(item);
      // close modal
      // try close button or Esc
      const closeBtn = modal.locator('button:has-text("Schließen"), button:has-text("Close"), .modal-header button[aria-label*="Close"]');
      if (await closeBtn.count()) await closeBtn.first().click().catch(()=>{});
      else await page.keyboard.press('Escape').catch(()=>{});
      await wait(120);
    } else {
      // if no modal appeared, try small wait and continue
      await wait(200);
    }
  }
  return results;
}

function dedupe(items) {
  const seen = new Set();
  const arr = [];
  for (const it of items) {
    const key = [it.name||'', it.strasse||'', it.plz||''].join('|').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    arr.push(it);
  }
  return arr;
}

await Actor.main(async () => {
  const input = await Actor.getInput() || {};
  let zips = Array.isArray(input.plz) && input.plz.length ? input.plz.map(String) : null;
  if (!zips) {
    try {
      const resp = await Actor.getValue('plz_full.json') || null; // when uploaded to KV
      if (resp && Array.isArray(resp)) zips = resp.map(String);
    } catch {}
  }
  if (!zips) {
    // fallback to local file in image
    zips = JSON.parse(await (await import('node:fs/promises')).readFile('./plz_full.json', 'utf8'));
  }

  const concurrency = Math.max(1, Math.min( (input.concurrency|0) || 1, 6 ));
  Actor.log.info(`PLZ in Lauf: ${zips.length}${input.plz ? ' (aus input)' : ' (aus plz_full.json)'}`);

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }});
  const page = await context.newPage();

  const all = [];
  for (const zip of zips) {
    Actor.log.info(`=== ${all.length+1}/${zips.length} | PLZ ${zip} ===`);
    const items = await processZip(page, zip).catch(err => { Actor.log.warning(`PLZ ${zip} Fehler: ${err.message}`); return []; });
    Actor.log.info(`PLZ ${zip}: ${items.length} Datensätze extrahiert`);
    for (const it of items) all.push(it);
    // push batch to dataset to avoid data loss
    if (items.length) await Actor.pushData(items);
  }

  const unique = dedupe(all).map(it => {
    // ensure explicit nulls
    for (const k of ['name','typ','strasse','plz','ort','telefon','email','website','oeffnungszeiten','quelle_plz']) {
      if (it[k] === undefined) it[k] = null;
    }
    return it;
  });

  Actor.log.info(`Fertig. Insgesamt einzigartig gespeichert: ${unique.length}`);
  if (unique.length) {
    // store a full copy as a dataset item too (optional)
    await Actor.setValue('summary.json', unique);
  }
  await browser.close();
});
