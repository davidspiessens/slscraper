const { chromium } = require("playwright");
const pool = require("./db");
const { log } = require("./logger");

const BASE_URL = "https://www.progear.be";
const SEARCH_URL = `${BASE_URL}/nl/b-stock?size=1000`;
const START_URL = SEARCH_URL;
const SUPPLIER = 3; // progear.be
const VAT_RATE = 1.21; // progear.be toont prijzen incl. BTW, wij slaan excl. BTW op

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PRODUCT_CARD_SELECTOR = '.thumbSetting';

/** Haal alle productkaarten op de huidige pagina op. */
async function getProductsOnPage(page) {
  return page.evaluate((cardSelector) => {
    console.log(cardSelector)
    const results = [];
    const cards = document.querySelectorAll(cardSelector);
    console.log(cards.length)
    cards.forEach((card) => {
      // --- Titel ---
      const titleEl = card.querySelector('[class*="thumbTitle"]');
      const title = titleEl ? titleEl.innerText.trim() : null;

      // --- URL ---
      const linkEl = card.querySelector("a[href]");
      const url = linkEl ? linkEl.href : null;

      // --- Normale prijs ---
      const priceOriginalEl =
        card.querySelector(
          '.thumbPrice .strike-through'
        );

      let priceOriginal = priceOriginalEl ? parseFloat(priceOriginalEl.innerText.trim().replace('€', '')) : null;
        
      // --- Prijs nu
      const priceSpans = card.querySelectorAll('.thumbPrice span');
      const priceNowEl = priceSpans[priceSpans.length - 1];

      const priceNow = priceNowEl ? parseFloat(priceNowEl.innerText.trim().replace('€', '')) : null;

      if (isNaN(priceOriginal) || null === priceOriginal) priceOriginal = priceNow;

      // --- Extra korting / badge ---
      const discountEl = card.querySelector(
        '.product-label'
      );
      const discount = discountEl ? discountEl.innerText.trim() : null;

      // --- Product ID ---
      const productEl = card.closest('[data-product]');
      const id = productEl ? productEl.getAttribute('data-product') : null;

      console.log({ id, title, priceOriginal, priceNow, discount, url })
      if (title && title.toLowerCase().indexOf('b-stock') > -1) {
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

    // progear.be toont prijzen incl. BTW, wij slaan excl. BTW op
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

  await log(SUPPLIER, "Start van progear.js");

  let currentUrl = START_URL;
  let pageNum = 1;
  let totalFound = 0;
  let totalSaved = 0;
  const seen = new Set();

  // while (currentUrl) {
    console.log(`Pagina ${pageNum}: ${currentUrl}`);
    await page.goto(currentUrl, { waitUntil: "networkidle", timeout: 30000 });

    // Accept cookies - to be tested
    // if (pageNum === startPage) {
    //   await page.locator('#AcceptReload').click();
    // }

    try {
      await page.waitForSelector(
        '.hProductItems',
        { timeout: 15000 }
      );
    } catch (err) {
      console.log("  ⚠ Geen productkaarten gevonden op deze pagina.");
      await log(SUPPLIER, `Waarschuwing: geen productkaarten gevonden op pagina ${pageNum} (${currentUrl}), scrape gestopt.`);
      return;
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
    console.log(unique);
    const saved = await saveProducts(unique);
    totalSaved += saved;
    console.log(`  → ${products.length} producten gevonden, ${saved} opgeslagen (totaal opgeslagen: ${totalSaved})`);
    await log(SUPPLIER, `Pagina ${pageNum}: ${products.length} gevonden, ${saved} opgeslagen`);

    // const nextUrl = await getNextPageUrl(page);
    // currentUrl = nextUrl && nextUrl !== currentUrl ? nextUrl : null;
    // pageNum += 1;

    // if (currentUrl) {
    //   console.log("  ⏳ 30s wachten voor volgende pagina...");
    //   await sleep(30000);
    // }
  // }

  await browser.close();

  console.log(`\n✓ ${totalSaved} product(en) opgeslagen in de database (${totalFound} gevonden)`);
  await log(SUPPLIER, `Einde van progear.js: ${totalSaved} opgeslagen (${totalFound} gevonden)`);

  await pool.end();
}

scrape();
