/**
 * Koppelt bstock_product.product_id aan het juiste product, op basis van
 * brand_id + naam (titel zonder "(B-Stock)"). De bstock-titel mag langer
 * zijn dan de productnaam (bv. met extra omschrijving erachter) - in dat
 * geval wordt de langst matchende productnaam gebruikt die de titel als
 * prefix heeft, op een woordgrens.
 *
 * Uitvoeren:
 *     node link_products.js
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

/** Zoekt het product waarvan de naam een prefix is van `name`, op een woordgrens. */
function findPrefixMatch(name, candidates) {
  const nameLower = name.toLowerCase();

  return candidates.find((p) => {
    const prefix = p.name.toLowerCase();
    if (!nameLower.startsWith(prefix)) return false;
    const nextChar = nameLower[prefix.length];
    return nextChar === undefined || /\s/.test(nextChar);
  });
}

async function run() {
  const [products] = await pool.query("SELECT id, brand_id, name FROM product");
  const productIdByKey = new Map(products.map((p) => [`${p.brand_id}::${p.name}`, p.id]));

  // Per merk gesorteerd op naam-lengte (langste eerst), zodat een specifiekere
  // productnaam voorrang krijgt op een kortere die toevallig ook een prefix is.
  const productsByBrand = new Map();
  for (const p of products) {
    if (!productsByBrand.has(p.brand_id)) {
      productsByBrand.set(p.brand_id, []);
    }
    productsByBrand.get(p.brand_id).push(p);
  }
  for (const candidates of productsByBrand.values()) {
    candidates.sort((a, b) => b.name.length - a.name.length);
  }

  const [bstockProducts] = await pool.query(
    "SELECT id, brand_id, title FROM bstock_product WHERE brand_id IS NOT NULL AND (product_id IS NULL OR product_id = 0)"
  );

  console.log(`${bstockProducts.length} bstock_product(en) zonder product_id gevonden.`);

  let linked = 0;
  let skipped = 0;

  for (const bp of bstockProducts) {
    const name = cleanName(bp.title);
    const key = `${bp.brand_id}::${name}`;

    let productId = productIdByKey.get(key);

    if (!productId) {
      const match = findPrefixMatch(name, productsByBrand.get(bp.brand_id) || []);
      if (match) productId = match.id;
    }

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
