import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import fs from 'fs/promises';

const BASE_URL = 'https://www.bioladen.de/bio-haendler-suche';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_FIELDS = () => ({
    sourceZip: null,
    name: null,
    street: null,
    zip: null,
    city: null,
    phone: null,
    email: null,
    website: null,
    category: null,
});

async function acceptCookies(page) {
    const selectors = [
        '#usercentrics-accept-all-button',
        'button[aria-label*="Alle akzeptieren" i]',
        'button:has-text("Alle akzeptieren")',
        '[data-testid="uc-accept-all-button"]',
        'button:has-text("Akzeptieren")',
    ];
    for (const sel of selectors) {
        try {
            const btn = page.locator(sel).first();
            if (await btn.count()) {
                await btn.click({ timeout: 2000 }).catch(() => {});
                log.info('Cookie-Banner akzeptiert.');
                break;
            }
        } catch {}
    }
}

async function setZipRadiusCategoriesViaUI(page, zip) {
    // PLZ setzen
    let success = false;
    try {
        const zipInput = page.locator('input[name="tx_biohandel_plg[searchplz]"]').first();
        if (await zipInput.count()) {
            await zipInput.fill('');
            await zipInput.type(String(zip), { delay: 20 });
            success = true;
        }
    } catch {}

    // Radius (native select)
    let radiusSet = false;
    try {
        const native = page.locator('select[name="tx_biohandel_plg[distance]"]').first();
        if (await native.count()) {
            await native.selectOption({ label: /50\s*km/i }).catch(async () => {
                await native.selectOption('50').catch(() => {});
            });
            const val = await native.inputValue().catch(() => null);
            log.info(`Radius gesetzt (native): ${val}`);
            radiusSet = true;
        }
    } catch {}

    // Radius (custom-select fallback)
    if (!radiusSet) {
        try {
            const combo = page.locator('[role="combobox"], button[aria-haspopup="listbox"]');
            if (await combo.count()) {
                await combo.first().click({ timeout: 1500 }).catch(() => {});
                const opt = page.locator('[role="option"]', { hasText: /50\s*km/i }).first();
                if (await opt.count()) {
                    await opt.click({ timeout: 1500 }).catch(() => {});
                    log.info('Radius gesetzt (custom): 50');
                    radiusSet = true;
                }
            }
        } catch {}
    }

    // Kategorien anhaken (wenn Checkboxen existieren)
    const catLabels = [/Bio.?läden?/i, /Marktstände?/i, /Liefer(service)?/i];
    for (const labelRe of catLabels) {
        try {
            const lbl = page.locator('label', { hasText: labelRe }).first();
            if (await lbl.count()) {
                const cb = lbl.locator('input[type="checkbox"]');
                if (await cb.count()) {
                    const checked = await cb.isChecked().catch(() => false);
                    if (!checked) await lbl.click().catch(() => {});
                }
            }
        } catch {}
    }

    // Suche absenden (wenn vorhanden)
    try {
        const submit = page.locator('form button[type="submit"], form [type="submit"]').first();
        if (await submit.count()) {
            await Promise.all([
                page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}),
                submit.click({ timeout: 2000 }).catch(() => {}),
            ]);
            success = true;
        }
    } catch {}

    return success;
}

function buildParamUrl(zip) {
    const u = new URL(BASE_URL);
    u.searchParams.set('tx_biohandel_plg[searchplz]', String(zip));
    u.searchParams.set('tx_biohandel_plg[distance]', '50');
    // Kategorie-Parameter optional – falls die Seite sie akzeptiert
    u.searchParams.set('tx_biohandel_plg[type][biolaeden]', '1');
    u.searchParams.set('tx_biohandel_plg[type][marktstaende]', '1');
    u.searchParams.set('tx_biohandel_plg[type][lieferservice]', '1');
    return u.toString();
}

async function gotoWithParams(page, zip) {
    const url = buildParamUrl(zip);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    log.info('URL-Param-Fallback aktiv');
}

async function countDetailsButtons(page) {
    let det = page.locator('a:has-text("Details")');
    let count = await det.count();
    if (!count) {
        det = page.locator('a', { hasText: /Details|Mehr erfahren|zum Händler/i });
        count = await det.count();
    }
    return { locator: det, count };
}

function parseZipCity(line) {
    const m = line.match(/(\d{5})\s+(.+)$/);
    if (m) return { zip: m[1], city: m[2].trim() };
    return { zip: null, city: null };
}

function findPhone(text) {
    const m = text.match(/(?:\+?\s*49|0)\s*[1-9]\d(?:[ \-/]?\d){5,}/);
    return m ? m[0].trim() : null;
}

function findEmail(text) {
    const m = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    return m ? m[0] : null;
}

async function extractFromCard(card) {
    const rec = DEFAULT_FIELDS();
    try {
        // Name
        const nameEl = card.locator('h3, h2, .title, .headline').first();
        rec.name = (await nameEl.textContent().catch(() => null))?.trim() || null;

        // Website (direkter Link in der Karte?)
        const siteLink = await card.locator('a[href^="http"]', { hasText: /Web|Website|Zur Seite|mehr/i }).first();
        if (await siteLink.count()) {
            rec.website = await siteLink.getAttribute('href').catch(() => null);
        } else {
            // generischer erster http-Link
            const anyLink = card.locator('a[href^="http"]').first();
            if (await anyLink.count()) rec.website = await anyLink.getAttribute('href').catch(() => null);
        }

        // Restlichen Text scannen
        const text = (await card.textContent().catch(() => '')) || '';
        const lines = text.split('\n').map(s => s.trim()).filter(Boolean);

        // Straße: i. d. R. erste Zeile mit Ziffern + Straße
        rec.street = lines.find(l => /\d/.test(l) && /[a-zäöüß]/i.test(l)) || null;

        // PLZ/Ort: nächste Zeile mit 5-stelliger PLZ
        const zipLine = lines.find(l => /\b\d{5}\b/.test(l));
        if (zipLine) {
            const { zip, city } = parseZipCity(zipLine);
            rec.zip = zip;
            rec.city = city;
        }

        rec.phone = findPhone(text);
        rec.email = findEmail(text);

        // Kategorie heuristisch (ersatzweise)
        if (/liefer/i.test(text)) rec.category = 'Lieferservice';
        else if (/markt/i.test(text)) rec.category = 'Marktstand';
        else rec.category = 'Bioladen';

    } catch (e) {
        log.debug(`extractFromCard error: ${e.message}`);
    }
    return rec;
}

async function extractFromDetails(page) {
    const rec = {};
    try {
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        const text = (await page.textContent('main').catch(() => '')) || (await page.content().catch(() => '')) || '';

        rec.phone = findPhone(text);
        rec.email = findEmail(text);

        // Website-Link direkt
        const a = page.locator('a[href^="http"]').first();
        if (await a.count()) rec.website = await a.getAttribute('href').catch(() => null);

        // Besser strukturierte Felder, falls vorhanden
        const title = await page.locator('h1, h2').first().textContent().catch(() => null);
        if (title) rec.name = title.trim();

        const addr = await page.locator('address').first().textContent().catch(() => null);
        if (addr) {
            const parts = addr.split('\n').map(s => s.trim()).filter(Boolean);
            const street = parts.find(l => /\d/.test(l)) || null;
            const zipline = parts.find(l => /\b\d{5}\b/.test(l)) || null;
            if (street) rec.street = street;
            if (zipline) {
                const { zip, city } = parseZipCity(zipline);
                if (zip) rec.zip = zip;
                if (city) rec.city = city;
            }
        }
    } catch {}
    return rec;
}

function mergePreferringExisting(base, add) {
    const out = { ...base };
    for (const k of Object.keys(DEFAULT_FIELDS())) {
        if (out[k] == null && add[k] != null) out[k] = add[k];
    }
    return out;
}

function normalizeRecord(rec) {
    // Alles, was falsy/leer ist, als null setzen
    const norm = { ...DEFAULT_FIELDS(), ...rec };
    for (const k of Object.keys(norm)) {
        const v = norm[k];
        if (typeof v === 'string') {
            const s = v.trim();
            norm[k] = s.length ? s : null;
        } else if (!v) {
            norm[k] = v ?? null;
        }
    }
    return norm;
}

function dedupe(records) {
    const seen = new Set();
    const out = [];
    for (const r of records) {
        const key = [
            (r.name || '').toLowerCase(),
            (r.street || '').toLowerCase(),
            (r.zip || '').toLowerCase(),
            (r.city || '').toLowerCase(),
        ].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r);
    }
    return out;
}

async function processOneZip(page, zip) {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await acceptCookies(page);

    // UI-Versuch
    let uiOk = await setZipRadiusCategoriesViaUI(page, zip);
    if (!uiOk) {
        // URL-Notbremse
        await gotoWithParams(page, zip);
    }

    // Jetzt Ergebnisse zählen
    const { locator: detailsLoc, count: detailsCount } = await countDetailsButtons(page);
    log.info(`DETAILS buttons: ${detailsCount}`);

    let cards = page.locator('[class*="card"], .card, .result, .shop-item'); // generische Card-Selektoren
    if (await cards.count() === 0) {
        // Fallback auf parents von Details-Links
        cards = detailsLoc.locator('..'); // parent der Links
    }

    const found = await cards.count();
    const records = [];

    for (let i = 0; i < found; i++) {
        const card = cards.nth(i);
        let rec = await extractFromCard(card);
        rec.sourceZip = String(zip);

        // Falls wichtige Felder fehlen, Details öffnen
        const needsDetails = !rec.website || !rec.email;
        if (needsDetails) {
            // passende Details-Schaltfläche innerhalb der Karte suchen
            let det = card.locator('a:has-text("Details")').first();
            if (!(await det.count())) {
                det = card.locator('a', { hasText: /Details|Mehr erfahren|zum Händler/i }).first();
            }
            if (await det.count()) {
                const [detailsPage] = await Promise.all([
                    page.waitForEvent('popup').catch(() => null),
                    det.click({ button: 'middle' }).catch(() => null), // Mitlerer Klick öffnet i. d. R. in neuem Tab
                ]);
                const ctxPage = detailsPage || page;
                const add = await extractFromDetails(ctxPage);
                rec = mergePreferringExisting(rec, add);
                if (detailsPage) await detailsPage.close().catch(() => {});
            }
        }

        records.push(normalizeRecord(rec));
    }

    // Dedupe + speichern
    const unique = dedupe(records);
    for (const r of unique) {
        await Actor.pushData(r);
    }
    return unique.length;
}

async function loadZips() {
    // plz_full.json im Arbeitsverzeichnis
    try {
        const raw = await fs.readFile('./plz_full.json', 'utf-8');
        const list = JSON.parse(raw);
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
}

await Actor.main(async () => {
    const input = (await Actor.getInput()) || {};
    const startIndex = Number.isInteger(input.startIndex) ? input.startIndex : 0;
    const limit = Number.isInteger(input.limit) ? input.limit : null;
    const maxZips = Number.isInteger(input.maxZips) ? input.maxZips : null;
    const headless = input.headless !== false;

    const allZips = await loadZips();
    const sliced = allZips.slice(startIndex, limit ? startIndex + limit : undefined);
    const finalZips = maxZips ? sliced.slice(0, maxZips) : sliced;

    log.info(`PLZ in Lauf: ${finalZips.length} (embedded)`);

    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    let totalSaved = 0;
    for (let i = 0; i < finalZips.length; i++) {
        const zip = finalZips[i];
        log.info(`=== ${i + 1}/${finalZips.length} | PLZ ${zip} ===`);
        try {
            const saved = await processOneZip(page, zip);
            log.info(`PLZ ${zip}: ${saved} neue Datensätze gespeichert`);
            totalSaved += saved;
        } catch (e) {
            log.warning(`PLZ ${zip} Fehler: ${e.message}`);
        }
    }

    await browser.close().catch(() => {});
    log.info(`Fertig. Insgesamt gespeichert: ${totalSaved}`);
});
