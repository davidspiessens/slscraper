/**
 * Scrapet een vaste lijst productcategorieën van proapplestar.com (nieuwe en
 * tweedehands pro-audio, verlichting en video) en slaat de prijzen op in de
 * database. Standaard WooCommerce-paginering, net als cuesale.js. Prijzen
 * staan al excl. BTW op de site ("excl. VAT"), dus geen omrekening nodig.
 * Sommige producten tonen "on request" i.p.v. een bedrag — die worden
 * overgeslagen, net als elders in deze scrapers bij ontbrekende velden.
 *
 * Uitvoeren:
 *     node proapplestar.js
 */

const { chromium } = require("playwright");
const pool = require("./db");
const { log } = require("./logger");
const { parseQuantity } = require("./quantity");

const BASE_URL = "https://www.proapplestar.com";
const SUPPLIER = 18; // Pro Applestar

// Vaste lijst categoriepagina's — geen doorlopende catalogus, elke categorie
// wordt via z'n eigen WooCommerce-paginering (/page/N/) volledig doorlopen.
const CATEGORY_URLS = [
  `${BASE_URL}/product-categorie/new-pro-audio-pro-applestar-en/`,
  `${BASE_URL}/product-categorie/used-pro-sound/`,
  `${BASE_URL}/product-categorie/new-lighting-en/`,
  `${BASE_URL}/product-categorie/used-lights-laten-staan-deze-is-in-het-nederlands-gebruikte-verlichting-en-in-het-engels-used-lights-headline/`,
  `${BASE_URL}/product-categorie/video/new-video/`,
  `${BASE_URL}/product-categorie/video/used-video/`,
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PRODUCT_CARD_SELECTOR = "li.product";

/** Haal alle productkaarten op de huidige pagina op. */
async function getProductsOnPage(page) {
  return page.evaluate((cardSelector) => {
    // "€4500" of "€24.300" -> 4500 / 24300 (punt = duizendtal, geen
    // decimalen). "on request" bevat geen cijfers en geeft null terug.
    function parsePrice(text) {
      if (!text) return null;
      const match = text.match(/€\s*([\d.]+)/);
      if (!match) return null;
      const value = parseFloat(match[1].replace(/\./g, ""));
      return isNaN(value) ? null : value;
    }

    const results = [];
    const cards = document.querySelectorAll(cardSelector);

    cards.forEach((card) => {
      const idMatch = card.className.match(/post-(\d+)/);
      const id = idMatch ? idMatch[1] : null;

      const title = card.querySelector(".woocommerce-loop-product__title")?.textContent.trim() || null;

      const linkEl = card.querySelector("a.woocommerce-loop-product__link");
      const url = linkEl ? linkEl.href : null;

      // De prijstekst ("€4500 per unit") staat als losse tekstnode in
      // ".product-container", niet in een eigen element — vandaar de hele
      // container-tekst doorzoeken i.p.v. een specifieke prijs-selector.
      const containerText = card.querySelector(".product-container")?.innerText || "";
      const price = parsePrice(containerText);

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
    console.log(`  ⚠ ${skipped} product(en) overgeslagen wegens ontbrekende velden (bv. "on request").`);
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

  await log(SUPPLIER, "Start van proapplestar.js", "start");

  let totalFound = 0;
  let totalSaved = 0;
  const seen = new Set();
  let isFirstRequest = true;

  for (const categoryUrl of CATEGORY_URLS) {
    let currentUrl = categoryUrl;
    let pageNum = 1;

    while (currentUrl) {
      if (!isFirstRequest) {
        console.log("  ⏳ 30s wachten voor volgende pagina...");
        await sleep(30000);
      }
      isFirstRequest = false;

      console.log(`Pagina ${pageNum} (${categoryUrl}): ${currentUrl}`);
      await page.goto(currentUrl, { waitUntil: "load", timeout: 30000 });

      try {
        await page.waitForSelector(PRODUCT_CARD_SELECTOR, { timeout: 15000 });
      } catch (err) {
        // "Geen producten" is een normaal, geldig resultaat voor een lege
        // categorie (bv. video op het moment van schrijven) — geen fout.
        console.log("  ⚠ Geen productkaarten gevonden op deze pagina/categorie.");
        break;
      }

      const products = await getProductsOnPage(page);
      totalFound += products.length;

      // Dedupliceren op url (of titel als fallback), ook over categorieën/pagina's heen
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
      await log(SUPPLIER, `${categoryUrl} pagina ${pageNum}: ${products.length} gevonden, ${saved} opgeslagen`);

      const nextUrl = await getNextPageUrl(page);
      currentUrl = nextUrl && nextUrl !== currentUrl ? nextUrl : null;
      pageNum += 1;
    }
  }

  await browser.close();

  console.log(`\n✓ ${totalSaved} product(en) opgeslagen in de database (${totalFound} gevonden)`);
  await log(SUPPLIER, `Einde van proapplestar.js: ${totalSaved} opgeslagen (${totalFound} gevonden)`, "success");

  await pool.end();
}

scrape().catch(async (err) => {
  console.error(err);
  await log(SUPPLIER, `Fout in proapplestar.js: ${err.message}`, "error");
  process.exit(1);
});
