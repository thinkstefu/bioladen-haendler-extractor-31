// @ts-check
import { Actor, log } from 'apify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const SITE = 'https://www.bioladen.de/bio-haendler-suche';

const safe = (v) => (v === undefined || v === '' ? null : v);
function normalize(record, sourcePlz) {
  return {
    name: safe(record.name),
    kategorie: safe(record.category),
    strasse: safe(record.street),
    plz: safe(record.postcode),
    ort: safe(record.city),
    telefon: safe(record.phone),
    email: safe(record.email),
    website: safe(record.website),
    oeffnungszeiten: safe(record.openingHours),
    source_plz: String(sourcePlz),
    source_url: record.sourceUrl || null,
    lat: record.lat ?? null,
    lon: record.lon ?? null,
  };
}
function dupKey(row){ return [row.name||'',row.strasse||'',row.plz||''].join('|').toLowerCase(); }

async function forceRadius50(page, currentPlz) {
  const dom = await page.evaluate(() => {
    const sel = document.querySelector('select[name*="distance"], select#distance, select[name="tx_biohandel_plg[distance]"]');
    if (!sel) return false;
    const opt = [...sel.options].find(o => o.value === "50" || (o.textContent||'').includes('50'));
    if (!opt) return false;
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }).catch(()=>false);

  const u = new URL(page.url());
  u.searchParams.set('tx_biohandel_plg[distance]','50');
  if (!u.searchParams.get('tx_biohandel_plg[searchplz]')) u.searchParams.set('tx_biohandel_plg[searchplz]', String(currentPlz));
  await page.goto(u.toString(), { waitUntil: 'domcontentloaded' });

  const effective = await page.evaluate(() => {
    const sel = document.querySelector('select[name*="distance"], select#distance, select[name="tx_biohandel_plg[distance]"]');
    if (sel) return sel.value;
    const u = new URL(location.href);
    return u.searchParams.get('tx_biohandel_plg[distance]');
  }).catch(()=>null);

  if (effective !== '50') {
    const hard = `${SITE}?tx_biohandel_plg[searchplz]=${encodeURIComponent(currentPlz)}&tx_biohandel_plg[distance]=50`;
    await page.goto(hard, { waitUntil: 'domcontentloaded' });
  }
}

let cookieAccepted = false;
async function acceptCookiesIfAny(page){
  if (cookieAccepted) return;
  const clicked = await page.evaluate(()=>{
    const cand = [...document.querySelectorAll('button,a')].find(b => /(akzeptieren|zustimmen|accept|alle akzeptieren)/i.test(b.textContent||''));
    if (cand) { cand.click(); return true; }
    return false;
  });
  if (clicked){ log.info('Cookie-Banner akzeptiert.'); cookieAccepted = true; }
}

async function enableAllCategories(page){
  await page.evaluate(()=>{
    const tryCheck = (el)=>{ if(el && 'checked' in el && !el.checked){ el.checked=true; el.dispatchEvent(new Event('change',{bubbles:true})); } };
    const sels=[
      'input#bioladen','input[name*="bioladen"]',
      'input#markt','input[name*="markt"]',
      'input#liefer','input[name*="liefer"]',
      'input[type="checkbox"][value*="bio"]',
      'input[type="checkbox"][value*="markt"]',
      'input[type="checkbox"][value*="liefer"]'
    ];
    sels.forEach(s=>tryCheck(document.querySelector(s)));
  }).catch(()=>{});
}

async function extractFromModal(page, modalSel, sourceUrl){
  return await page.evaluate((sel, sourceUrl)=>{
    const root = document.querySelector(sel);
    if (!root) return null;
    const t = (el)=>el?.textContent?.trim()||'';
    const q = (s)=>root.querySelector(s);

    const name = t(q('.modal-title')) || t(q('.biohaendler__title')) || t(q('h3, h4')) || null;

    let website=null;
    const links=[...root.querySelectorAll('a[href^="http"]')];
    const wl = links.find(a=>/web\s*site|web\s*seite|homepage|zur\s*web/i.test(a.textContent||'')) || links[0];
    website = wl?.getAttribute('href') || null;

    const tel = root.querySelector('a[href^="tel:"]')?.getAttribute('href')?.replace(/^tel:/i,'') || null;
    const email = root.querySelector('a[href^="mailto:"]')?.getAttribute('href')?.replace(/^mailto:/i,'') || null;

    const addrNode = [...root.querySelectorAll('*')].find(n=>/\d{5}\s+[A-Za-zÄÖÜäöüß\- ]+/.test(n.textContent||''));
    const addr = t(addrNode);
    let street=null, postcode=null, city=null;
    const m = addr.match(/^\s*(.+?),\s*(\d{5})\s+(.+?)\s*$/);
    if (m){ street=m[1]; postcode=m[2]; city=m[3]; }

    const hoursNode = [...root.querySelectorAll('*')].find(n=>/öffnung|zeiten|uhr/i.test(n.textContent||''));
    const openingHours = hoursNode ? t(hoursNode).replace(/\s+/g,' ').trim() : null;

    const blob=(root.textContent||'').toLowerCase();
    const category = /liefer/.test(blob)?'Lieferservice':(/markt/.test(blob)?'Marktstand':'Bioladen');

    let lat=null, lon=null;
    const geo=[...root.querySelectorAll('[data-lat][data-lng],[data-latitude][data-longitude]')][0];
    if (geo){
      lat=parseFloat(geo.getAttribute('data-lat')||geo.getAttribute('data-latitude'));
      lon=parseFloat(geo.getAttribute('data-lng')||geo.getAttribute('data-longitude'));
      if (Number.isNaN(lat)) lat=null;
      if (Number.isNaN(lon)) lon=null;
    }

    return { name, website, phone:tel, email, street, postcode, city, openingHours, category, lat, lon, sourceUrl };
  }, modalSel, sourceUrl);
}

async function collectModalIds(page){
  return await page.evaluate(()=>{
    const btns=[...document.querySelectorAll('a,button')].filter(b=>/detail/i.test(b.textContent||''));
    const ids=btns.map(b => b.getAttribute('data-bs-target') || b.getAttribute('href'))
                  .filter(Boolean).map(h=>h.replace(/^#/,''));
    return [...new Set(ids)];
  });
}

await Actor.init();
await Actor.main(async ()=>{
  // Load PLZ
  let plz = [];
  try{
    plz = JSON.parse(await fs.readFile(path.join(process.cwd(),'plz_full.json'),'utf-8'));
  }catch{
    plz = ["20095","80331","50667","60311","70173"];
  }
  plz = plz.map(String);
  log.info(`PLZ in Lauf: ${plz.length} (aus plz_full.json)`);

  const browser = await chromium.launch({ headless:true, args:['--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({
    viewport:{ width:1366, height:768 },
    userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
  });
  await ctx.route('**/*', (route)=>{
    const type = route.request().resourceType();
    if (['image','font','stylesheet','media'].includes(type)) return route.abort();
    return route.continue();
  });
  const page = await ctx.newPage();

  const batch = [];
  const seen = new Set();

  for (let i=0;i<plz.length;i++){
    const p = plz[i];
    log.info(`=== ${i+1}/${plz.length} | PLZ ${p} ===`);
    const url = `${SITE}?tx_biohandel_plg[searchplz]=${encodeURIComponent(p)}&tx_biohandel_plg[distance]=50`;
    await page.goto(url, { waitUntil:'domcontentloaded' }).catch(()=>{});
    await acceptCookiesIfAny(page);
    await enableAllCategories(page);
    await forceRadius50(page, p);

    const ids = await collectModalIds(page);
    log.info(`DETAILS buttons: ${ids.length}`);

    for (const id of ids){
      const sel = `#${CSS.escape(id)}`;
      let rec = null;

      const exists = await page.$(sel);
      if (exists) {
        rec = await extractFromModal(page, sel, page.url()).catch(()=>null);
      }
      if (!rec){
        const btn = await page.$(`a[data-bs-target="#${id}"],button[data-bs-target="#${id}"],a[href="#${id}"]`);
        if (btn){
          await btn.click().catch(()=>{});
          await page.waitForSelector(sel, { timeout: 4000 }).catch(()=>{});
          rec = await extractFromModal(page, sel, page.url()).catch(()=>null);
          const close = await page.$(`${sel} button.close, ${sel} button[data-bs-dismiss="modal"], ${sel} .modal-footer button`);
          if (close) await close.click().catch(()=>{});
        }
      }
      if (!rec) continue;

      const row = normalize(rec, p);
      const key = dupKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      batch.push(row);

      if (batch.length >= 25){
        await Actor.pushData(batch.splice(0, batch.length));
      }
    }
    if (batch.length) await Actor.pushData(batch.splice(0, batch.length));
  }

  await browser.close();
});
await Actor.exit();
