/**
 * Scrapet tweedehands producten van 10kused.com/product-listings/ en slaat
 * ze op in de database. Standaard WooCommerce-paginering. Prijzen staan al
 * excl. BTW op de site ("All prices shown on this website are exclusive of
 * VAT"), dus geen omrekening nodig.
 *
 * Grote catalogus (~4978 producten, 18 per pagina, ~277 pagina's) — met de
 * gebruikelijke 30s tussen pagina's duurt een volledige scrape dus bijna
 * 2,5 uur, maar dat is de uitdrukkelijke keuze hier (consistent met de
 * andere leveranciers in dit project).
 *
 * Opgelet: de prijs die hier getoond wordt is niet altijd de werkelijke
 * transactieprijs van de volledige listing — sommige producten worden per
 * paar/pakket verkocht waarbij deze pagina soms de prijs "per stuk" toont
 * en soms de totale pakketprijs (zie bv. product-detailpagina's: "SOLD AS:
 * Pairs" vs "SOLD AS: Full Package"). Dat onderscheid is enkel op de
 * individuele productpagina te zien, niet op deze overzichtspagina — net als
 * bij alle andere leveranciers in dit project wordt enkel een leidend
 * aantal-voorvoegsel in de titel ("4x ...") als quantity herkend; impliciete
 * pakketten zonder zo'n voorvoegsel in de titel blijven quantity 1.
 *
 * Uitvoeren:
 *     node 10kused.js [startpagina]
 */

const { chromium } = require("playwright");
const pool = require("./db");
const { log } = require("./logger");
const { parseQuantity } = require("./quantity");

const startPage = process.argv[2] ? parseInt(process.argv[2], 10) : 1;
if (!Number.isInteger(startPage) || startPage < 1) {
  console.error("Gebruik: node 10kused.js [startpagina]");
  console.error("Startpagina moet een geheel getal groter dan of gelijk aan 1 zijn.");
  process.exit(1);
}

const BASE_URL = "https://www.10kused.com";
const START_URL =
  startPage > 1 ? `${BASE_URL}/product-listings/page/${startPage}/` : `${BASE_URL}/product-listings/`;
const SUPPLIER = 21; // 10Kused

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PRODUCT_CARD_SELECTOR = ".product.type-product";

/** Haal alle productkaarten op de huidige pagina op. */
async function getProductsOnPage(page) {
  return page.evaluate((cardSelector) => {
    // "€4,656" -> 4656 (komma = duizendtal, Engelstalige site, net als een
    // eventueel decimaal punt i.p.v. de Europese komma-als-decimaal-stijl).
    function parsePrice(text) {
      if (!text) return null;
      const match = text.match(/€\s*([\d,]+(?:\.\d+)?)/);
      if (!match) return null;
      const value = parseFloat(match[1].replace(/,/g, ""));
      return isNaN(value) ? null : value;
    }

    const results = [];
    const cards = document.querySelectorAll(cardSelector);

    cards.forEach((card) => {
      const idMatch = card.className.match(/post-(\d+)/);
      const id = idMatch ? idMatch[1] : null;

      const titleEl = card.querySelector(".woocommerce-loop-product__title");
      const title = titleEl ? titleEl.textContent.trim() : null;

      const linkEl = card.querySelector("a.woocommerce-loop-product__link");
      const url = linkEl ? linkEl.href : null;

      const priceText = card.querySelector(".price")?.textContent.trim() || "";
      const price = parsePrice(priceText);

      if (id && title && url && price != null) {
        results.push({ id, title, priceOriginal: price, priceNow: price, discount: null, url });
      }
    });

    return results;
  }, PRODUCT_CARD_SELECTOR);
}

/** Zoekt een bestaand product op basis van supplier + supplier_product_id, of maakt het aan. */
async function getOrCreateProductId(prod) {
  const [rows] = await pool.query(
    "SELECT id FROM bstock_product WHERE supplier_id = ? AND supplier_product_id = ? LIMIT 1",
    [SUPPLIER, prod.id]
  );
  if (rows.length > 0) {
    return rows[0].id;
  }

  const [result] = await pool.query(
    "INSERT INTO bstock_product (supplier_id, supplier_product_id, title, quantity, url) VALUES (?, ?, ?, ?, ?)",
    [SUPPLIER, prod.id, prod.title, parseQuantity(prod.title), prod.url]
  );
  return result.insertId;
}

/** Slaat producten en hun prijzen op in de database. */
async function saveProducts(products) {
  let saved = 0;
  let skipped = 0;

  for (const prod of products) {
    if (!prod.id || !prod.title || !prod.url) {
      skipped += 1;
      continue;
    }
    if (prod.priceOriginal == null || prod.priceNow == null) {
      skipped += 1;
      continue;
    }

    const productId = await getOrCreateProductId(prod);

    try {
      await pool.query(
        "INSERT INTO bstock_product_price (bstock_product_id, priceOriginal, priceNow, discount_label) VALUES (?, ?, ?, ?)",
        [productId, prod.priceOriginal, prod.priceNow, prod.discount || ""]
      );
      saved += 1;
    } catch (error) {
      console.error(error);
    }
  }

  if (skipped > 0) {
    console.log(`  ⚠ ${skipped} product(en) overgeslagen wegens ontbrekende velden.`);
  }

  return saved;
}

/** Geeft de URL van de volgende pagina, of null als er geen is. */
async function getNextPageUrl(page) {
  const nextHref = await page.evaluate(() => {
    const btn = document.querySelector("a.next.page-numbers, a.next");
    return btn ? btn.getAttribute("href") : null;
  });

  if (nextHref) {
    return nextHref.startsWith("http") ? nextHref : BASE_URL + nextHref;
  }
  return null;
}

async function scrape() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/124.0.0.0 Safari/537.36",
    locale: "en-GB",
  });
  const page = await context.newPage();

  await log(SUPPLIER, "Start van 10kused.js", "start");

  let currentUrl = START_URL;
  let pageNum = startPage;
  let totalFound = 0;
  let totalSaved = 0;
  const seen = new Set();

  while (currentUrl) {
    console.log(`Pagina ${pageNum}: ${currentUrl}`);
    await page.goto(currentUrl, { waitUntil: "load", timeout: 30000 });

    try {
      await page.waitForSelector(PRODUCT_CARD_SELECTOR, { timeout: 15000 });
    } catch (err) {
      console.log("  ⚠ Geen productkaarten gevonden op deze pagina.");
      await log(SUPPLIER, `Waarschuwing: geen productkaarten gevonden op pagina ${pageNum} (${currentUrl}), scrape gestopt.`, "warning");
      break;
    }

    const products = await getProductsOnPage(page);
    totalFound += products.length;

    // Dedupliceren op url (of titel als fallback), ook over pagina's heen
    const unique = [];
    for (const prod of products) {
      const key = prod.url || prod.title;
      if (key && !seen.has(key)) {
        seen.add(key);
        unique.push(prod);
      }
    }

    const saved = await saveProducts(unique);
    totalSaved += saved;
    console.log(`  → ${products.length} producten gevonden, ${saved} opgeslagen (totaal opgeslagen: ${totalSaved})`);
    await log(SUPPLIER, `Pagina ${pageNum}: ${products.length} gevonden, ${saved} opgeslagen`);

    const nextUrl = await getNextPageUrl(page);
    currentUrl = nextUrl && nextUrl !== currentUrl ? nextUrl : null;
    pageNum += 1;

    if (currentUrl) {
      console.log("  ⏳ 30s wachten voor volgende pagina...");
      await sleep(30000);
    }
  }

  await browser.close();

  console.log(`\n✓ ${totalSaved} product(en) opgeslagen in de database (${totalFound} gevonden)`);
  await log(SUPPLIER, `Einde van 10kused.js: ${totalSaved} opgeslagen (${totalFound} gevonden)`, "success");

  await pool.end();
}

scrape().catch(async (err) => {
  console.error(err);
  await log(SUPPLIER, `Fout in 10kused.js: ${err.message}`, "error");
  process.exit(1);
});
