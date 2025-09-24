import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function acceptCookies(page) {
  try {
    // Try a few common variants
    const candidates = [
      'button:has-text("Alle akzeptieren")',
      'button:has-text("Akzeptieren")',
      'button:has-text("Zustimmen")',
      'text=/Alle akzeptieren/i',
      'text=/Akzeptieren/i',
    ];
    for (const sel of candidates) {
      const el = page.locator(sel).first();
      if (await el.count()) {
        await el.click({ timeout: 2000 });
        log.info('Cookie-Banner akzeptiert.');
        break;
      }
    }
  } catch { /* ignore */ }
}

function toNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function normalizeText(s) {
  return s?.replace(/[\s\u00A0]+/g, ' ').trim() ?? null;
}

// heuristic extractors from modal content
async function parseModal(page) {
  // Find modal container
  const modalSel = [
    'div[role="dialog"]',
    '.modal[open], .modal.show, .c-modal, .modal',
    '[aria-modal="true"]'
  ];
  let modal;
  for (const sel of modalSel) {
    const loc = page.locator(sel).first();
    if (await loc.count()) { modal = loc; break; }
  }
  if (!modal) {
    // fallback: use visible overlay
    modal = page.locator('body');
  }

  // Prefer structured pieces
  let name = null;
  for (const h of ['h1','h2','h3','.modal-title','.c-modal__title']) {
    const loc = modal.locator(h).first();
    if (await loc.count()) { name = await loc.innerText().catch(() => null); if (name) break; }
  }

  // Links
  const links = await modal.locator('a').all();
  let phone = null, email = null, website = null;
  for (const a of links) {
    const href = (await a.getAttribute('href')) || '';
    if (href.startsWith('tel:')) phone = href.replace(/^tel:/, '').trim();
    else if (href.startsWith('mailto:')) email = href.replace(/^mailto:/, '').trim();
  }
  // website: prefer http(s) links excluding bioladen.de itself (store may have their own site)
  for (const a of links) {
    const href = (await a.getAttribute('href')) || '';
    if (/^https?:/i.test(href) && !/bioladen\.de/i.test(href)) { website = href.trim(); break; }
  }

  const text = await modal.innerText().catch(() => '') || '';
  const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean);

  // Address: try to find line with PLZ
  let street = null, postalCode = null, city = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\b(\d{5})\b\s+(.+)/);
    if (m) {
      postalCode = m[1];
      city = m[2].replace(/^(?:D-)?\s*/, '').trim();
      // street likely previous non-empty
      for (let j = i - 1; j >= 0; j--) {
        if (lines[j] && !/^(Telefon|Tel\.|E-?Mail|Web|Öffnungszeiten|Mo\.|Di\.|Mi\.|Do\.|Fr\.|Sa\.|So\.)/i.test(lines[j])) {
          street = lines[j].trim();
          break;
        }
      }
      break;
    }
  }

  // Opening hours: grab contiguous block starting at a day marker
  let openingHours = null;
  const dayIdx = lines.findIndex(l => /^Mo\.|^Montag|^Öffnungszeiten/i.test(l));
  if (dayIdx !== -1) {
    const oh = [];
    for (let k = dayIdx; k < lines.length; k++) {
      const L = lines[k];
      if (/^(Mo\.|Di\.|Mi\.|Do\.|Fr\.|Sa\.|So\.|Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag|Öffnungszeiten)/i.test(L)) {
        oh.push(L);
      } else if (oh.length) {
        // stop when the block ends
        break;
      }
    }
    if (oh.length) openingHours = oh.join(' | ');
  }

  // Try to infer "type" from modal chips or header
  let type = null;
  const typeHit = lines.find(l => /(Bioladen|Marktstand|Lieferservice)s?/i.test(l));
  if (typeHit) {
    const m = typeHit.match(/(Bioladen|Marktstand|Lieferservice)s?/i);
    if (m) type = m[1];
  }

  // Fallback for name: first non-technical line
  if (!name) {
    name = lines.find(l => l.length <= 80 && !/^(Telefon|E-?Mail|Web|Öffnungszeiten|\d{5}\b)/i.test(l));
  }

  return {
    name: toNull(normalizeText(name)),
    street: toNull(normalizeText(street)),
    postalCode: toNull(postalCode),
    city: toNull(normalizeText(city)),
    phone: toNull(phone),
    email: toNull(email),
    website: toNull(website),
    openingHours: toNull(normalizeText(openingHours)),
    type: toNull(type),
  };
}

async function clickDetailsAndExtract(page) {
  // find all "Details" buttons
  const detailsLoc = page.locator('text=/^\s*Details\s*$/i');
  const count = await detailsLoc.count();
  log.info(`DETAILS buttons: ${count}`);
  const results = [];

  for (let i = 0; i < count; i++) {
    try {
      log.info(`→ DETAILS ${i+1}/${count}`);
      const btn = detailsLoc.nth(i);
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ timeout: 10000 });

      // wait for some dialog to appear
      await page.waitForSelector('div[role="dialog"], .modal[open], .modal.show, .c-modal, [aria-modal="true"]', { timeout: 8000 }).catch(() => {});
      await sleep(250);

      const rec = await parseModal(page);
      // ensure nulls for all fields
      results.push({
        name: rec.name ?? null,
        street: rec.street ?? null,
        postalCode: rec.postalCode ?? null,
        city: rec.city ?? null,
        phone: rec.phone ?? null,
        email: rec.email ?? null,
        website: rec.website ?? null,
        openingHours: rec.openingHours ?? null,
        type: rec.type ?? null,
      });

      // close modal (Esc and common close selectors)
      await page.keyboard.press('Escape').catch(() => {});
      const closeSelectors = [
        'button:has-text("Schließen")',
        'button:has-text("Close")',
        '.modal [data-close], .c-modal__close, .modal .close, [aria-label="Close"]'
      ];
      for (const sel of closeSelectors) {
        const loc = page.locator(sel).first();
        if (await loc.count()) { await loc.click({ timeout: 1000 }).catch(() => {}); break; }
      }

      // small gap to prevent dialog race
      await sleep(150);
    } catch (err) {
      log.warning(`DETAILS ${i+1}: ${err?.message || err}`);
      // Try to ensure modal is closed before next iteration
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(150);
    }
  }
  return results;
}

async function ensureRadius(page, desiredKm) {
  // Try selecting dropdown (best effort)
  try {
    const selects = page.locator('select');
    const sc = await selects.count();
    for (let i = 0; i < sc; i++) {
      const sel = selects.nth(i);
      const opts = await sel.locator('option').allTextContents();
      if (opts.some(o => /50\s*km/i.test(o))) {
        await sel.selectOption({ label: `${desiredKm} km` }).catch(() => {});
      }
    }
  } catch { /* ignore */ }
}

function makeUrl(plz, radiusKm) {
  const r = Number.isFinite(+radiusKm) ? +radiusKm : 50;
  // Encode the TYPO3 params safely
  const params = new URLSearchParams();
  params.set('tx_biohandel_plg[searchplz]', String(plz));
  params.set('tx_biohandel_plg[distance]', String(r));
  return `https://www.bioladen.de/bio-haendler-suche?${params.toString()}`;
}

async function processZip(page, plz, radiusKm) {
  const url = makeUrl(plz, radiusKm);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await acceptCookies(page);
  await ensureRadius(page, radiusKm);
  await page.waitForLoadState('domcontentloaded');
  await sleep(500);

  // Try to ensure category chips are active by clicking if present (best-effort, non-fatal)
  const chips = ['Bioladen','Bioläden','Marktstand','Marktstände','Lieferservice','Lieferservices'];
  for (const label of chips) {
    try {
      const chip = page.locator(`text=/${label}/i`).first();
      if (await chip.count()) {
        // toggle ON if looks inactive (heuristic: has aria-pressed or class contains 'inactive')
        const pressed = await chip.getAttribute('aria-pressed').catch(() => null);
        if (pressed === 'false' || pressed === null) {
          await chip.click({ timeout: 2000 }).catch(() => {});
        }
      }
    } catch {}
  }

  // Find details
  const results = await clickDetailsAndExtract(page);
  return results;
}

function makeKey(rec) {
  return [
    rec.name || '',
    rec.street || '',
    rec.postalCode || '',
    rec.city || '',
    rec.phone || '',
  ].join('|').toLowerCase();
}

await Actor.main(async () => {
  const radiusKm = Number(process.env.RADIUS_KM || 50);
  const startIndex = Number(process.env.START_INDEX || 0);
  const limit = Number(process.env.LIMIT || 0);
  const headless = String(process.env.HEADLESS || 'true') !== 'false';

  const plzPath = path.join(process.cwd(), 'plz_full.json');
  const plzRaw = JSON.parse(await fs.readFile(plzPath, 'utf8'));
  const list = Array.isArray(plzRaw) ? plzRaw.map(String) : [];
  const slice = list.slice(startIndex, limit > 0 ? startIndex + limit : undefined);

  log.info(`PLZ in Lauf: ${slice.length}${limit>0?' (LIMIT aktiv)':''}`);

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  const seen = new Set();
  let totalSaved = 0;

  for (let idx = 0; idx < slice.length; idx++) {
    const plz = slice[idx];
    try {
      log.info(`=== ${idx+1}/${slice.length} | PLZ ${plz} ===`);
      const rows = await processZip(page, plz, radiusKm);

      // Dedupe + annotate
      let savedHere = 0;
      for (const r of rows) {
        const rec = {
          name: r.name ?? null,
          street: r.street ?? null,
          postalCode: r.postalCode ?? null,
          city: r.city ?? null,
          phone: r.phone ?? null,
          email: r.email ?? null,
          website: r.website ?? null,
          openingHours: r.openingHours ?? null,
          type: r.type ?? null,
          sourceZip: plz,
          sourceUrl: makeUrl(plz, radiusKm),
          scrapedAt: new Date().toISOString(),
        };
        const key = makeKey(rec);
        if (!seen.has(key)) {
          await Actor.pushData(rec);
          seen.add(key);
          totalSaved++;
          savedHere++;
        }
      }
      log.info(`PLZ ${plz}: ${savedHere} neue Datensätze gespeichert`);
    } catch (err) {
      log.warning(`PLZ ${plz} Fehler: ${err?.message || err}`);
    }
  }

  await browser.close();
  log.info(`Fertig. Insgesamt gespeichert: ${totalSaved}`);
});
