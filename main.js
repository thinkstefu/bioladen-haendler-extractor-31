// Apify v3 style
import { Actor, Dataset, log } from 'apify';
import { chromium } from 'playwright';

const START_URL = 'https://www.bioladen.de/bio-haendler-suche';

// Utility: sleep
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function acceptCookiesOnce(page) {
  try {
    // Try several common cookie selectors
    const btns = [
      'button#onetrust-accept-btn-handler',
      'button[aria-label*="Akzeptieren"]',
      'button:has-text("Akzeptieren")',
      'button:has-text("Alle akzeptieren")',
      '.cookiebar button.accept, .cm-btn-accept'
    ];
    for (const sel of btns) {
      const b = await page.locator(sel).first();
      if (await b.count()) {
        await b.click({ timeout: 3000 }).catch(()=>{});
        log.info('Cookie-Banner akzeptiert.');
        break;
      }
    }
  } catch {}
}

// Sets ZIP + radius in DOM and submits; wraps args into one object for page.evaluate
async function setZipAndRadiusAndSearch(page, { zip, radius }) {
  // Query approach — navigate with params as well (fast path, improves consistency)
  const url = `${START_URL}?tx_biohandel_plg[searchplz]=${encodeURIComponent(zip)}&tx_biohandel_plg[distance]=${encodeURIComponent(String(radius))}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

  // DOM approach to enforce radius + trigger search
  await page.evaluate(({ zip, radius }) => {
    const doc = document;

    // ZIP input
    const zipInput = doc.querySelector('input[name*="searchplz"], input[placeholder*="PLZ"], input[type="search"], input[type="text"]');
    if (zipInput) {
      zipInput.value = String(zip);
      zipInput.dispatchEvent(new Event('input', { bubbles: true }));
      zipInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Radius select (typ. name contains [distance])
    const radSel = doc.querySelector('select[name*="distance"], select[id*="distance"]');
    if (radSel) {
      // try exact value, else fallback to option containing 50
      const wanted = String(radius);
      let set = false;
      if ([...radSel.options].some(o => o.value === wanted)) {
        radSel.value = wanted;
        set = true;
      } else {
        const opt = [...radSel.options].find(o => /50/.test(o.value) || /50/.test(o.textContent || ''));
        if (opt) { radSel.value = opt.value; set = true; }
      }
      if (set) {
        radSel.dispatchEvent(new Event('input', { bubbles: true }));
        radSel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    // Kategorien aktivieren: Bioläden / Marktstände / Lieferservice (wenn vorhanden)
    const catLabels = ['Bioläden', 'Marktstände', 'Lieferservice'];
    catLabels.forEach(lbl => {
      // find checkbox by label text or id->label[for]
      const label = [...doc.querySelectorAll('label')].find(l => (l.textContent||'').trim().toLowerCase().includes(lbl.toLowerCase()));
      let cb = null;
      if (label) {
        const forId = label.getAttribute('for');
        if (forId) cb = doc.getElementById(forId);
        if (!cb) cb = label.querySelector('input[type="checkbox"]');
      }
      if (!cb) {
        cb = [...doc.querySelectorAll('input[type="checkbox"]')].find(i => (i.name||'').toLowerCase().includes(lbl.toLowerCase()));
      }
      if (cb && !cb.checked) {
        cb.checked = true;
        cb.dispatchEvent(new Event('input', { bubbles: true }));
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });

    // Try clicking a visible submit/search button
    const submit =
      doc.querySelector('button[type="submit"]') ||
      [...doc.querySelectorAll('button')].find(b => /suchen|finden/i.test(b.textContent||''));
    if (submit) {
      submit.click();
    } else if (zipInput && zipInput.form) {
      zipInput.form.requestSubmit ? zipInput.form.requestSubmit() : zipInput.form.submit();
    }
  }, { zip, radius });

  // wait for results container (cards) to appear or update
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(()=>{});
}

function parseAddress(raw) {
  // Try to split into Straße, PLZ, Ort. Common patterns like "Musterweg 1, 20095 Hamburg"
  let strasse = '', plz = '', ort = '';
  if (!raw) return { strasse, plz, ort };
  const txt = raw.replace(/\s+/g,' ').trim();
  const m = txt.match(/^(.*?),(?:\s*)(\d{5})\s+(.*)$/);
  if (m) {
    strasse = m[1].trim();
    plz = m[2];
    ort = m[3].trim();
  } else {
    // fallback: last token 5-digit is plz
    const m2 = txt.match(/(\d{5})/);
    if (m2) {
      plz = m2[1];
      const parts = txt.split(m2[1]);
      strasse = parts[0].replace(/[,;]+$/,'').trim();
      ort = (parts[1]||'').replace(/^\s*[,;-]?\s*/,'').trim();
    } else {
      strasse = txt;
    }
  }
  return { strasse, plz, ort };
}

function uniqKey(item) {
  return `${(item.name||'').toLowerCase()}|${(item.strasse||'').toLowerCase()}|${item.plz||''}`;
}

async function extractAllModalsOnPage(page, sourcePlz) {
  // Find all "DETAILS" buttons by text; if not found, fallback to card links
  const buttonLoc = page.locator('button:has-text("Details"), a:has-text("Details")');
  const count = await buttonLoc.count();
  log.info(`DETAILS buttons: ${count}`);
  const seen = new Set();
  const out = [];

  for (let i = 0; i < count; i++) {
    // re-resolve each time to avoid stale handles
    const btn = page.locator('button:has-text("Details"), a:has-text("Details")').nth(i);
    await btn.scrollIntoViewIfNeeded().catch(()=>{});
    await btn.click({ timeout: 8000 }).catch(()=>{});

    // Wait for modal/dialog
    const modal = page.locator('div[role="dialog"], .modal, .modal-dialog').first();
    await modal.waitFor({ state: 'visible', timeout: 8000 }).catch(()=>{});

    // Grab modal text and structured fields
    const text = (await modal.textContent())?.replace(/\s+/g,' ').trim() || '';

    // Try to get name/title
    let name = await modal.locator('h1, h2, h3, .modal-title').first().textContent().catch(()=>null);
    if (name) name = name.replace(/\s+/g,' ').trim();

    // Kategorie: oft im Modal-Kopf (Fallback: leere Kategorie)
    let kategorie = '';
    const catCandidate = await modal.locator('header, .modal-header').first().textContent().catch(()=>null);
    if (catCandidate) {
      const c = catCandidate.replace(/\s+/g,' ').trim();
      const hit = /(Bioläden|Marktstände|Lieferservice)/i.exec(c);
      if (hit) kategorie = hit[1];
    }
    if (!kategorie) {
      // try to infer from surrounding card text
      const near = await btn.locator('..').textContent().catch(()=>'');
      const c2 = (near||'').replace(/\s+/g,' ').trim();
      const hit2 = /(Bioläden|Marktstände|Lieferservice)/i.exec(c2);
      if (hit2) kategorie = hit2[1];
    }

    // Address: try common container classes or first <p>
    let addressRaw = await modal.locator('.address, .kontakt, .contact, p').first().textContent().catch(()=>null);
    addressRaw = (addressRaw||'').replace(/\s+/g,' ').trim();
    const { strasse, plz, ort } = parseAddress(addressRaw);

    // Phone, email, website
    const phoneMatch = text.match(/(?:Tel\.?|Telefon)[:\s]*([+\d][\d\s\-/()]+)\b/i);
    const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    const urlMatch = text.match(/https?:\/\/[^\s)]+/i);

    // Öffnungszeiten: grab block after "Öffnungszeiten"
    let oeff = '';
    const idx = text.toLowerCase().indexOf('öffnungszeiten');
    if (idx >= 0) oeff = text.slice(idx, Math.min(text.length, idx + 300))
      .replace(/\s+/g,' ').replace(/^öffnungszeiten[:\s]*/i,'').trim();

    const item = {
      name: name || '',
      kategorie: kategorie || '',
      strasse, plz, ort,
      telefon: phoneMatch ? phoneMatch[1].trim() : '',
      email: emailMatch ? emailMatch[0].trim() : '',
      website: urlMatch ? urlMatch[0].trim() : '',
      oeffnungszeiten: oeff,
      source_plz: sourcePlz
    };

    const key = uniqKey(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }

    // close modal
    const closeBtn = modal.locator('button:has-text("Schließen"), button[aria-label*="Schließen"], .close, .mfp-close');
    if (await closeBtn.count()) {
      await closeBtn.first().click().catch(()=>{});
    } else {
      // try Escape
      await page.keyboard.press('Escape').catch(()=>{});
    }

    // brief wait to allow DOM to settle
    await wait(150);
  }

  return out;
}

Actor.main(async () => {
  const input = await Actor.getInput() || {};
  const radius = Number(input.radiusKm || 50);
  let postalCodes = Array.isArray(input.postalCodes) && input.postalCodes.length ? input.postalCodes : null;
  if (!postalCodes) {
    try {
      const { postalCodes: fromFile } = JSON.parse(await Actor.getValue('plz_full.json') || '{}');
      if (Array.isArray(fromFile) && fromFile.length) postalCodes = fromFile;
    } catch {}
  }
  if (!postalCodes) {
    postalCodes = ["20095","80331","50667","60311","70173"];
  }

  log.info(`PLZ in Lauf: ${postalCodes.length} (aus plz_full.json)`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-sandbox']
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // First open base to accept cookies once
  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
  await acceptCookiesOnce(page);

  let totalSaved = 0;

  for (let i = 0; i < postalCodes.length; i++) {
    const zip = String(postalCodes[i]);
    log.info(`=== ${i+1}/${postalCodes.length} | PLZ ${zip} ===`);
    try {
      await setZipAndRadiusAndSearch(page, { zip, radius });
      // give the site a moment to render result cards
      await wait(800);
      const items = await extractAllModalsOnPage(page, zip);
      if (items.length) {
        await Dataset.pushData(items);
        totalSaved += items.length;
      }
      log.info(`PLZ ${zip}: ${items.length} neue Datensätze gespeichert`);
    } catch (e) {
      log.warning(`PLZ ${zip} Fehler: ${e.message}`);
    }
  }

  log.info(`Fertig. Insgesamt gespeichert: ${totalSaved}`);

  await browser.close();
});
