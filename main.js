const { Actor, log } = require('apify');
const { chromium } = require('playwright');

// ---------- Config ----------
const DEFAULT_BASE_URL = process.env.BASE_URL || 'https://example.com/haendlersuche';
const SELECTORS = {
    cookieAccept: [
        'button:has-text("Akzeptieren")',
        'button:has-text("Einverstanden")',
        'button[aria-label*="akzeptieren" i]',
        '#onetrust-accept-btn-handler',
    ],
    zipInput: [
        'input[name*="plz" i]',
        'input[id*="plz" i]',
        'input[placeholder*="PLZ" i]',
        'input[placeholder*="Postleitzahl" i]',
        'input[type="search"]'
    ],
    searchButton: [
        'button:has-text("Suchen")',
        'button[type="submit"]',
    ],
    radiusSelect: [
        'select[name*="radius" i]',
        'select[id*="radius" i]',
        'select[name*="Umkreis" i]'
    ],
    radiusDropdownToggle: [
        'button:has-text("Umkreis")',
        'button:has-text("Radius")',
        'div[role="button"]:has-text("km")'
    ],
    radiusOption50: [
        'text=/^\\s*50\\s*km\\s*$/i',
        'li:has-text("50 km")',
        'button:has-text("50 km")',
        'option[value="50"]',
    ],
    // Result list
    resultContainer: [
        '[data-testid*="results" i]',
        '.results-list',
        '#results',
        '.result-list',
    ],
    resultItem: [
        '[data-testid*="result-item" i]',
        '.result-item',
        '.result, li.result',
        'li[class*="result" i]',
        'article:has(a, button)'
    ],
    detailsButton: [
        'a:has-text("Details")',
        'button:has-text("Details")',
        'a[aria-label*="Details" i]',
    ],
    // Fields (best-effort, per item or on detail overlay/page)
    name: [
        '[data-testid*="name" i]',
        'h3, h2, .name'
    ],
    address: [
        'address',
        '.address',
        '[data-testid*="address" i]'
    ],
    phone: [
        'a[href^="tel:"]',
        '[data-testid*="phone" i]',
        '.phone'
    ],
    website: [
        'a[href^="http"]',
        '[data-testid*="website" i]'
    ],
    category: [
        '[data-testid*="category" i]',
        '.category',
        '.badge'
    ]
};

const ZIP_LIST = require('./plz_full.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function firstLocator(page, selectors) {
    for (const sel of selectors) {
        const loc = page.locator(sel);
        try {
            if (await loc.first().count() > 0) return loc.first();
        } catch {}
    }
    return null;
}

async function clickCookieAccept(page) {
    for (const sel of SELECTORS.cookieAccept) {
        const loc = page.locator(sel);
        if (await loc.count()) {
            try {
                await loc.first().click({ timeout: 1500 });
                log.info('Cookie-Banner akzeptiert.');
                await sleep(300);
                return;
            } catch {}
        }
    }
}

async function setZipUI(page, zip) {
    const input = await firstLocator(page, SELECTORS.zipInput);
    if (!input) {
        log.warning('PLZ-Feld nicht gefunden – UI-Setzen übersprungen.');
        return false;
    }
    try {
        await input.click({ timeout: 3000 });
        await input.fill('');
        await input.type(String(zip), { delay: 50 });
        // Viele Seiten require Enter für Geocode
        await input.press('Enter');
        await sleep(400);
        // Falls es einen expliziten Such-Button gibt
        const btn = await firstLocator(page, SELECTORS.searchButton);
        if (btn) {
            await btn.click({ timeout: 2000 });
        }
        return true;
    } catch (e) {
        log.warning(`PLZ per UI nicht gesetzt: ${e?.message}`);
        return false;
    }
}

async function setRadius50UI(page) {
    // Try native select first
    const sel = await firstLocator(page, SELECTORS.radiusSelect);
    if (sel) {
        try {
            await sel.selectOption({ label: /50\s*km/i }).catch(async () => {
                await sel.selectOption({ value: '50' });
            });
            await sleep(200);
            log.info('Radius auf 50 km gesetzt (UI Select).');
            return true;
        } catch {}
    }
    // Try dropdown
    const toggle = await firstLocator(page, SELECTORS.radiusDropdownToggle);
    if (toggle) {
        try {
            await toggle.click({ timeout: 1500 });
            await sleep(150);
            for (const optSel of SELECTORS.radiusOption50) {
                const opt = page.locator(optSel);
                if (await opt.count()) {
                    await opt.first().click({ timeout: 1000 }).catch(() => {});
                    await sleep(200);
                    log.info('Radius auf 50 km gesetzt (UI Dropdown).');
                    return true;
                }
            }
        } catch {}
    }
    return false;
}

async function tryUrlVariants(page, baseUrl, zip) {
    const variants = [
        { zipKey: 'plz', radiusKey: 'radius' },
        { zipKey: 'zip', radiusKey: 'radius' },
        { zipKey: 'postalCode', radiusKey: 'radius' },
        { zipKey: 'plz', radiusKey: 'distance' },
        { zipKey: 'zip', radiusKey: 'distance' },
        { zipKey: 'postalCode', radiusKey: 'distance' },
        { zipKey: 'plz', radiusKey: 'umkreis' },
        { zipKey: 'zip', radiusKey: 'umkreis' },
        { zipKey: 'postalCode', radiusKey: 'umkreis' },
        { zipKey: 'search', radiusKey: 'radius' },
    ];
    for (const v of variants) {
        const u = new URL(baseUrl);
        u.searchParams.set(v.zipKey, String(zip));
        u.searchParams.set(v.radiusKey, '50');
        await page.goto(u.toString(), { waitUntil: 'domcontentloaded' });
        await clickCookieAccept(page);
        // Give the page a chance to render results
        await page.waitForLoadState('networkidle').catch(()=>{});
        await sleep(500);
        const got = await countResults(page);
        if (got.total > 0) {
            log.info('Radius auf 50 km gesetzt (URL-Fallback).');
            return true;
        }
    }
    return false;
}

async function ensureFilters(page, baseUrl, zip) {
    // Prefer UI; if either zip or radius not set, fallback to URL variants
    const zipOk = await setZipUI(page, zip);
    const radOk = await setRadius50UI(page);
    if (!zipOk || !radOk) {
        return await tryUrlVariants(page, baseUrl, zip);
    }
    return true;
}

async function countResults(page) {
    // count both "Details" buttons and generic result cards
    let detailsCount = 0, itemCount = 0;
    for (const sel of SELECTORS.detailsButton) {
        detailsCount += await page.locator(sel).count().catch(()=>0);
    }
    for (const sel of SELECTORS.resultItem) {
        itemCount += await page.locator(sel).count().catch(()=>0);
    }
    return { details: detailsCount, items: itemCount, total: detailsCount + itemCount };
}

function textOrNull(s) {
    if (!s) return null;
    const t = s.trim();
    return t.length ? t : null;
}

async function extractOne(page, item) {
    // Try to extract from a list card
    async function pick(selArr, from=item) {
        for (const sel of selArr) {
            const loc = from.locator(sel);
            if (await loc.count()) {
                const t = await loc.first().innerText().catch(()=>null);
                if (t && t.trim()) return t.trim();
            }
        }
        return null;
    }

    const name = await pick(SELECTORS.name);
    let street = null, postalCode = null, city = null;
    const addrRaw = await pick(SELECTORS.address);
    if (addrRaw) {
        // Simple heuristic split
        const lines = addrRaw.split('\n').map(s=>s.trim()).filter(Boolean);
        // Find line with postal code (5 digits)
        const zipLine = lines.find(l => /\b\d{5}\b/.test(l));
        if (zipLine) {
            const m = zipLine.match(/\b(\d{5})\b\s*(.+)?/);
            if (m) {
                postalCode = m[1];
                city = m[2]?.trim() || null;
            }
        }
        // First line often street
        if (lines.length) street = lines[0];
    }
    // Fallback: look for explicit tel / web inside the card
    let phone = null, website = null;
    for (const sel of SELECTORS.phone) {
        const a = item.locator(sel);
        if (await a.count()) {
            const href = await a.first().getAttribute('href').catch(()=>null);
            if (href && href.startsWith('tel:')) phone = href.replace('tel:', '').trim();
            else {
                const t = await a.first().innerText().catch(()=>null);
                if (t && /\d/.test(t)) phone = t.trim();
            }
            break;
        }
    }
    for (const sel of SELECTORS.website) {
        const a = item.locator(sel);
        if (await a.count()) {
            const href = await a.first().getAttribute('href').catch(()=>null);
            if (href && /^https?:\/\//i.test(href)) { website = href; break; }
        }
    }
    let category = null;
    for (const sel of SELECTORS.category) {
        const c = item.locator(sel);
        if (await c.count()) {
            const t = await c.first().innerText().catch(()=>null);
            if (t) { category = t.trim(); break; }
        }
    }

    return {
        name: textOrNull(name),
        street: textOrNull(street),
        postalCode: textOrNull(postalCode),
        city: textOrNull(city),
        phone: textOrNull(phone),
        website: textOrNull(website),
        category: textOrNull(category),
    };
}

async function scrapeZip(page, baseUrl, zip, slowMode=false) {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await clickCookieAccept(page);
    const ensured = await ensureFilters(page, baseUrl, zip);

    // Wait for results to paint or give up after some retries
    let tries = 0, lastCount = { total: 0 };
    while (tries < 3) {
        await page.waitForLoadState('networkidle').catch(()=>{});
        await sleep(slowMode ? 1500 : 600);
        lastCount = await countResults(page);
        if (lastCount.total > 0) break;

        // Try minor nudges: press Enter in zip field again or scroll a bit
        const input = await firstLocator(page, SELECTORS.zipInput);
        if (input) { await input.press('Enter').catch(()=>{}); }
        await page.mouse.wheel(0, 1200).catch(()=>{});
        tries++;
    }

    log.info(`DETAILS buttons: ${lastCount.details} | Result-Cards: ${lastCount.items}`);
    if (lastCount.total === 0) {
        // Save screenshot for debugging
        try {
            const png = await page.screenshot({ fullPage: true });
            await Actor.setValue(`no_results_${zip}.png`, png, { contentType: 'image/png' });
        } catch {}
        return 0;
    }

    // Load all items (lazy)
    await autoScroll(page, slowMode ? 1200 : 700);

    // Collect items
    let items = [];
    for (const sel of SELECTORS.resultItem) {
        const loc = page.locator(sel);
        if (await loc.count()) {
            const count = await loc.count();
            for (let i=0; i<count; i++) {
                const card = loc.nth(i);
                const rec = await extractOne(page, card);
                items.push(rec);
            }
        }
    }
    // Fallback: if we only have "Details" buttons, try to open each in overlay and parse
    if (items.length === 0 && lastCount.details > 0) {
        for (const sel of SELECTORS.detailsButton) {
            const loc = page.locator(sel);
            const n = await loc.count().catch(()=>0);
            for (let i=0; i<n; i++) {
                try {
                    await loc.nth(i).click({ timeout: 1500 });
                    await sleep(slowMode ? 800 : 400);
                    const rec = await extractOne(page, page);
                    items.push(rec);
                    // Try close overlay with Escape
                    await page.keyboard.press('Escape').catch(()=>{});
                } catch {}
            }
        }
    }

    // Normalize nulls and push
    let saved = 0;
    for (const it of items) {
        const out = {
            zip,
            radiusKm: 50,
            name: it.name ?? null,
            street: it.street ?? null,
            postalCode: it.postalCode ?? null,
            city: it.city ?? null,
            phone: it.phone ?? null,
            website: it.website ?? null,
            category: it.category ?? null,
            sourceUrl: page.url()
        };
        await Actor.pushData(out);
        saved++;
    }
    return saved;
}

async function autoScroll(page, durationMs=800) {
    const start = Date.now();
    while (Date.now() - start < durationMs) {
        await page.mouse.wheel(0, 1500).catch(()=>{});
        await sleep(150);
    }
}

(async () => {
    await Actor.main(async () => {
        const input = await Actor.getInput() || {};
        const baseUrl = input.baseUrl || DEFAULT_BASE_URL;
        const maxZips = Number.isInteger(input.maxZips) ? input.maxZips : null;
        const startAt = Number.isInteger(input.startAt) ? input.startAt : 0;
        const slowMode = !!input.slowMode;

        const browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
        const page = await context.newPage();

        const list = Array.isArray(ZIP_LIST) ? ZIP_LIST : [];
        if (!list.length) throw new Error('plz_full.json ist leer oder ungültig.');

        log.info(`PLZ in Lauf: ${list.length} (aus plz_full.json)`);

        let totalSaved = 0;
        const end = maxZips ? Math.min(list.length, startAt + maxZips) : list.length;
        for (let i = startAt; i < end; i++) {
            const zip = list[i];
            log.info(`=== ${i+1}/${list.length} | PLZ ${zip} ===`);
            try {
                const saved = await scrapeZip(page, baseUrl, zip, slowMode);
                log.info(`PLZ ${zip}: ${saved} neue Datensätze gespeichert`);
                totalSaved += saved;
            } catch (e) {
                log.warning(`PLZ ${zip} Fehler: ${e?.message}`);
                try {
                    const png = await page.screenshot({ fullPage: true });
                    await Actor.setValue(`error_${zip}.png`, png, { contentType: 'image/png' });
                } catch {}
            }
            await sleep(slowMode ? 600 : 250);
        }

        log.info(`Fertig. Insgesamt gespeichert: ${totalSaved}`);
        await browser.close();
    });
})();
