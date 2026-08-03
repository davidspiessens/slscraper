/**
 * Koppelt bstock_product.brand_id aan de juiste brand, op basis van
 * brand.first_word (het eerste woord na een eventueel B-stock-voorvoegsel
 * in de producttitel — titelopbouw verschilt per leverancier).
 *
 * Uitvoeren:
 *     node link_brands.js
 */

const pool = require("./db");

// Strip een optioneel B-stock-voorvoegsel in eender welke vorm:
// bax-shop: "(B-Stock) ", progear: "B-stock: ". Titels zonder voorvoegsel
// (bv. sommige progear-artikels) blijven ongewijzigd.
const BSTOCK_PREFIX_REGEX = /^\(?b-stock\)?:?\s*/i;
const FIRST_WORD_REGEX = /^(\S+)/;

function extractFirstWord(title) {
  const withoutPrefix = title.replace(BSTOCK_PREFIX_REGEX, "");
  const match = withoutPrefix.match(FIRST_WORD_REGEX);
  return match ? match[1] : null;
}

async function run() {
  const [brandRows] = await pool.query("SELECT id, first_word FROM brand ORDER BY id ASC");
  const [products] = await pool.query("SELECT id, title FROM bstock_product WHERE brand_id IS NULL");

  // Meerdere merken kunnen per ongeluk hetzelfde first_word hebben (bv. na een
  // handmatige rename van brand.name). Gebruik dan enkel het oudste merk-id,
  // anders "wint" een willekeurig merk de gekoppelde producten.
  const brandsByWord = new Map();
  for (const brand of brandRows) {
    const key = brand.first_word.toLowerCase();
    if (!brandsByWord.has(key)) {
      brandsByWord.set(key, brand);
    } else {
      console.warn(
        `  ⚠ Merk-id ${brand.id} heeft hetzelfde first_word "${brand.first_word}" als merk-id ${brandsByWord.get(key).id}. Merk-id ${brand.id} wordt overgeslagen — dubbele merken opruimen aanbevolen.`
      );
    }
  }
  const brands = [...brandsByWord.values()];

  console.log(`${brands.length} merk(en), ${products.length} product(en) gevonden.`);

  // Groepeer producten per (lowercase) eerste woord na een eventueel B-stock-voorvoegsel
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
    const key = brand.first_word.toLowerCase();
    const productIds = productIdsByWord.get(key) || [];
    if (productIds.length === 0) continue;

    const [result] = await pool.query(
      "UPDATE bstock_product SET brand_id = ? WHERE id IN (?)",
      [brand.id, productIds]
    );
    totalLinked += result.affectedRows;
    console.log(`  → "${brand.first_word}": ${result.affectedRows} product(en) gekoppeld.`);
  }

  console.log(`\n✓ ${totalLinked} product(en) gekoppeld aan een merk.`);

  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
