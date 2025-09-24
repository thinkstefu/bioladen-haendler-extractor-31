import { Actor, log } from 'apify';
import crypto from 'crypto';
import { chromium } from 'playwright';
import fs from 'fs/promises';
import pLimit from 'p-limit';

const CONFIG = {
    SELECTORS: {
        // Cookie Banner (mehrere Varianten, es werden die ersten Treffer geklickt)
        cookieButtons: [
            'button:has-text("Alle akzeptieren")',
            'button:has-text("Akzeptieren")',
            'button:has-text("Zustimmen")',
            'button[aria-label*="akzept"]',
            '[data-testid*="accept"]',
        ],

        // Formular
        zipInput: [
            'input[name*="plz"]',
            'input[name="zip"]',
            'input[placeholder*="PLZ"]',
            'input[type="search"]',
            'input[type="text"]'
        ],
        radiusSelect: [
            'select[name*="radius"]',
            'select:has(option:has-text("50"))',
            'select'
        ],
        // Manche Seiten nutzen Buttons/Toggles statt Input-Checkboxen
        categoryToggles: {
            shop: [
                'label:has-text("Bioläden") input[type="checkbox"]',
                'label:has-text("Bioladen") input[type="checkbox"]',
                'input[value*="shop"]',
                'input[value*="laden"]',
            ],
            market: [
                'label:has-text("Marktstände") input[type="checkbox"]',
                'input[value*="market"]',
                'input[value*="markt"]',
            ],
            delivery: [
                'label:has-text("Lieferservice") input[type="checkbox"]',
                'input[value*="liefer"]',
                'input[value*="delivery"]',
            ],
        },
        searchButton: [
            'button:has-text("Suchen")',
            'button[type="submit"]',
            '[role="button"]:has-text("Suchen")'
        ],

        // Liste & Details
        resultsContainer: [
            '[data-testid*="results"]',
            '.results',
            '#results'
        ],
        detailLink: [
            'a:has-text("Details")',
            'button:has-text("Details")',
            'a[aria-label*="Details"]',
            'a[href*="details"]'
        ],
        paginationNext: [
            'a[rel="next"]',
            'button:has-text("Weiter")',
            'button:has-text("Mehr")',
            'a:has-text("Weiter")',
            'a:has-text("Mehr")'
        ],

        // Detail-Modal/Seite
        detailName: [
            'h1', 'h2', '[data-testid*="name"]'
        ],
        detailAddressBlock: [
            '[data-testid*="address"]',
            'address', '.address', '.adresse', '[itemprop="address"]'
        ],
        detailWebsiteLink: [
            'a[href^="http"]:not([href*="facebook"]):not([href*="instagram"])'
        ],
        detailPhoneLink: [
            'a[href^="tel:"]'
        ],
        detailEmailLink: [
            'a[href^="mailto:"]'
        ],
        detailClose: [
            'button[aria-label*="close"]',
            'button:has-text("Schließen")',
            '.modal [aria-label="Close"]'
        ]
    },
    RADIUS_PARAM_KEYS: ['radius', 'distance', 'umkreis'],
    RADIUS_VALUE: '50',
};

function sleep(ms) {
    return new Promise((res) => setTimeout(res, ms));
}

function hashKey(obj) {
    const raw = `${obj.name||''}|${obj.street||''}|${obj.zip||''}|${obj.city||''}`;
    return crypto.createHash('sha1').update(raw).digest('hex');
}

function ensureSchema(obj) {
    const schema = {
        name: null,
        street: null,
        zip: null,
        city: null,
        lat: null,
        lng: null,
        phone: null,
        email: null,
        website: null,
        categories: null,
        openingHoursRaw: null,
        sourceUrl: null,
        plzQuery: null,
        timestamp: new Date().toISOString(),
    };
    return { ...schema, ...obj };
}

async function clickFirstThatExists(page, selectors, { delayMs=0 } = {}) {
    for (const sel of selectors) {
        const el = await page.$(sel);
        if (el) {
            await el.click({ force: true });
            if (delayMs) await sleep(delayMs);
            return true;
        }
    }
    return false;
}

async function acceptCookies(page, delayMs=0) {
    for (const sel of CONFIG.SELECTORS.cookieButtons) {
        const btns = await page.$$(sel);
        for (const b of btns) {
            try { await b.click({ force: true }); if (delayMs) await sleep(delayMs); log.info('Cookie-Banner akzeptiert.'); return; } catch {}
        }
    }
}

async function setZipRadiusCategories(page, plz, { delayMs=200, debug=false } = {}) {
    // ZIP
    let zipSet = false;
    for (const sel of CONFIG.SELECTORS.zipInput) {
        const el = await page.$(sel);
        if (el) {
            await el.click({ clickCount: 3 });
            await el.fill(String(plz));
            zipSet = true;
            break;
        }
    }
    if (!zipSet) log.warning('PLZ-Feld nicht gefunden – versuche dennoch fortzufahren.');

    // RADIUS
    let radiusSet = false;
    for (const sel of CONFIG.SELECTORS.radiusSelect) {
        const el = await page.$(sel);
        if (el) {
            const options = await el.$$('option');
            for (const o of options) {
                const txt = (await (await o.getProperty('innerText')).jsonValue()).trim();
                if (/50/.test(txt)) { await o.click(); radiusSet = true; break; }
            }
            if (!radiusSet) {
                // try programmatic value
                try {
                    await page.selectOption(sel, { label: /50/ });
                    radiusSet = true;
                } catch {}
            }
            break;
        }
    }
    if (!radiusSet) {
        // URL Fallback: füge radius=50 hinzu
        let url = page.url();
        const u = new URL(url);
        let applied = false;
        for (const key of CONFIG.RADIUS_PARAM_KEYS) {
            if (u.searchParams.has(key) || /radius/i.test(key)) {
                u.searchParams.set(key, CONFIG.RADIUS_VALUE);
                applied = true;
            }
        }
        if (!applied) u.searchParams.set('radius', CONFIG.RADIUS_VALUE);
        await page.goto(u.toString(), { waitUntil: 'domcontentloaded' });
        radiusSet = true;
        log.info('Radius auf 50 km gesetzt (URL-Fallback).');
    }

    // Kategorien
    const categories = ['shop','market','delivery'];
    for (const cat of categories) {
        const sels = CONFIG.SELECTORS.categoryToggles[cat];
        let ok = false;
        for (const sel of sels) {
            const el = await page.$(sel);
            if (el) {
                const tag = await el.evaluate(e => e.tagName.toLowerCase());
                if (tag === 'input') {
                    const checked = await el.isChecked().catch(()=>false);
                    if (!checked) await el.check({ force: true }).catch(()=>{});
                } else {
                    await el.click({ force: true }).catch(()=>{});
                }
                ok = true;
                break;
            }
        }
        if (debug && !ok) log.warning(`Kategorie-Schalter nicht gefunden: ${cat}`);
    }

    // Suche auslösen
    await clickFirstThatExists(page, CONFIG.SELECTORS.searchButton, { delayMs });
}

function parseAddress(text) {
    if (!text) return { street: null, zip: null, city: null };
    const clean = text.replace(/\s+/g, ' ').trim();
    // Try regex: "Musterstraße 1, 20095 Hamburg"
    const m = clean.match(/^(.*?),?\s*(\d{5})\s+([A-Za-zÄÖÜäöüß\-\s]+)$/);
    if (m) {
        return { street: m[1].trim(), zip: m[2], city: m[3].trim() };
    }
    return { street: clean || null, zip: null, city: null };
}

async function extractDetailsFromPage(page, plz, sourceUrl) {
    // Name
    let name = null;
    for (const sel of CONFIG.SELECTORS.detailName) {
        const t = await page.textContent(sel).catch(()=>null);
        if (t && t.trim()) { name = t.trim(); break; }
    }

    // Address
    let addressRaw = null;
    for (const sel of CONFIG.SELECTORS.detailAddressBlock) {
        const t = await page.textContent(sel).catch(()=>null);
        if (t && t.trim()) { addressRaw = t.trim(); break; }
    }
    let { street, zip, city } = parseAddress(addressRaw || '');
    if (!zip) zip = plz || null;

    // Website
    let website = null;
    for (const sel of CONFIG.SELECTORS.detailWebsiteLink) {
        const links = await page.$$(sel);
        for (const a of links) {
            const href = await a.getAttribute('href');
            if (href && /^https?:\/\//i.test(href)) {
                website = href;
                break;
            }
        }
        if (website) break;
    }

    // Phone
    let phone = null;
    for (const sel of CONFIG.SELECTORS.detailPhoneLink) {
        const a = await page.$(sel);
        if (a) {
            const href = await a.getAttribute('href');
            if (href) phone = href.replace(/^tel:/i, '');
            break;
        }
    }
    if (!phone) {
        const bodyText = await page.textContent('body').catch(()=>'');
        const m = bodyText && bodyText.match(/(\+49|\b0)[\s\-\/\(\)\d]{5,}/);
        if (m) phone = m[0].trim();
    }

    // Email
    let email = null;
    for (const sel of CONFIG.SELECTORS.detailEmailLink) {
        const a = await page.$(sel);
        if (a) {
            const href = await a.getAttribute('href');
            if (href) email = href.replace(/^mailto:/i, '');
            break;
        }
    }

    // Categories (heuristic)
    let categories = null;
    const pageText = (await page.textContent('body').catch(()=>'')) || '';
    const cats = [];
    if (/bioladen/i.test(pageText)) cats.push('Bioladen');
    if (/markt/i.test(pageText)) cats.push('Marktstand');
    if (/liefer/i.test(pageText)) cats.push('Lieferservice');
    if (cats.length) categories = cats;

    return ensureSchema({
        name, street, zip, city,
        phone, email, website,
        categories,
        sourceUrl,
        plzQuery: plz
    });
}

async function collectDetailTargetsFromList(page) {
    // Bevorzugt echte Links mit href (können parallel geladen werden)
    const linkHandles = await page.$$('a:has-text("Details"), a[href*="details"], a[aria-label*="Details"]');
    const urls = [];
    for (const a of linkHandles) {
        const href = await a.getAttribute('href');
        if (href && !href.startsWith('#')) {
            const u = new URL(href, page.url()).toString();
            urls.push(u);
        }
    }
    if (urls.length) return { urls, clickMode: false };

    // Fallback: Buttons (Modal / In-Page)
    const buttons = await page.$$('button:has-text("Details"), [role="button"]:has-text("Details")');
    return { buttons, clickMode: true };
}

async function runOnce({ page, baseUrl, plz, maxConcurrency=4, delayMs=200, debug=false }) {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await acceptCookies(page, delayMs);

    await setZipRadiusCategories(page, plz, { delayMs, debug });
    if (delayMs) await sleep(delayMs);

    // Ergebnis-Seite wartet
    await page.waitForLoadState('domcontentloaded');

    let totalExtracted = 0;
    const seen = new Set();

    while (true) {
        // Sammle Ziele auf der aktuellen Seite
        const { urls, buttons, clickMode } = await collectDetailTargetsFromList(page);

        if (clickMode) {
            // Klicke jede Schaltfläche nacheinander (Modal)
            const btns = buttons || [];
            log.info(`DETAILS buttons: ${btns.length}`);
            let idx = 0;
            for (const btn of btns) {
                idx += 1;
                log.info(`→ DETAILS ${idx}/${btns.length}`);
                try {
                    await btn.click({ force: true });
                    await page.waitForTimeout(150);
                    // Details extrahieren aus Modal/In-Page
                    const item = await extractDetailsFromPage(page, plz, page.url());
                    const key = hashKey(item);
                    if (!seen.has(key)) {
                        await Actor.pushData(item);
                        seen.add(key);
                        totalExtracted += 1;
                    }
                } catch (e) {
                    if (debug) log.warning(`Detail-Klick fehlgeschlagen: ${e.message}`);
                } finally {
                    // Modal schließen, falls vorhanden
                    await clickFirstThatExists(page, CONFIG.SELECTORS.detailClose).catch(()=>{});
                    await page.waitForTimeout(100);
                }
                if (delayMs) await sleep(delayMs);
            }
        } else {
            // Parallel über echte Detail-URLs
            log.info(`DETAILS links: ${urls.length}`);
            const limit = pLimit(maxConcurrency);
            const ctx = await page.context();

            await Promise.all(urls.map((u) => limit(async () => {
                const p = await ctx.newPage();
                try {
                    await p.goto(u, { waitUntil: 'domcontentloaded' });
                    const item = await extractDetailsFromPage(p, plz, u);
                    const key = hashKey(item);
                    if (!seen.has(key)) {
                        await Actor.pushData(item);
                        seen.add(key);
                        totalExtracted += 1;
                    }
                } catch (e) {
                    if (debug) log.warning(`Detail-URL fehlgeschlagen: ${u} → ${e.message}`);
                } finally {
                    await p.close().catch(()=>{});
                }
            })));
        }

        // Pagination
        let nextClicked = false;
        for (const sel of CONFIG.SELECTORS.paginationNext) {
            const el = await page.$(sel);
            if (el) {
                await el.click({ force: true });
                await page.waitForLoadState('domcontentloaded');
                nextClicked = true;
                break;
            }
        }
        if (!nextClicked) break;
    }

    log.info(`PLZ ${plz}: ${totalExtracted} neue Datensätze gespeichert`);
}

await Actor.main(async () => {
    const input = (await Actor.getInput()) || {};
    const baseUrl = input.baseUrl;
    if (!baseUrl) throw new Error('Bitte `baseUrl` im Input setzen (Trefferlisten-Seite der Händlersuche).');

    const headless = input.headless !== false;
    const debug = !!input.debug;
    const startIndex = Number.isInteger(input.startIndex) ? input.startIndex : 0;
    const limit = Number.isInteger(input.limit) ? input.limit : null;
    const delayMs = Number.isInteger(input.delayMs) ? input.delayMs : 200;
    const maxConcurrency = Number.isInteger(input.maxConcurrency) ? input.maxConcurrency : 4;

    const plzRaw = await fs.readFile('./plz_full.json', 'utf8');
    const plzList = JSON.parse(plzRaw);
    const slice = limit ? plzList.slice(startIndex, startIndex + limit) : plzList.slice(startIndex);

    log.info(`PLZ in Lauf: ${slice.length}${limit ? ` (aus plz_full.json, start=${startIndex}, limit=${limit})` : ' (aus plz_full.json)'}`);

    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();

    let i = 0;
    for (const plz of slice) {
        i += 1;
        log.info(`=== ${i}/${slice.length} | PLZ ${plz} ===`);
        try {
            await runOnce({ page, baseUrl, plz, maxConcurrency, delayMs, debug });
        } catch (e) {
            log.warning(`PLZ ${plz}: Fehler → ${e.message}`);
        }
    }

    await browser.close();
});
