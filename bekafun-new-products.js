/**
 * Zoekt bij Bekafun naar producten die we al kennen voor een bepaald merk
 * (tabel `product`) maar nog niet aan Bekafun gekoppeld zijn, via de
 * live-search preview endpoint. Bij een match wordt de link vastgelegd in
 * `product_x_supplier` (supplier_id = 2 = Bekafun).
 *
 * Gebruik:
 *     node bekafun_new_products.js <merknaam of merk-id>
 * Voorbeeld:
 *     node bekafun_new_products.js AlphaTheta
 */

const { chromium } = require("playwright");
const pool = require("./db");

const brandArg = process.argv[2];
if (!brandArg) {
  console.error("Gebruik: node bekafun_new_products.js <merknaam of merk-id>");
  console.error("Voorbeeld: node bekafun_new_products.js AlphaTheta");
  process.exit(1);
}

const SUPPLIER = 2; // Bekafun
const searchUrl = (term) => `https://www.bekafun.be/nl/shop/search/preview?term=${encodeURIComponent(term)}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalize(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isMatch(productName, candidateTitle) {
  const a = normalize(productName);
  const b = normalize(candidateTitle);
  return a === b || a.includes(b) || b.includes(a);
}

/** Zoekt merk op via id (numeriek argument) of naam. */
async function getBrand(arg) {
  if (/^\d+$/.test(arg)) {
    const [rows] = await pool.query("SELECT id, name FROM brand WHERE id = ?", [Number(arg)]);
    return rows[0] || null;
  }

  const [rows] = await pool.query("SELECT id, name FROM brand WHERE LOWER(name) = ? LIMIT 1", [
    arg.toLowerCase(),
  ]);
  return rows[0] || null;
}

/** Haalt de productkaarten uit de preview-resultaten op. */
async function getSearchResults(page, term) {
  await page.goto(searchUrl(term), { waitUntil: "domcontentloaded", timeout: 30000 });

  return page.evaluate(() => {
    const results = [];
    document.querySelectorAll(".product-card").forEach((card) => {
      const linkEl = card.querySelector("a.product[href]");
      const titleEl = card.querySelector(".title");
      const codeEl = card.querySelector(".article-code");
      if (!linkEl || !titleEl || !codeEl) return;

      results.push({
        title: titleEl.innerText.trim(),
        url: linkEl.href,
        supplierProductId: codeEl.innerText.trim(),
      });
    });
    return results;
  });
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
    await pool.query("UPDATE product_x_supplier SET supplier_product_id = ?, url = ? WHERE id = ?", [
      supplierProductId,
      url,
      existing.id,
    ]);
    return "updated";
  }

  return "unchanged";
}

async function run() {
  const brand = await getBrand(brandArg);
  if (!brand) {
    console.error(`Merk "${brandArg}" niet gevonden.`);
    await pool.end();
    process.exit(1);
  }

  const [products] = await pool.query(
    `SELECT p.id, p.name
     FROM product p
     WHERE p.brand_id = ? AND p.ignored = 0
       AND NOT EXISTS (
           SELECT 1 FROM product_x_supplier ps
           WHERE ps.product_id = p.id AND ps.supplier_id = ?
       )
     ORDER BY p.name ASC`,
    [brand.id, SUPPLIER]
  );

  console.log(`${products.length} nieuw(e) product(en) te doorzoeken voor merk "${brand.name}".`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/124.0.0.0 Safari/537.36",
    locale: "nl-BE",
  });
  const page = await context.newPage();

  let linksCreated = 0;
  let noMatch = 0;

  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    console.log(`[${i + 1}/${products.length}] "${product.name}"`);

    let results = [];
    try {
      results = await getSearchResults(page, product.name);
    } catch (err) {
      console.error(`  ⚠ Fout bij ophalen resultaten: ${err.message}`);
    }

    const match = results.find((r) => r.supplierProductId && isMatch(product.name, r.title));

    if (match) {
      const result = await upsertSupplierLink(product.id, match.supplierProductId, match.url);
      console.log(`  → match: "${match.title}" (${result})`);
      if (result === "created") linksCreated += 1;
    } else {
      noMatch += 1;
      console.log("  → geen match gevonden.");
    }

    if (i < products.length - 1) {
      console.log("  ⏳ 30s wachten voor volgend product...");
      await sleep(30000);
    }
  }

  await browser.close();
  await pool.end();

  console.log(`\n✓ ${linksCreated} nieuwe supplier-link(s), ${noMatch} product(en) zonder match.`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
