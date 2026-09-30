/**
 * Scrapet de hoogste bieding per lot van alle veilingen op
 * auctions.cuesale.com en slaat ze op in de database. Bedragen staan excl.
 * BTW en excl. 16% veilingkosten op de site — wij verhogen elk bod met 16%
 * en vermelden dat in discount_label ("incl. 16% veilingkost"). Lots zonder
 * bod worden overgeslagen.
 *
 * Site-eigenaardigheden om rekening mee te houden:
 * - De lotlijst laadt in batches van 50 via een "Load more"-link (Drupal
 *   cursor-paginering, geen aparte pagina-URL's) — die moet dus herhaald
 *   aangeklikt worden tot hij verdwijnt. Deze lijst gebruiken we enkel om de
 *   id/titel/url van elk lot te verzamelen.
 * - HET BODBEDRAG ZELF HALEN WE NIET UIT DIE LIJST: elke lotkaart (én elke
 *   individuele lotpagina) toont eerst een "shimmer"-skeleton met een
 *   hardcoded placeholderbedrag ("€ 2200", aria-busy="true") tot een
 *   asynchrone call het echte bod invult (aria-busy="false"). Wie te vroeg
 *   leest — zoals de eerste versie van dit script deed door na een paar
 *   scrolls te stoppen — slaat dat neptbedrag op i.p.v. het echte bod. Om dit
 *   volledig te vermijden bezoeken we elk lot z'n eigen detailpagina en
 *   wachten we expliciet tot aria-busy="false" (of het bod-element helemaal
 *   verdwenen is, wat op een lot zonder enig bod wijst) voor we het bedrag
 *   uitlezen.
 *
 * Uitvoeren:
 *     node cuesaleauctions.js
 */

const { chromium } = require("playwright");
const pool = require("./db");
const { log } = require("./logger");

const BASE_URL = "https://auctions.cuesale.com";
const SUPPLIER = 19; // CueSale Veilingen
const VEILINGKOST_RATE = 1.16;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// "€ 10.300" -> 10300 (punt = duizendtal, geen decimalen op deze site).
function parsePrice(text) {
  if (!text) return null;
  const match = text.match(/€\s*([\d.]+)/);
  if (!match) return null;
  const value = parseFloat(match[1].replace(/\./g, ""));
  return isNaN(value) ? null : value;
}

/** Haalt alle veiling-dashboardlinks op van de homepage. */
async function getAuctionUrls(page) {
  await page.goto(`${BASE_URL}/nl`, { waitUntil: "load", timeout: 30000 });
  const hrefs = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="/dashboard/"]');
    return [...new Set(Array.from(links).map((a) => a.getAttribute("href")))];
  });
  return hrefs.map((href) => (href.startsWith("http") ? href : BASE_URL + href));
}

/**
 * Klikt de "Load more"-link (cursor-paginering) net zo lang aan tot alle
 * lots van de veiling in de pagina geladen zijn.
 */
async function loadAllLots(page) {
  let clicks = 0;
  while (clicks < 50) {
    const hasNext = await page.evaluate(() => !!document.querySelector('a.button[rel="next"]'));
    if (!hasNext) break;
    await page.evaluate(() => document.querySelector('a.button[rel="next"]').click());
    clicks += 1;
    // Elke klik triggert een Drupal AJAX-call die de volgende 50 lots
    // toevoegt; die heeft tijd nodig om te renderen voor de volgende klik.
    await sleep(2000);
  }
}

/** Haalt id/titel/url van elk lot op van de huidige, volledig geladen lotlijst (géén bod). */
async function getLotStubsOnPage(page) {
  return page.evaluate(() => {
    const results = [];
    const cards = document.querySelectorAll("article.lot-teaser");

    cards.forEach((card) => {
      const linkEl = card.querySelector("a.stretched-link");
      const url = linkEl ? linkEl.href : null;
      const idMatch = url ? url.match(/\/lot-details\/(\d+)\//) : null;
      const id = idMatch ? idMatch[1] : null;

      const titleEl = card.querySelector(".field--name-label h3");
      const title = titleEl ? titleEl.textContent.trim() : null;

      // Geen lotlabel ("128 - 1") vooraan de titel plakken: dat zou het
      // eerste woord van de titel voor brands.js/link_brands.js verpesten
      // (die verwachten daar het merk of op z'n minst een aantal, geen
      // veilingnummer). Het lotlabel blijft terug te vinden via de url.
      if (id && title && url) {
        results.push({ id, title, url });
      }
    });

    return results;
  });
}

/**
 * Bezoekt de detailpagina van één lot en wacht tot het bod-element klaar is
 * met laden (aria-busy="false") voor het bedrag uitgelezen wordt. Geeft de
 * bodtekst terug, of null als het lot geen enkel bod heeft.
 */
async function getBidForLot(page, lot) {
  await page.goto(lot.url, { waitUntil: "load", timeout: 30000 });

  try {
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-engine-field="current-bid"]');
        return !el || el.getAttribute("aria-busy") === "false";
      },
      { timeout: 10000 }
    );
  } catch (err) {
    return { bidText: null, timedOut: true };
  }

  const bidText = await page.evaluate(
    () => document.querySelector('[data-engine-field="current-bid"] .current-bid')?.textContent.trim() || null
  );
  return { bidText, timedOut: false };
}

/** Zoekt een bestaand product op basis van supplier + supplier_product_id, of maakt het aan. */
async function getOrCreateProductId(lot) {
  const [rows] = await pool.query(
    "SELECT id FROM bstock_product WHERE supplier_id = ? AND supplier_product_id = ? LIMIT 1",
    [SUPPLIER, lot.id]
  );
  if (rows.length > 0) {
    return rows[0].id;
  }

  const [result] = await pool.query(
    "INSERT INTO bstock_product (supplier_id, supplier_product_id, title, url) VALUES (?, ?, ?, ?)",
    [SUPPLIER, lot.id, lot.title, lot.url]
  );
  return result.insertId;
}

/** Slaat een lot met een geldig bod op in de database (bod + 16% veilingkost). */
async function saveLot(lot, bid) {
  const priceInclVeilingkost = Math.round(bid * VEILINGKOST_RATE * 100) / 100;
  const productId = await getOrCreateProductId(lot);

  await pool.query(
    "INSERT INTO bstock_product_price (bstock_product_id, priceOriginal, priceNow, discount_label) VALUES (?, ?, ?, ?)",
    [productId, priceInclVeilingkost, priceInclVeilingkost, "incl. 16% veilingkost"]
  );
}

async function scrape() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/124.0.0.0 Safari/537.36",
    locale: "nl-BE",
  });
  const page = await context.newPage();

  await log(SUPPLIER, "Start van cuesaleauctions.js", "start");

  const auctionUrls = await getAuctionUrls(page);
  console.log(`Gevonden veilingen: ${auctionUrls.length}`);

  let totalFound = 0;
  let totalSaved = 0;
  let totalTimedOut = 0;

  for (let i = 0; i < auctionUrls.length; i++) {
    const auctionUrl = auctionUrls[i];
    console.log(`Veiling: ${auctionUrl}`);
    await page.goto(auctionUrl, { waitUntil: "load", timeout: 30000 });

    try {
      await page.waitForSelector("article.lot-teaser", { timeout: 15000 });
    } catch (err) {
      console.log("  ⚠ Geen lots gevonden op deze veiling.");
      await log(SUPPLIER, `Waarschuwing: geen lots gevonden op ${auctionUrl}, overgeslagen.`, "warning");
      continue;
    }

    await loadAllLots(page);
    const lots = await getLotStubsOnPage(page);
    totalFound += lots.length;
    console.log(`  → ${lots.length} lots gevonden, bod per lot ophalen...`);

    let saved = 0;
    let skipped = 0;
    let timedOut = 0;

    for (let j = 0; j < lots.length; j++) {
      const lot = lots[j];
      const { bidText, timedOut: didTimeOut } = await getBidForLot(page, lot);

      if (didTimeOut) {
        timedOut += 1;
      } else {
        const bid = parsePrice(bidText);
        if (bid == null) {
          skipped += 1;
        } else {
          await saveLot(lot, bid);
          saved += 1;
        }
      }

      if ((j + 1) % 50 === 0 || j === lots.length - 1) {
        console.log(`    ${j + 1}/${lots.length} lots verwerkt (${saved} opgeslagen, ${skipped} zonder bod, ${timedOut} timeout)`);
        await log(
          SUPPLIER,
          `${auctionUrl}: ${j + 1}/${lots.length} lots verwerkt (${saved} opgeslagen, ${skipped} zonder bod, ${timedOut} timeout)`
        );
      }

      // Lichte pagina (server-rendered, geen zware assets meer nodig na de
      // eerste load), dus een korte pauze volstaat hier i.p.v. de 30s die
      // elders tussen volledige catalogus-pagina's gehanteerd wordt.
      await sleep(500);
    }

    totalSaved += saved;
    totalTimedOut += timedOut;
    console.log(`  ✓ Veiling klaar: ${saved} opgeslagen, ${skipped} zonder bod, ${timedOut} timeout (totaal opgeslagen: ${totalSaved})`);
    await log(SUPPLIER, `${auctionUrl}: klaar — ${saved} opgeslagen, ${skipped} zonder bod, ${timedOut} timeout`);

    if (i < auctionUrls.length - 1) {
      console.log("  ⏳ 30s wachten voor volgende veiling...");
      await sleep(30000);
    }
  }

  await browser.close();

  console.log(`\n✓ ${totalSaved} lot(en) opgeslagen in de database (${totalFound} gevonden, ${totalTimedOut} timeout)`);
  await log(
    SUPPLIER,
    `Einde van cuesaleauctions.js: ${totalSaved} opgeslagen (${totalFound} gevonden, ${totalTimedOut} timeout)`,
    "success"
  );

  await pool.end();
}

scrape().catch(async (err) => {
  console.error(err);
  await log(SUPPLIER, `Fout in cuesaleauctions.js: ${err.message}`, "error");
  process.exit(1);
});
