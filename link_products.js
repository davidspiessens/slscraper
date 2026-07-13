/**
 * Koppelt bstock_product.product_id aan het juiste product, op basis van
 * brand_id + naam (titel zonder "(B-Stock)").
 *
 * Uitvoeren:
 *     node link_products.js
 */

const pool = require("./db");

function cleanName(title) {
  return title
    .replace(/\(b-stock\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function run() {
  const [products] = await pool.query("SELECT id, brand_id, name FROM product");
  const productIdByKey = new Map(products.map((p) => [`${p.brand_id}::${p.name}`, p.id]));

  const [bstockProducts] = await pool.query(
    "SELECT id, brand_id, title FROM bstock_product WHERE brand_id IS NOT NULL AND (product_id IS NULL OR product_id = 0)"
  );

  console.log(`${bstockProducts.length} bstock_product(en) zonder product_id gevonden.`);

  let linked = 0;
  let skipped = 0;

  for (const bp of bstockProducts) {
    const key = `${bp.brand_id}::${cleanName(bp.title)}`;
    const productId = productIdByKey.get(key);

    if (!productId) {
      skipped += 1;
      continue;
    }

    await pool.query("UPDATE bstock_product SET product_id = ? WHERE id = ?", [
      productId,
      bp.id,
    ]);
    linked += 1;
  }

  if (skipped > 0) {
    console.log(`  ⚠ ${skipped} bstock_product(en) overgeslagen: geen matchend product gevonden.`);
  }

  console.log(`\n✓ ${linked} bstock_product(en) gekoppeld aan een product.`);

  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
