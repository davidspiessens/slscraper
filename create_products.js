/**
 * Maakt unieke producten aan in de tabel `product` op basis van bstock_product.
 * Unieke sleutel: brand_id + naam (titel zonder leverancier-specifieke
 * B-stock/second-hand markeringen).
 *
 * Uitvoeren:
 *     node create_products.js [merk-id]
 */

const pool = require("./db");

// Voorvoegsel: bax "(B-Stock) ", progear "B-stock: ". Titels zonder
// voorvoegsel (xlrpro, aedsecondhand, soundsale) blijven ongewijzigd.
const BSTOCK_PREFIX_REGEX = /^\(?b-stock\)?:?\s*/i;
// Achtervoegsel: xlrpro "... - [SECOND-HAND]" of "... [SECOND-HAND]".
const SECOND_HAND_SUFFIX_REGEX = /\s*-?\s*\[second-hand\]\s*$/i;
// Tekst tussen haakjes, overal in de titel (bv. "(8)", "(EXTRA LARGE)").
const PAREN_REGEX = /\s*\([^)]*\)/g;
// Tekst na een liggend streepje omringd door spaties (bv. "12XT – set of 2").
const DASH_SUFFIX_REGEX = /\s+[-–—]\s+.*$/;

function cleanName(title) {
  return title
    .replace(BSTOCK_PREFIX_REGEX, "")
    .replace(PAREN_REGEX, "")
    .replace(DASH_SUFFIX_REGEX, "")
    .replace(SECOND_HAND_SUFFIX_REGEX, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function getExistingProductKeys() {
  const [rows] = await pool.query("SELECT brand_id, name FROM product");
  return new Set(rows.map((row) => `${row.brand_id}::${row.name}`));
}

async function run() {
  const brandId = process.argv[2] ? parseInt(process.argv[2], 10) : null;
  if (process.argv[2] && (!Number.isInteger(brandId) || brandId < 1)) {
    console.error("Gebruik: node create_products.js [merk-id]");
    console.error("Merk-id moet een geheel getal groter dan of gelijk aan 1 zijn.");
    process.exit(1);
  }

  const query = brandId
    ? "SELECT DISTINCT brand_id, title FROM bstock_product WHERE brand_id = ?"
    : "SELECT DISTINCT brand_id, title FROM bstock_product WHERE brand_id IS NOT NULL";
  const params = brandId ? [brandId] : [];

  const [rows] = await pool.query(query, params);
  console.log(
    brandId
      ? `${rows.length} unieke combinatie(s) van merk + titel gevonden voor merk-id ${brandId}.`
      : `${rows.length} unieke combinatie(s) van merk + titel gevonden.`
  );

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
