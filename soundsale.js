/**
 * Scrapet tweedehands producten van soundsale.nl/shop/ en slaat ze op in de
 * database. Standaard WooCommerce-paginering (9 producten per pagina).
 * Prijzen staan al excl. BTW op de site, dus geen omrekening nodig.
 *
 * Uitvoeren:
 *     node soundsale.js [startpagina]
 */

const { chromium } = require("playwright");
const pool = require("./db");
const { log } = require("./logger");

const startPage = process.argv[2] ? parseInt(process.argv[2], 10) : 1;
if (!Number.isInteger(startPage) || startPage < 1) {
  console.error("Gebruik: node soundsale.js [startpagina]");
  console.error("Startpagina moet een geheel getal groter dan of gelijk aan 1 zijn.");
  process.exit(1);
}

const BASE_URL = "https://soundsale.nl";
const SEARCH_URL = `${BASE_URL}/shop/`;
const START_URL = startPage > 1 ? `${BASE_URL}/shop/page/${startPage}/` : SEARCH_URL;
const SUPPLIER = 6; // SoundSale

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PRODUCT_CARD_SELECTOR = ".jupiterx-product-container[data-product-id]";

/** Haal alle productkaarten op de huidige pagina op. */
async function getProductsOnPage(page) {
  return page.evaluate((cardSelector) => {
    // Zet een Euro-geformatteerd prijsgetal ("3.699,00") om naar een float.
    function parsePrice(text) {
      if (!text) return null;
      const normalized = text.replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
      const value = parseFloat(normalized);
      return isNaN(value) ? null : value;
    }

    const results = [];
    const cards = document.querySelectorAll(cardSelector);

    cards.forEach((card) => {
      const id = card.getAttribute("data-product-id");

      // --- Titel ---
      const titleEl = card.querySelector(".woocommerce-loop-product__title");
      const title = titleEl ? titleEl.innerText.trim() : null;

      // --- URL ---
      const linkEl = card.querySelector("a.woocommerce-LoopProduct-link");
      const url = linkEl ? linkEl.href : null;

      // --- Prijzen: bij korting staan er 2 bedragen (van/nu), anders 1 ---
      const priceEls = card.querySelectorAll(".price .amount");
      let priceOriginal = null;
      let priceNow = null;
      if (priceEls.length >= 2) {
        priceOriginal = parsePrice(priceEls[0].innerText);
        priceNow = parsePrice(priceEls[1].innerText);
      } else if (priceEls.length === 1) {
        priceNow = parsePrice(priceEls[0].innerText);
        priceOriginal = priceNow;
      }

      // --- Kortingsbadge (indien aanwezig) ---
      const discountEl = card.querySelector(".onsale");
      const discount = discountEl ? discountEl.innerText.trim() || null : null;

      if (id && title && url) {
        results.push({ id, title, priceOriginal, priceNow, discount, url });
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
    "INSERT INTO bstock_product (supplier_id, supplier_product_id, title, url) VALUES (?, ?, ?, ?)",
    [SUPPLIER, prod.id, prod.title, prod.url]
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
    const btn = document.querySelector("a.next.page-numbers");
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
    locale: "nl-BE",
  });
  const page = await context.newPage();

  await log(SUPPLIER, "Start van soundsale.js", "start");

  let currentUrl = START_URL;
  let pageNum = startPage;
  let totalFound = 0;
  let totalSaved = 0;
  const seen = new Set();

  while (currentUrl) {
    console.log(`Pagina ${pageNum}: ${currentUrl}`);
    await page.goto(currentUrl, { waitUntil: "networkidle", timeout: 30000 });

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
  await log(SUPPLIER, `Einde van soundsale.js: ${totalSaved} opgeslagen (${totalFound} gevonden)`, "success");

  await pool.end();
}

scrape().catch(async (err) => {
  console.error(err);
  await log(SUPPLIER, `Fout in soundsale.js: ${err.message}`, "error");
  process.exit(1);
});
