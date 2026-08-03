/**
 * Scrapet tweedehands producten van secondhand.aedgroup.com en slaat ze op
 * in de database. De site levert een JSON-feed (Dynamicweb/Rapido) met
 * pagesize=10000 die in één keer alle producten teruggeeft (totalPages: 1),
 * dus geen paginatie of browser nodig — een gewone HTTP GET volstaat.
 *
 * Uitvoeren:
 *     node aedsecondhand.js
 */

const pool = require("./db");

const BASE_URL = "https://secondhand.aedgroup.com";
const FEED_URL = `${BASE_URL}/shop?pagesize=10000&feed=true&DoNotShowVariantsAsSingleProducts=True`;
const SUPPLIER = 5; // AED Second Hand

/** Zet een Euro-geformatteerd prijsgetal ("€ 1.234,56") om naar een float. */
function parsePrice(text) {
  if (!text) return null;
  const normalized = text.replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
  const value = parseFloat(normalized);
  return isNaN(value) ? null : value;
}

/** Haalt de volledige productfeed op en zet elk product om naar ons interne formaat. */
async function fetchProducts() {
  const response = await fetch(FEED_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`Feed-request mislukt: HTTP ${response.status}`);
  }

  const data = await response.json();
  const container = data[0] && data[0].ProductsContainer ? data[0].ProductsContainer : [];

  const results = [];
  for (const entry of container) {
    const p = entry.Product && entry.Product[0];
    if (!p) continue;

    const id = p.productId || null;
    const brand = p.brand ? p.brand.trim() : "";
    const name = p.name ? p.name.trim() : "";
    const title = [brand, name].filter(Boolean).join(" ").trim() || null;
    const url = p.link ? `${BASE_URL}${p.link}` : null;

    const priceNow = typeof p.priceDouble === "number" ? p.priceDouble : parsePrice(p.price);
    let priceOriginal = parsePrice(p.priceRRP);
    if (priceOriginal == null) priceOriginal = priceNow;

    const discount = p.discount && p.discount.trim() ? p.discount.trim() : null;

    if (id && title && url) {
      results.push({ id, title, priceOriginal, priceNow, discount, url });
    }
  }

  return results;
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

async function scrape() {
  console.log(`Feed: ${FEED_URL}`);
  const products = await fetchProducts();

  // Dedupliceren op url (of titel als fallback)
  const seen = new Set();
  const unique = [];
  for (const prod of products) {
    const key = prod.url || prod.title;
    if (key && !seen.has(key)) {
      seen.add(key);
      unique.push(prod);
    }
  }

  const saved = await saveProducts(unique);
  await pool.end();

  console.log(`\n✓ ${saved} product(en) opgeslagen in de database (${products.length} gevonden)`);
}

scrape().catch((err) => {
  console.error(err);
  process.exit(1);
});
