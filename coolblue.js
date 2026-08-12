/**
 * Scrapet de "Tweedekans" (refurbished) MacBook-aanbiedingen van coolblue.be
 * voor een vaste zoekopdracht en slaat de tweedekans-prijs op in de database.
 * Elke productkaart toont zowel de normale prijs als een "Voordelige
 * Tweedekans van X,-"-link naar een apart tweedekans-aanbod; wij bewaren de
 * tweedekans-prijs als priceNow (en de normale prijs als priceOriginal,
 * indien aanwezig). Coolblue-prijzen zijn consumentenprijzen incl. BTW, maar
 * de hele database (en de incl./excl.-toggle in de PHP-UI) gaat uit van
 * prijzen excl. BTW — dus hier terugrekenen vóór het opslaan.
 *
 * Dit is geen doorlopende catalogus maar één vaste zoekopdracht (19
 * resultaten, geen paginering nodig op het moment van schrijven) — vandaar
 * geen paginalus zoals bij de andere scrapers.
 *
 * Uitvoeren:
 *     node coolblue.js
 */

const { chromium } = require("playwright");
const pool = require("./db");

const BASE_URL = "https://www.coolblue.be";
const SEARCH_URL = `${BASE_URL}/nl/zoeken/producttype:laptops?query=tweedekans%20mac`;
const SUPPLIER = 13; // Coolblue
// Coolblue toont prijzen incl. BTW; database/UI gaan uit van excl. BTW.
const VAT_RATE = 1.21;

const PRODUCT_CARD_SELECTOR = ".product-card";

/** Haal alle productkaarten met een tweedekans-aanbod op de pagina op. */
async function getProductsOnPage(page) {
  return page.evaluate((cardSelector) => {
    // "718,-" of "1.470,-" -> 718 / 1470 (punt = duizendtal, geen decimalen).
    function parsePrice(text) {
      if (!text) return null;
      const cleaned = text
        .replace(/van/i, "")
        .replace(/[^\d.,]/g, "")
        .replace(/,-?$/, "")
        .replace(/\./g, "");
      const value = parseFloat(cleaned);
      return isNaN(value) ? null : value;
    }

    const results = [];
    const cards = document.querySelectorAll(cardSelector);

    cards.forEach((card) => {
      // --- Tweedekans-link: "Voordelige Tweedekans" + prijs in het
      // volgende <strong>-element ("van 718,-").
      const tweedekansLink = Array.from(card.querySelectorAll("a")).find((a) =>
        a.textContent.includes("Tweedekans")
      );
      if (!tweedekansLink) return;

      const href = tweedekansLink.getAttribute("href");
      const idMatch = href ? href.match(/\/tweedekans-product\/(\d+)/) : null;
      const id = idMatch ? idMatch[1] : null;
      const url = href ? (href.startsWith("http") ? href : location.origin + href) : null;

      const strong = tweedekansLink.parentElement
        ? tweedekansLink.parentElement.querySelector("strong")
        : null;
      const priceNow = strong ? parsePrice(strong.textContent) : null;

      // --- Titel en normale prijs (indien aanwezig) van de productkaart zelf.
      const titleEl = card.querySelector(".product-card__title a, .product-card__title");
      const title = titleEl ? titleEl.textContent.trim() : null;

      const salesPriceEl = card.querySelector(".sales-price");
      const priceOriginal = salesPriceEl ? parsePrice(salesPriceEl.textContent) : priceNow;

      if (id && title && url && priceNow != null) {
        results.push({ id, title, priceOriginal, priceNow, discount: "Tweedekans", url });
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
    if (!prod.id || !prod.title || !prod.url || prod.priceNow == null) {
      skipped += 1;
      continue;
    }

    const productId = await getOrCreateProductId(prod);

    try {
      await pool.query(
        "INSERT INTO bstock_product_price (bstock_product_id, priceOriginal, priceNow, discount_label) VALUES (?, ?, ?, ?)",
        [productId, prod.priceOriginal ?? prod.priceNow, prod.priceNow, prod.discount || ""]
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

  console.log(`Ophalen: ${SEARCH_URL}`);
  await page.goto(SEARCH_URL, { waitUntil: "networkidle", timeout: 30000 });

  try {
    await page.waitForSelector(PRODUCT_CARD_SELECTOR, { timeout: 15000 });
  } catch (err) {
    console.log("  ⚠ Geen productkaarten gevonden op deze pagina.");
    await browser.close();
    await pool.end();
    return;
  }

  const scraped = await getProductsOnPage(page);
  console.log(`  → ${scraped.length} tweedekans-aanbieding(en) gevonden.`);

  // Coolblue toont incl. BTW; terugrekenen naar excl. BTW zoals de rest van de database.
  const products = scraped.map((prod) => ({
    ...prod,
    priceOriginal: prod.priceOriginal != null ? Math.round((prod.priceOriginal / VAT_RATE) * 100) / 100 : null,
    priceNow: prod.priceNow != null ? Math.round((prod.priceNow / VAT_RATE) * 100) / 100 : null,
  }));

  const saved = await saveProducts(products);

  await browser.close();
  await pool.end();

  console.log(`\n✓ ${saved} product(en) opgeslagen in de database (${products.length} gevonden).`);
}

scrape();
