/**
 * Scrapet de B-stock-zoekresultaten van musicstore.com voor een vaste
 * zoekopdracht en slaat de prijzen op in de database. Prijzen staan op de
 * site incl. BTW; database/UI gaan uit van prijzen excl. BTW, dus hier
 * terugrekenen vóór het opslaan (zie ook coolblue.js/thomann.js).
 *
 * Paginering via het padsegment "/search/{pageIndex}" (0-indexed; pagina 1
 * is index 0). Op het moment van schrijven ~3500 resultaten over ~39
 * pagina's (90/pagina).
 *
 * Uitvoeren:
 *     node musicstore.js [startpagina]
 */

const { chromium } = require("playwright");
const pool = require("./db");
const { log } = require("./logger");

const startPage = process.argv[2] ? parseInt(process.argv[2], 10) : 1;
if (!Number.isInteger(startPage) || startPage < 1) {
  console.error("Gebruik: node musicstore.js [startpagina]");
  console.error("Startpagina moet een geheel getal groter dan of gelijk aan 1 zijn.");
  process.exit(1);
}

const BASE_URL = "https://www.musicstore.com";
const SEARCH_PATH = "/nl_BE/EUR/search";
const FIXED_QUERY = "PageSize=90&SearchTerm=b-stock&SearchParameter=%26%40QueryTerm%3Db-stock%26Isondemand%3Dfalse";
const SUPPLIER = 15; // Music Store
// Music Store toont prijzen incl. BTW; database/UI gaan uit van excl. BTW.
const VAT_RATE = 1.21;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PRODUCT_CARD_SELECTOR = ".tile-product";

function buildPageUrl(pageNum) {
  const pageIndex = pageNum - 1; // paginering is 0-indexed in de URL
  return `${BASE_URL}${SEARCH_PATH}/${pageIndex}?${FIXED_QUERY}`;
}

/** Haal alle productkaarten op de huidige pagina op. */
async function getProductsOnPage(page) {
  return page.evaluate((cardSelector) => {
    // "236,90 €" of "3.614,70 €" -> 236.90 / 3614.70 (punt = duizendtal).
    function parsePrice(text) {
      if (!text) return null;
      const cleaned = text.replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
      const value = parseFloat(cleaned);
      return isNaN(value) ? null : value;
    }

    const results = [];
    const cards = document.querySelectorAll(cardSelector);

    cards.forEach((card) => {
      const artnrText = card.querySelector(".artnr")?.textContent || "";
      const idMatch = artnrText.match(/Artikelnummer:\s*(\S+)/);
      const id = idMatch ? idMatch[1] : null;

      const titleLink = card.querySelector("a.name");
      const title = titleLink?.querySelector("span")?.textContent.trim() || titleLink?.textContent.trim() || null;
      const url = titleLink ? titleLink.href : null;

      const priceEl = card.querySelector(".final");
      const priceNow = priceEl ? parsePrice(priceEl.textContent) : null;
      // Geen apart doorgestreepte prijs gezien in de praktijk (lijst- en
      // verkoopprijs zijn hier steeds gelijk); listPriceTransfer als fallback.
      const listInfo = card.querySelector('[id^="listPriceTransfer-"]')?.dataset.info;
      const priceOriginal = listInfo ? parsePrice(listInfo) : priceNow;

      // De zoekopdracht "b-stock" levert ook resultaten op zonder "B-Stock"
      // in de titel (bv. modelcodes die toevallig matchen, of accessoires
      // die gewoon in dezelfde categorie meegenomen worden) — die zijn geen
      // echte b-stock-aanbiedingen en worden hier overgeslagen.
      if (id && title && url && priceNow != null && /b-stock/i.test(title)) {
        results.push({ id, title, priceOriginal, priceNow, discount: "", url });
      }
    });

    return results;
  }, PRODUCT_CARD_SELECTOR);
}

/** Leest het hoogste paginanummer uit de paginering-links. */
async function getTotalPages(page) {
  const pageNumbers = await page.evaluate(() => {
    const links = document.querySelectorAll(".paging-list a");
    return Array.from(links)
      .map((a) => parseInt(a.textContent.trim(), 10))
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

  await log(SUPPLIER, "Start van musicstore.js");

  let totalPages = null;
  let totalFound = 0;
  let totalSaved = 0;
  const seen = new Set();

  for (let pageNum = startPage; totalPages === null || pageNum <= totalPages; pageNum++) {
    const url = buildPageUrl(pageNum);
    console.log(`Pagina ${pageNum}${totalPages ? `/${totalPages}` : ""}: ${url}`);

    // De site laat af en toe kort een bot-controlepagina ("Just a moment...")
    // zien i.p.v. de echte resultaten — meestal tijdelijk en weg bij een
    // volgende poging. Zonder retry stopte de hele run stil bij zo'n hik.
    let cardsFound = false;
    for (let attempt = 1; attempt <= 3 && !cardsFound; attempt++) {
      if (attempt > 1) {
        console.log(`  ⏳ Poging ${attempt}/3: 15s wachten en herladen...`);
        await sleep(15000);
      }
      // "networkidle" resolveert hier nooit (blijvende achtergrondverbindingen,
      // tracking/analytics) — "load" + de expliciete waitForSelector daarna is
      // voldoende om te weten dat de productkaarten er staan.
      await page.goto(url, { waitUntil: "load", timeout: 30000 });

      try {
        await page.waitForSelector(PRODUCT_CARD_SELECTOR, { timeout: 15000 });
        cardsFound = true;
      } catch (err) {
        console.log(`  ⚠ Geen productkaarten gevonden (poging ${attempt}/3).`);
      }
    }

    if (!cardsFound) {
      console.log("  ⚠ Deze pagina overgeslagen na 3 mislukte pogingen.");
      await log(SUPPLIER, `Waarschuwing: geen productkaarten gevonden op pagina ${pageNum} (${url}) na 3 pogingen, pagina overgeslagen.`);
      continue;
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
  await log(SUPPLIER, `Einde van musicstore.js: ${totalSaved} opgeslagen (${totalFound} gevonden)`);

  await pool.end();
}

scrape();
