/**
 * Zoekt reguliere (niet B-stock) producten bij bax-shop.be en slaat ze op
 * of vult ze aan in tabel `product`, met de bijhorende leveranciers-url
 * in `product_x_supplier` (supplier_id = 1 = bax-shop.be).
 *
 * Gebruik:
 *     node bax-new.js <keyword>
 * Voorbeeld:
 *     node bax-new.js pioneer
 */

const { chromium } = require("playwright");
const pool = require("./db");

const keyword = process.argv[2];
if (!keyword) {
  console.error("Gebruik: node bax-new.js <keyword>");
  console.error("Voorbeeld: node bax-new.js pioneer");
  process.exit(1);
}

const BASE_URL = "https://www.bax-shop.be";
const SEARCH_URL = `${BASE_URL}/nl/hele-assortiment?keyword=${encodeURIComponent(keyword)}`;
const SUPPLIER = 1; // bax-shop.be

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanName(title) {
  return title
    .replace(/\(b-stock\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Haal alle productkaarten op de huidige pagina op, via de data-product JSON. */
async function getProductsOnPage(page) {
  return page.evaluate(() => {
    const results = [];
    const cards = document.querySelectorAll(".result");

    cards.forEach((card) => {
      const dataEl = card.querySelector("[data-product]");
      if (!dataEl) return;

      let data;
      try {
        data = JSON.parse(dataEl.dataset.product);
      } catch (err) {
        return;
      }

      const linkEl = card.querySelector("a[href]");
      const url = linkEl ? linkEl.href : null;

      if (!data.name || !data.brand || !data.id || !url) return;
      if (data.name.toLowerCase().includes("(b-stock)")) return;

      results.push({
        name: data.name,
        brand: data.brand,
        supplierProductId: data.id,
        price: data.price,
        url,
      });
    });

    return results;
  });
}

/** Geeft de URL van de volgende pagina, of null als er geen is. */
async function getNextPageUrl(page) {
  const nextHref = await page.evaluate(() => {
    const btn = document.querySelector("a.next");
    return btn ? btn.getAttribute("href") : null;
  });

  if (nextHref) {
    return nextHref.startsWith("http") ? nextHref : BASE_URL + nextHref;
  }
  return null;
}

/** Zoekt brand_id op naam op, met caching. Geeft null als het merk niet bestaat. */
async function getBrandId(brandName, cache) {
  const key = brandName.toLowerCase();
  if (cache.has(key)) {
    return cache.get(key);
  }

  const [rows] = await pool.query("SELECT id FROM brand WHERE LOWER(name) = ? LIMIT 1", [key]);
  const brandId = rows.length > 0 ? rows[0].id : null;
  cache.set(key, brandId);
  return brandId;
}

/** Zoekt een bestaand product op (brand_id + naam), of maakt het aan. */
async function getOrCreateProductId(brandId, name) {
  const [rows] = await pool.query(
    "SELECT id FROM product WHERE brand_id = ? AND name = ? LIMIT 1",
    [brandId, name]
  );
  if (rows.length > 0) {
    return { id: rows[0].id, created: false };
  }

  const [result] = await pool.query("INSERT INTO product (brand_id, name) VALUES (?, ?)", [
    brandId,
    name,
  ]);
  return { id: result.insertId, created: true };
}

/** Slaat de leveranciers-url op in product_x_supplier, of werkt ze bij indien gewijzigd. */
async function upsertSupplierLink(productId, supplierProductId, url) {
  const [rows] = await pool.query(
    "SELECT id, supplier_product_id, url FROM product_x_supplier WHERE product_id = ? AND supplier_id = ? LIMIT 1",
    [productId, SUPPLIER]
  );

  if (rows.length === 0) {
    await pool.query(
      "INSERT INTO product_x_supplier (product_id, supplier_id, supplier_product_id, url) VALUES (?, ?, ?, ?)",
      [productId, SUPPLIER, supplierProductId, url]
    );
    return "created";
  }

  const existing = rows[0];
  if (existing.supplier_product_id !== supplierProductId || existing.url !== url) {
    await pool.query(
      "UPDATE product_x_supplier SET supplier_product_id = ?, url = ? WHERE id = ?",
      [supplierProductId, url, existing.id]
    );
    return "updated";
  }

  return "unchanged";
}

/** Slaat producten op in `product` en hun leveranciers-url in `product_x_supplier`. */
async function saveProducts(products, brandCache) {
  let productsCreated = 0;
  let linksCreated = 0;
  let linksUpdated = 0;
  let skippedUnknownBrand = 0;
  let failed = 0;

  for (const prod of products) {
    const brandId = await getBrandId(prod.brand, brandCache);
    if (!brandId) {
      skippedUnknownBrand += 1;
      continue;
    }

    try {
      const name = cleanName(prod.name);
      const { id: productId, created } = await getOrCreateProductId(brandId, name);
      if (created) productsCreated += 1;

      const linkResult = await upsertSupplierLink(productId, prod.supplierProductId, prod.url);
      if (linkResult === "created") linksCreated += 1;
      if (linkResult === "updated") linksUpdated += 1;
    } catch (error) {
      failed += 1;
      console.error(`  ⚠ Fout bij opslaan van "${prod.name}": ${error.message}`);
    }
  }

  if (skippedUnknownBrand > 0) {
    console.log(`  ⚠ ${skippedUnknownBrand} product(en) overgeslagen: onbekend merk.`);
  }
  if (failed > 0) {
    console.log(`  ⚠ ${failed} product(en) overgeslagen wegens een fout bij het wegschrijven.`);
  }

  return { productsCreated, linksCreated, linksUpdated };
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

  const brandCache = new Map();
  let currentUrl = SEARCH_URL;
  let pageNum = 1;
  let totalFound = 0;
  let totalProductsCreated = 0;
  let totalLinksCreated = 0;
  let totalLinksUpdated = 0;
  const seen = new Set();

  while (currentUrl) {
    console.log(`Pagina ${pageNum}: ${currentUrl}`);
    await page.goto(currentUrl, { waitUntil: "networkidle", timeout: 30000 });

    try {
      await page.waitForSelector(".result", { timeout: 15000 });
    } catch (err) {
      console.log("  ⚠ Geen productkaarten gevonden op deze pagina.");
      break;
    }

    const products = await getProductsOnPage(page);
    totalFound += products.length;

    // Dedupliceren op url, ook over pagina's heen
    const unique = [];
    for (const prod of products) {
      if (prod.url && !seen.has(prod.url)) {
        seen.add(prod.url);
        unique.push(prod);
      }
    }

    const { productsCreated, linksCreated, linksUpdated } = await saveProducts(
      unique,
      brandCache
    );
    totalProductsCreated += productsCreated;
    totalLinksCreated += linksCreated;
    totalLinksUpdated += linksUpdated;

    console.log(
      `  → ${products.length} producten gevonden, ${productsCreated} nieuw(e) product(en), ` +
        `${linksCreated} nieuwe link(s), ${linksUpdated} bijgewerkte link(s)`
    );

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

  console.log(
    `\n✓ ${totalFound} product(en) gevonden, ${totalProductsCreated} nieuw(e) product(en), ` +
      `${totalLinksCreated} nieuwe supplier-link(s), ${totalLinksUpdated} bijgewerkte supplier-link(s)`
  );
}

scrape();
