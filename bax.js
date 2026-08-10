const { chromium } = require("playwright");
const pool = require("./db");

const keyword = process.argv[2];
if (!keyword) {
  console.error("Gebruik: node bax.js <keyword> [startpagina]");
  console.error('Voorbeeld: node bax.js "b-stock+pioneer" 3');
  process.exit(1);
}

const startPage = process.argv[3] ? parseInt(process.argv[3], 10) : 1;
if (!Number.isInteger(startPage) || startPage < 1) {
  console.error("Startpagina moet een geheel getal groter dan of gelijk aan 1 zijn.");
  process.exit(1);
}

const BASE_URL = "https://www.bax-shop.be";
const SEARCH_URL = `${BASE_URL}/nl/hele-assortiment?keyword=${encodeURIComponent(keyword)}`;
const START_URL = startPage > 1 ? `${SEARCH_URL}&p=${startPage}` : SEARCH_URL;
const SUPPLIER = 1; // bax-shop.be
const VAT_RATE = 1.21; // bax-shop.be toont prijzen incl. BTW, wij slaan excl. BTW op

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PRODUCT_CARD_SELECTOR =
  '.result';

/** Haal alle productkaarten op de huidige pagina op. */
async function getProductsOnPage(page) {
  return page.evaluate((cardSelector) => {
    const results = [];
    const cards = document.querySelectorAll(cardSelector);

    cards.forEach((card) => {
      // --- Titel ---
      const titleEl = card.querySelector(
        '[data-test="product-title"], [class*="title"], [class*="name"], h2, h3'
      );
      const title = titleEl ? titleEl.innerText.trim() : null;

      // --- URL ---
      const linkEl = card.querySelector("a[href]");
      const url = linkEl ? linkEl.href : null;

      // --- Normale prijs ---
      const priceOriginalEl =
        card.querySelector(
          '.van-prijs'
        );

      let priceOriginal = priceOriginalEl ? parseFloat(priceOriginalEl.innerText.trim().replace('.','').replace('€ ', '').replace('-', '00').replace(',','.')) : null;
        
      // --- Prijs nu
      const priceNowEl =
        card.querySelector(
          '.voor-prijs'
        );

      const priceNow = priceNowEl ? parseFloat(priceNowEl.innerText.trim().replace('.','').replace('€ ', '').replace('-', '00').replace(',','.')) : null;

      if (isNaN(priceOriginal)) priceOriginal = priceNow;

      // --- Extra korting / badge ---
      const discountEl = card.querySelector(
        '.product-label'
      );
      const discount = discountEl ? discountEl.innerText.trim() : null;

      // --- Product ID ---
      const idMatch = url ? url.match(/\/product\/(\d+)\//) : null;
      const id = idMatch ? idMatch[1] : null;

      if (title && title.indexOf('(B-Stock)') > -1) {
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

    // bax-shop.be toont prijzen incl. BTW, wij slaan excl. BTW op
    const priceOriginalExclVat = Math.round((prod.priceOriginal / VAT_RATE) * 100) / 100;
    const priceNowExclVat = Math.round((prod.priceNow / VAT_RATE) * 100) / 100;

    try {
      await pool.query(
        "INSERT INTO bstock_product_price (bstock_product_id, priceOriginal, priceNow, discount_label) VALUES (?, ?, ?, ?)",
        [productId, priceOriginalExclVat, priceNowExclVat, prod.discount || ""]
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
    const btn = document.querySelector(
      'a.next'
    );
    return btn ? btn.getAttribute("href") : null;
  });

  if (nextHref) {
    return nextHref.startsWith("http") ? nextHref : BASE_URL + nextHref;
  }
  return null;
}

async function scrape() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" +
      "AppleWebKit/537.36 (KHTML, like Gecko)" +
      "Chrome/150.0.0.0 Safari/537.36",
    locale: "nl-BE",
  });
  const page = await context.newPage();

  let currentUrl = START_URL;
  let pageNum = startPage;
  let totalFound = 0;
  let totalSaved = 0;
  const seen = new Set();

  while (currentUrl) {
    console.log(`Pagina ${pageNum}: ${currentUrl}`);
    await page.goto(currentUrl, { waitUntil: "networkidle", timeout: 30000 });

    // Accept cookies - to be tested
    // if (pageNum === startPage) {
    //   await page.locator('#AcceptReload').click();
    // }

    try {
      await page.waitForSelector(
        '.result',
        { timeout: 15000 }
      );
    } catch (err) {
      console.log("  ⚠ Geen productkaarten gevonden op deze pagina.");
      process.exit(1);
    }

    const products = await getProductsOnPage(page);
    totalFound += products.length;

    // Dedupliceren op URL (of titel als fallback), ook over pagina's heen
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

    const nextUrl = await getNextPageUrl(page);
    currentUrl = nextUrl && nextUrl !== currentUrl ? nextUrl : null;
    pageNum += 1;

    if (currentUrl) {
      console.log("  ⏳ 30s wachten voor volgende pagina...");
      await sleep(30000);
    }
  }

  await browser.close();
  await pool.end();

  console.log(`\n✓ ${totalSaved} product(en) opgeslagen in de database (${totalFound} gevonden)`);
}

scrape();
