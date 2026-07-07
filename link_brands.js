/**
 * Koppelt bstock_product.brand_id aan de juiste brand, op basis van
 * brand.first_word (het eerste woord na "(B-Stock)" in de producttitel).
 *
 * Uitvoeren:
 *     node link_brands.js
 */

const pool = require("./db");

const BRAND_REGEX = /\(B-Stock\)\s+(\S+)/i;

function extractFirstWord(title) {
  const match = title.match(BRAND_REGEX);
  return match ? match[1] : null;
}

async function run() {
  const [brands] = await pool.query("SELECT id, name FROM brand");
  const [products] = await pool.query("SELECT id, title FROM bstock_product");

  console.log(`${brands.length} merk(en), ${products.length} product(en) gevonden.`);

  // Groepeer producten per (lowercase) eerste woord na "(B-Stock)"
  const productIdsByWord = new Map();
  for (const product of products) {
    const word = extractFirstWord(product.title);
    if (!word) continue;
    const key = word.toLowerCase();
    if (!productIdsByWord.has(key)) {
      productIdsByWord.set(key, []);
    }
    productIdsByWord.get(key).push(product.id);
  }

  let totalLinked = 0;

  for (const brand of brands) {
    const key = brand.name.toLowerCase();
    const productIds = productIdsByWord.get(key) || [];
    if (productIds.length === 0) continue;

    const [result] = await pool.query(
      "UPDATE bstock_product SET brand_id = ? WHERE id IN (?)",
      [brand.id, productIds]
    );
    totalLinked += result.affectedRows;
    console.log(`  → "${brand.name}": ${result.affectedRows} product(en) gekoppeld.`);
  }

  console.log(`\n✓ ${totalLinked} product(en) gekoppeld aan een merk.`);

  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
