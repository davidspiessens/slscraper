/**
 * Scrapet tweedehands producten van cuesale.com/shop/ en slaat ze op in de
 * database. Standaard WooCommerce-paginering. Prijzen staan al excl. BTW op
 * de site ("excl. vat"), dus geen omrekening nodig.
 *
 * Uitvoeren:
 *     node cuesale.js [startpagina]
 */

const { chromium } = require("playwright");
const pool = require("./db");
const { log } = require("./logger");

const startPage = process.argv[2] ? parseInt(process.argv[2], 10) : 1;
if (!Number.isInteger(startPage) || startPage < 1) {
  console.error("Gebruik: node cuesale.js [startpagina]");
  console.error("Startpagina moet een geheel getal groter dan of gelijk aan 1 zijn.");
  process.exit(1);
}

const BASE_URL = "https://cuesale.com";
const QUERY = "per_page=36";
const START_URL =
  startPage > 1 ? `${BASE_URL}/shop/page/${startPage}/?${QUERY}` : `${BASE_URL}/shop/?${QUERY}`;
const SUPPLIER = 11; // CueSale

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PRODUCT_CARD_SELECTOR = ".wd-product[data-id]";

/** Haal alle productkaarten op de huidige pagina op. */
async function getProductsOnPage(page) {
  return page.evaluate((cardSelector) => {
    // Zet een Euro-geformatteerd prijsgetal ("7.775,00") om naar een float.
    function parsePrice(text) {
      if (!text) return null;
      const normalized = text.replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
      const value = parseFloat(normalized);
      return isNaN(value) ? null : value;
    }

    const results = [];
    const cards = document.querySelectorAll(cardSelector);

    cards.forEach((card) => {
      const id = card.getAttribute("data-id");

      // --- Titel en URL ---
      const linkEl = card.querySelector("h3.wd-entities-title a");
      const title = linkEl ? linkEl.innerText.trim() : null;
      const url = linkEl ? linkEl.href : null;

      // --- Prijzen: variabele producten tonen een prijsklasse ("€X – €Y",
      // vanaf-prijs voor meerdere varianten), geen korting — cuesale heeft
      // nergens een echte van/nu-kortingsprijs. Bij 2+ bedragen nemen we dus
      // de laagste ("vanaf"-prijs) als enige prijs, anders het ene bedrag.
      const priceEls = card.querySelectorAll(".price .amount");
      let priceOriginal = null;
      let priceNow = null;
      if (priceEls.length >= 2) {
        const values = Array.from(priceEls)
          .map((el) => parsePrice(el.innerText))
          .filter((v) => v != null);
        const minPrice = values.length ? Math.min(...values) : null;
        priceOriginal = minPrice;
        priceNow = minPrice;
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

  await log(SUPPLIER, "Start van cuesale.js");

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
      await log(SUPPLIER, `Waarschuwing: geen productkaarten gevonden op pagina ${pageNum} (${currentUrl}), scrape gestopt.`);
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
  await log(SUPPLIER, `Einde van cuesale.js: ${totalSaved} opgeslagen (${totalFound} gevonden)`);

  await pool.end();
}

scrape();
