const { Actor, log } = require('apify');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Helper to pause
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// Try click any of the selectors (first that exists)
async function tryClick(page, selectors, timeout = 4000) {
    for (const sel of selectors) {
        try {
            const loc = page.locator(sel);
            if (await loc.first().count() > 0) {
                await loc.first().click({ timeout });
                return true;
            }
        } catch (_) {}
    }
    return false;
}

async function tryFill(page, selectors, value, timeout = 4000) {
    for (const sel of selectors) {
        try {
            const loc = page.locator(sel);
            if (await loc.first().count() > 0) {
                await loc.first().fill('');
                await loc.first().type(String(value), { delay: 20 });
                return true;
            }
        } catch (_) {}
    }
    return false;
}

async function acceptCookies(page) {
    // Many common cookie banners
    const buttons = [
        'button:has-text("Alle akzeptieren")',
        'button:has-text("Akzeptieren")',
        'button:has-text("Zustimmen")',
        'button:has-text("Einverstanden")',
        'text=OK',
        '[aria-label*="akzeptieren"]',
        '[data-testid*="accept"]',
        '#onetrust-accept-btn-handler',
        '.fc-cta-consent',
        'button[mode="primary"]:has-text("Akzeptieren")',
    ];
    await tryClick(page, buttons).catch(() => {});
}

async function setZipAndRadiusUI(page, zip) {
    // Try to fill PLZ
    const filled = await tryFill(page, [
        'input[name*="plz"]',
        'input[id*="plz"]',
        'input[placeholder*="PLZ"]',
        'input[aria-label*="PLZ"]',
        'input[name*="post"]',
        'input[name*="zip"]',
        'input[type="search"]',
    ], zip);

    if (!filled) {
        log.warning('PLZ-Feld nicht gefunden – UI-Setzen übersprungen.');
    }

    // Try set radius to 50 km via select or dropdown
    const setRadiusSelect = async () => {
        const sel = page.locator('select[name*="radius"], select[id*="radius"]');
        if (await sel.count() > 0) {
            try {
                await sel.selectOption({ label: /50/ });
                return true;
            } catch {}
            try {
                await sel.selectOption('50');
                return true;
            } catch {}
        }
        return false;
    };

    const setRadiusDropdown = async () => {
        const opened = await tryClick(page, [
            'button:has-text("km")',
            'button[aria-haspopup="listbox"]',
            '[role="combobox"]',
        ]);
        if (opened) {
            return await tryClick(page, [
                'text=/50\\s*km/i',
                '[role="option"]:has-text("50")',
                'li:has-text("50")',
            ]);
        }
        return false;
    };

    let radiusOK = await setRadiusSelect();
    if (!radiusOK) radiusOK = await setRadiusDropdown();
    if (!radiusOK) {
        log.warning('50-km-Radius via UI nicht gefunden – Fallback via URL wird ggf. genutzt.');
    }

    // Click search
    await tryClick(page, [
        'button:has-text("Suchen")',
        'button[type="submit"]',
        'input[type="submit"]',
        '[data-testid*="search"]',
    ]);
}

function buildUrlWithFallback(baseUrl, zip) {
    const u = new URL(baseUrl);
    const candidates = ['plz', 'zip', 'zipcode', 'postalCode', 'q', 'search'];
    for (const k of candidates) u.searchParams.set(k, String(zip));
    // common distance keys
    const dkeys = ['distance', 'radius', 'umkreis'];
    for (const k of dkeys) u.searchParams.set(k, '50');
    return u.toString();
}

async function waitForResults(page) {
    const cardsOrDetails = page.locator([
        'a:has-text("Details")',
        'button:has-text("Details")',
        '.result, .result-card, .card:has(a:has-text("Details"))',
    ].join(','));
    try {
        await cardsOrDetails.first().waitFor({ timeout: 8000 });
    } catch (_) {
        // no-op
    }
    const countDetails = await page.locator('a:has-text("Details"), button:has-text("Details")').count();
    const cardGuess = await page.locator('.result, .result-card, .card').count();
    return { details: countDetails, cards: cardGuess };
}

function textOrNull(v) {
    if (!v) return null;
    const s = String(v).trim();
    return s.length ? s : null;
}

async function extractRecordFromPage(page, fallbackCardTitle = null) {
    // Try to get data from a details page or modal
    const nameSel = ['h1', 'h2', 'header h1', '.title', '.store-name'];
    let name = null;
    for (const sel of nameSel) {
        const t = await page.locator(sel).first().textContent().catch(() => null);
        if (t && t.trim().length > 2) { name = t.trim(); break; }
    }
    if (!name) name = fallbackCardTitle;

    // Address: try common patterns
    const addrSel = [
        '[itemprop="streetAddress"]',
        '.address', '.addr', '.contact-address', '.vcard', '.address-block'
    ];
    let street = null, zip = null, city = null;
    for (const sel of addrSel) {
        const txt = await page.locator(sel).first().innerText().catch(() => null);
        if (txt && txt.trim()) {
            const t = txt.replace(/\s+/g, ' ').trim();
            // Try to parse ZIP + City
            const m = t.match(/\b(\d{5})\b\s+([A-ZÄÖÜa-zäöüß.\- ]{2,})/);
            if (m) { zip = m[1]; city = m[2].trim(); }
            // street = first line before ZIP
            const lines = t.split(/,|\n/).map(s => s.trim()).filter(Boolean);
            if (lines.length) {
                // Pick the one that looks like street with number
                const streetCand = lines.find(l => /\d/.test(l)) || lines[0];
                street = streetCand;
            }
            break;
        }
    }

    // Phone
    let phone = await page.locator('a[href^="tel:"]').first().getAttribute('href').catch(() => null);
    if (phone) phone = phone.replace(/^tel:/, '').trim();
    if (!phone) {
        const t = await page.locator('text=/Telefon|Phone/i').first().locator('xpath=following::*[1]').textContent().catch(()=>null);
        if (t) phone = t.replace(/[^\d+()/\-\s]/g, '').trim();
    }

    // Website
    let website = null;
    const links = page.locator('a[href^="http"]');
    const total = await links.count().catch(() => 0);
    for (let i = 0; i < Math.min(total, 10); i++) {
        const href = await links.nth(i).getAttribute('href').catch(() => null);
        if (!href) continue;
        // Skip obvious internal anchors
        if (href.includes('javascript:')) continue;
        website = href;
        break;
    }

    // Type
    let type = null;
    const pageText = (await page.content()).toString().toLowerCase();
    if (pageText.includes('marktstand')) type = 'Marktstand';
    else if (pageText.includes('lieferservice')) type = 'Lieferservice';
    else if (pageText.includes('bioladen') || pageText.includes('bio-laden') || pageText.includes('naturkost')) type = 'Bioladen';

    return {
        name: textOrNull(name),
        street: textOrNull(street),
        zip: textOrNull(zip),
        city: textOrNull(city),
        phone: textOrNull(phone),
        website: textOrNull(website),
        type: textOrNull(type),
    };
}

async function runOnce(browser, baseUrl, zip, options) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    // Open base
    let urlTried = baseUrl;
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await acceptCookies(page);
    await setZipAndRadiusUI(page, zip);

    // Wait for results, else fallback by URL
    let { details, cards } = await waitForResults(page);
    if (details === 0 && cards === 0) {
        const fallback = buildUrlWithFallback(baseUrl, zip);
        urlTried = fallback;
        await page.goto(fallback, { waitUntil: 'domcontentloaded' });
        await acceptCookies(page);
        ({ details, cards } = await waitForResults(page));
        if (details === 0 && cards === 0) {
            // Screenshot for debugging
            const key = `no_results_${zip}.png`;
            await page.screenshot({ path: key, fullPage: true }).catch(()=>{});
            log.info(`DETAILS buttons: 0 | Result-Cards: 0`);
            await ctx.close();
            return 0;
        }
    }

    // Collect details buttons or cards
    const detailLoc = page.locator('a:has-text("Details"), button:has-text("Details")');
    let count = await detailLoc.count();
    if (count === 0) {
        // Fallback: click cards themselves
        const cardsLoc = page.locator('.result a, .result-card a, a:has-text("mehr"), a:has-text("Mehr")');
        count = await cardsLoc.count();
    }
    log.info(`DETAILS buttons: ${count} | Result-Cards: ${cards}`);

    let saved = 0;
    for (let i = 0; i < count; i++) {
        // Try to capture card title as fallback name
        let cardTitle = null;
        try {
            const titleCand = await page.locator('.result h3, .card h3, .result .title, .card .title').nth(i).textContent();
            if (titleCand) cardTitle = titleCand.trim();
        } catch {}

        // Open details in new tab if link has target=_blank, else navigate and go back
        const link = detailLoc.nth(i);
        let href = null;
        try { href = await link.getAttribute('href'); } catch {}

        if (href && /^https?:\/\//i.test(href)) {
            const dpage = await ctx.newPage();
            await dpage.goto(href, { waitUntil: 'domcontentloaded' });
            await acceptCookies(dpage);
            const rec = await extractRecordFromPage(dpage, cardTitle);
            await Actor.pushData({
                sourceZip: String(zip),
                sourceUrl: href,
                ...rec
            });
            await dpage.close();
            saved++;
        } else {
            // navigate by clicking
            try { await link.click(); } catch (_) { continue; }

            // wait a little for either nav or modal
            await sleep(800);
            const rec = await extractRecordFromPage(page, cardTitle);
            await Actor.pushData({
                sourceZip: String(zip),
                sourceUrl: page.url(),
                ...rec
            });
            saved++;

            // try to go back if navigation happened
            try { await page.goBack({ waitUntil: 'domcontentloaded' }); } catch {}
        }
        if (options.slowMode) await sleep(200);
    }

    await ctx.close();
    return saved;
}

(async () => {
    await Actor.init();
    try {
        const input = await Actor.getInput() || {};
        const baseUrl = input.baseUrl || process.env.BASE_URL;
        if (!baseUrl) throw new Error('Bitte `baseUrl` im Input setzen (Trefferlisten-Seite der Händlersuche).');

        const startAt = Number(input.startAt || 0);
        const maxZips = Number(input.maxZips || 999999);
        const slowMode = !!input.slowMode;
        const headful = !!input.headful;

        // Read PLZ list
        const plzPath = path.join(__dirname, 'plz_full.json');
        if (!fs.existsSync(plzPath)) throw new Error('plz_full.json fehlt im Arbeitsverzeichnis.');
        const allZips = JSON.parse(fs.readFileSync(plzPath, 'utf-8'));
        const zips = allZips.slice(startAt, startAt + maxZips);

        log.info(`PLZ in Lauf: ${zips.length} (aus plz_full.json)`);

        const browser = await chromium.launch({
            headless: !headful,
            args: [
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-features=Translate',
            ]
        });

        let totalSaved = 0;
        for (let i = 0; i < zips.length; i++) {
            const zip = zips[i];
            log.info(`=== ${i + 1}/${zips.length} | PLZ ${zip} ===`);
            try {
                const saved = await runOnce(browser, baseUrl, zip, { slowMode });
                log.info(`PLZ ${zip}: ${saved} neue Datensätze gespeichert`);
                totalSaved += saved;
            } catch (err) {
                log.warning(`PLZ ${zip}: Fehler – ${err.message}`);
            }
        }

        await browser.close();
        log.info(`Fertig. Insgesamt gespeichert: ${totalSaved}`);
    } finally {
        await Actor.exit();
    }
})();