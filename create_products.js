/**
 * Maakt unieke producten aan in de tabel `product` op basis van bstock_product.
 * Unieke sleutel: brand_id + naam (titel zonder "(B-Stock)"-prefix).
 *
 * Uitvoeren:
 *     node create_products.js
 */

const pool = require("./db");

function cleanName(title) {
  return title
    .replace(/\(b-stock\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function getExistingProductKeys() {
  const [rows] = await pool.query("SELECT brand_id, name FROM product");
  return new Set(rows.map((row) => `${row.brand_id}::${row.name}`));
}

async function run() {
  const [rows] = await pool.query(
    "SELECT DISTINCT brand_id, title FROM bstock_product WHERE brand_id IS NOT NULL"
  );
  console.log(`${rows.length} unieke combinatie(s) van merk + titel gevonden.`);

  const existing = await getExistingProductKeys();
  const seen = new Set();
  const newProducts = [];

  for (const row of rows) {
    const name = cleanName(row.title);
    if (!name) continue;

    const key = `${row.brand_id}::${name}`;
    if (existing.has(key) || seen.has(key)) continue;

    seen.add(key);
    newProducts.push({ brandId: row.brand_id, name });
  }

  for (const product of newProducts) {
    await pool.query("INSERT INTO product (brand_id, name) VALUES (?, ?)", [
      product.brandId,
      product.name,
    ]);
  }

  console.log(`\n✓ ${newProducts.length} nieuw(e) product(en) opgeslagen in de database.`);

  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
