/**
 * Scrapet de B-stock-zoekresultaten van thomann.de/be voor een vaste
 * zoekopdracht en slaat de prijzen op in de database. Prijzen staan op de
 * site incl. 21% BTW; database/UI gaan uit van prijzen excl. BTW, dus hier
 * terugrekenen vóór het opslaan (zie ook coolblue.js).
 *
 * Deze zoekopdracht heeft ~5000 resultaten over ~52 pagina's (100/pagina),
 * paginering via de querystring-parameter "pg". Aanzienlijk groter dan de
 * andere scrapers — een volledige run duurt daardoor een stuk langer.
 *
 * Uitvoeren:
 *     node thomann.js [startpagina]
 */

const { chromium } = require("playwright");
const pool = require("./db");
const { log } = require("./logger");

const startPage = process.argv[2] ? parseInt(process.argv[2], 10) : 1;
if (!Number.isInteger(startPage) || startPage < 1) {
  console.error("Gebruik: node thomann.js [startpagina]");
  console.error("Startpagina moet een geheel getal groter dan of gelijk aan 1 zijn.");
  process.exit(1);
}

const BASE_URL = "https://www.thomann.de";
const SEARCH_PATH = "/be/search.html";
const FIXED_QUERY =
  "marketingAttributes%5B%5D=EXCLUDE_BUNDLE&filter=true&ls=100&sw=b-stock&sp=solr_10&cme=true";
const SUPPLIER = 14; // Thomann
// Thomann toont prijzen incl. BTW; database/UI gaan uit van excl. BTW.
const VAT_RATE = 1.21;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PRODUCT_CARD_SELECTOR = ".fx-product-list-entry";

function buildPageUrl(pageNum) {
  return `${BASE_URL}${SEARCH_PATH}?${FIXED_QUERY}&pg=${pageNum}`;
}

/** Haal alle productkaarten op de huidige pagina op. */
async function getProductsOnPage(page) {
  return page.evaluate((cardSelector) => {
    // "€134" of "€1,390" -> 134 / 1390 (komma = duizendtal, geen decimalen).
    // Pakt enkel het getal ná het €-teken: de "30-days best price"-tekst
    // bevat zelf ook cijfers ("30") die anders foutief meegeteld worden.
    function parsePrice(text) {
      if (!text) return null;
      const match = text.match(/€\s*([\d,]+)/);
      if (!match) return null;
      const value = parseFloat(match[1].replace(/,/g, ""));
      return isNaN(value) ? null : value;
    }

    const results = [];
    const cards = document.querySelectorAll(cardSelector);

    cards.forEach((card) => {
      const id = card.getAttribute("data-product-id");

      const manufacturer = card.querySelector(".title__manufacturer")?.textContent.trim() || "";
      const name = card.querySelector(".title__name")?.textContent.trim() || "";
      const title = `${manufacturer} ${name}`.trim();

      const linkEl = card.querySelector("a.product__content");
      const url = linkEl ? new URL(linkEl.getAttribute("href"), location.href).href : null;

      const priceNowEl = card.querySelector(".product__price-primary");
      const priceNow = priceNowEl ? parsePrice(priceNowEl.textContent) : null;

      // --- "30-days best price" als referentieprijs (indien aanwezig, bij
      // producten met een actieve korting); anders gelijk aan priceNow.
      const strikeEl = card.querySelector(".strike-price-with-percentage__info");
      const priceOriginal = strikeEl ? parsePrice(strikeEl.textContent) : priceNow;
      const percentageEl = card.querySelector(".fx-typography-price-strike-percentage");
      const discount = percentageEl ? percentageEl.textContent.trim() : null;

      if (id && title && url && priceNow != null) {
        results.push({ id, title, priceOriginal, priceNow, discount, url });
      }
    });

    return results;
  }, PRODUCT_CARD_SELECTOR);
}

/** Leest het hoogste paginanummer uit de paginering-knoppen. */
async function getTotalPages(page) {
  const pageNumbers = await page.evaluate(() => {
    const buttons = document.querySelectorAll(".search-pagination__pages button");
    return Array.from(buttons)
      .map((b) => parseInt(b.textContent.trim(), 10))
      .filter((n) => Number.isInteger(n));
  });
  return pageNumbers.length ? Math.max(...pageNumbers) : 1;
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

/** Slaat producten en hun prijzen op in de database (na omrekening naar excl. BTW). */
async function saveProducts(products) {
  let saved = 0;
  let skipped = 0;

  for (const prod of products) {
    if (!prod.id || !prod.title || !prod.url || prod.priceNow == null) {
      skipped += 1;
      continue;
    }

    const priceOriginal = Math.round(((prod.priceOriginal ?? prod.priceNow) / VAT_RATE) * 100) / 100;
    const priceNow = Math.round((prod.priceNow / VAT_RATE) * 100) / 100;

    const productId = await getOrCreateProductId(prod);

    try {
      await pool.query(
        "INSERT INTO bstock_product_price (bstock_product_id, priceOriginal, priceNow, discount_label) VALUES (?, ?, ?, ?)",
        [productId, priceOriginal, priceNow, prod.discount || ""]
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

  await log(SUPPLIER, "Start van thomann.js");

  let totalPages = null;
  let totalFound = 0;
  let totalSaved = 0;
  const seen = new Set();

  for (let pageNum = startPage; totalPages === null || pageNum <= totalPages; pageNum++) {
    const url = buildPageUrl(pageNum);
    console.log(`Pagina ${pageNum}${totalPages ? `/${totalPages}` : ""}: ${url}`);
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

    try {
      await page.waitForSelector(PRODUCT_CARD_SELECTOR, { timeout: 15000 });
    } catch (err) {
      console.log("  ⚠ Geen productkaarten gevonden op deze pagina.");
      await log(SUPPLIER, `Waarschuwing: geen productkaarten gevonden op pagina ${pageNum} (${url}), scrape gestopt.`);
      break;
    }

    if (totalPages === null) {
      totalPages = await getTotalPages(page);
      console.log(`  (${totalPages} pagina('s) in totaal)`);
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
    await log(SUPPLIER, `Pagina ${pageNum}/${totalPages}: ${products.length} gevonden, ${saved} opgeslagen`);

    if (pageNum < totalPages) {
      console.log("  ⏳ 30s wachten voor volgende pagina...");
      await sleep(30000);
    }
  }

  await browser.close();

  console.log(`\n✓ ${totalSaved} product(en) opgeslagen in de database (${totalFound} gevonden)`);
  await log(SUPPLIER, `Einde van thomann.js: ${totalSaved} opgeslagen (${totalFound} gevonden)`);

  await pool.end();
}

scrape();
