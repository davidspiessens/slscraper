const { chromium } = require("playwright");
const pool = require("./db");
const { log } = require("./logger");

const startPage = process.argv[2] ? parseInt(process.argv[2], 10) : 1;
if (!Number.isInteger(startPage) || startPage < 1) {
  console.error("Gebruik: node xlrpro.js [startpagina]");
  console.error("Startpagina moet een geheel getal groter dan of gelijk aan 1 zijn.");
  process.exit(1);
}

const BASE_URL = "https://www.xlrpro.eu";
const QUERY = "search=second+hand&order=name+asc";
const SEARCH_URL = `${BASE_URL}/shop?${QUERY}`;
const START_URL = startPage > 1 ? `${BASE_URL}/shop/page/${startPage}?${QUERY}` : SEARCH_URL;
const SUPPLIER = 4; // XLR Pro

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// xlrpro.eu (Odoo) toonde productkaarten vroeger als <td class="oe_product">
// (tabel-layout); sinds ~18/08/2026 is dit een CSS-grid layout geworden met
// <div class="oe_product ...">. Enkel op de class matchen i.p.v. het
// element-type, zodat een volgende gelijkaardige layoutwissel niet opnieuw
// alles stilzwijgend laat missen.
const PRODUCT_CARD_SELECTOR = ".oe_product";

/** Haal alle productkaarten op de huidige pagina op. */
async function getProductsOnPage(page) {
  return page.evaluate((cardSelector) => {
    // Zet een Belgisch/Odoo-geformatteerd prijsgetal ("4.900,00") om naar een float.
    // Moet binnen evaluate() gedefinieerd zijn: dit draait in de browsercontext,
    // die geen toegang heeft tot buiten evaluate() gedefinieerde Node.js-functies.
    function parseOdooPrice(text) {
      if (!text) return null;
      const normalized = text.replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
      const value = parseFloat(normalized);
      return isNaN(value) ? null : value;
    }

    const results = [];
    const cards = document.querySelectorAll(cardSelector);

    cards.forEach((card) => {
      // --- Titel: merk + naam staan als aparte <span>'s in de titel-link ---
      // (was h6...[itemprop="name"], sinds de layoutwissel gewoon h2 zonder
      // itemprop — enkel op de class matchen, niet op het element-type.)
      // textContent i.p.v. innerText: op de nieuwe CSS-grid layout geeft
      // innerText afhankelijk van het (nog niet volledig afgeronde) render-/
      // layout-moment soms leeg terug voor sommige kaarten (getest: zowel
      // meteen na waitForSelector als na scrollen faalden telkens andere
      // kaarten) — textContent hangt niet af van layout/rendering en gaf in
      // dezelfde test steevast alle 20/20 kaarten correct terug.
      const titleLink = card.querySelector('.o_wsale_products_item_title a');
      const spans = titleLink ? titleLink.querySelectorAll("span") : [];
      const brand = spans[0] ? spans[0].textContent.trim() : null;
      const name = spans[1] ? spans[1].textContent.trim() : null;
      const title = brand && name ? `${brand} ${name}` : name || brand;

      // --- URL ---
      const url = titleLink ? titleLink.href : null;

      // --- Product ID: stabiel data-attribuut, geen URL-parsing nodig ---
      const idEl = card.querySelector("[data-product-template-id]");
      const id = idEl ? idEl.getAttribute("data-product-template-id") : null;

      // --- Prijs nu: was itemprop="price" met schone waarde ("290.0"), sinds
      // de layoutwissel enkel nog .product_price .oe_currency_value met een
      // Belgisch-geformatteerd getal ("290,00") — vandaar parseOdooPrice(). ---
      const priceNowEl = card.querySelector(".product_price .oe_currency_value");
      const priceNow = priceNowEl ? parseOdooPrice(priceNowEl.textContent) : null;

      // --- Normale prijs: enkel aanwezig bij korting, in <del> binnen dezelfde .product_price ---
      const priceOriginalEl = card.querySelector(".product_price del .oe_currency_value");
      let priceOriginal = priceOriginalEl ? parseOdooPrice(priceOriginalEl.textContent) : null;
      if (priceOriginal == null || isNaN(priceOriginal)) priceOriginal = priceNow;

      // --- Status/badge (bv. "Sold out"/"Deal") — was .o_ribbon, sinds de
      // layoutwissel .o_ribbons (meervoud) ---
      const ribbonEl = card.querySelector(".o_ribbons");
      const discount = ribbonEl ? ribbonEl.textContent.trim() || null : null;

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

/**
 * Controleert of er een volgende pagina is. De site's eigen paginalinks laten
 * "tags=36" en "tags=40" vallen (enkel "tags=8" blijft over), dus we bouwen de
 * volgende URL zelf op met de volledige QUERY i.p.v. de href van de site te volgen.
 */
async function hasNextPage(page) {
  return page.evaluate(() => {
    const active = document.querySelector(".products_pager li.page-item.active");
    if (!active) return false;
    const next = active.nextElementSibling;
    return !!next && !next.classList.contains("disabled");
  });
}

async function scrape() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" +
      "AppleWebKit/537.36 (KHTML, like Gecko)" +
      "Chrome/150.0.0.0 Safari/537.36",
    locale: "nl-BE",
  });
  const page = await context.newPage();

  await log(SUPPLIER, "Start van xlrpro.js", "start");

  let currentUrl = START_URL;
  let pageNum = startPage;
  let totalFound = 0;
  let totalSaved = 0;
  const seen = new Set();

  while (currentUrl) {
    console.log(`Pagina ${pageNum}: ${currentUrl}`);
    // "networkidle" timet hier structureel uit: xlrpro.eu (Odoo) heeft
    // blijvende achtergrond-netwerkactiviteit (bv. livechat/polling) die nooit
    // stil valt, ook al is de pagina zelf al lang klaar. "domcontentloaded"
    // volstaat, gecombineerd met de expliciete waitForSelector hieronder.
    await page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    try {
      await page.waitForSelector(PRODUCT_CARD_SELECTOR, { timeout: 15000 });
    } catch (err) {
      console.log("  ⚠ Geen productkaarten gevonden op deze pagina.");
      await log(SUPPLIER, `Waarschuwing: geen productkaarten gevonden op pagina ${pageNum} (${currentUrl}), scrape gestopt.`, "warning");
      break;
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
    await log(SUPPLIER, `Pagina ${pageNum}: ${products.length} gevonden, ${saved} opgeslagen`);

    const hasNext = await hasNextPage(page);
    pageNum += 1;
    currentUrl = hasNext ? `${BASE_URL}/shop/page/${pageNum}?${QUERY}` : null;

    if (currentUrl) {
      console.log("  ⏳ 30s wachten voor volgende pagina...");
      await sleep(30000);
    }
  }

  await browser.close();

  console.log(`\n✓ ${totalSaved} product(en) opgeslagen in de database (${totalFound} gevonden)`);
  await log(SUPPLIER, `Einde van xlrpro.js: ${totalSaved} opgeslagen (${totalFound} gevonden)`, "success");

  await pool.end();
}

scrape().catch(async (err) => {
  console.error(err);
  await log(SUPPLIER, `Fout in xlrpro.js: ${err.message}`, "error");
  process.exit(1);
});
