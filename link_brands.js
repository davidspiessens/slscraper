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
// salesall: "Used | Merk | Model" of "B-Stock | Merk | Model" — het merk staat
// tussen de eerste twee pipes en kan uit meerdere woorden bestaan
// (bv. "Lab Gruppen", "Clay Paky"), dus niet enkel het eerste woord nemen.
const PIPE_BRAND_REGEX = /^(?:used|b-stock)\s*\|\s*([^|]+?)\s*\|/i;
// salesall heeft ook titels zonder apart merk-segment (generieke accessoires
// zoals kabels/flightcases, bv. "Used | Floodlight 1000W HQI Symmetric") —
// zonder tweede pipe is er geen betrouwbaar merk, dus overslaan i.p.v. "Used"
// zelf als merk te nemen.
const PIPE_NO_BRAND_REGEX = /^(?:used|b-stock)\s*\|/i;

// Zie brands.js: sub-merken/productlijnen die feitelijk hetzelfde bedrijf zijn
// als een bestaand merk (bv. "GrandMA" -> "MA Lighting") moeten aan dat
// bestaande merk gekoppeld worden i.p.v. te matchen op hun eigen eerste woord.
const BRAND_ALIASES = {
  grandma: "ma lighting",
};

function extractFirstWord(title) {
  const pipeMatch = title.match(PIPE_BRAND_REGEX);
  if (pipeMatch) {
    return pipeMatch[1].trim();
  }
  if (PIPE_NO_BRAND_REGEX.test(title)) {
    return null;
  }

  const withoutPrefix = title.replace(BSTOCK_PREFIX_REGEX, "");
  const match = withoutPrefix.match(FIRST_WORD_REGEX);
  return match ? match[1] : null;
}

async function run() {
  const [brandRows] = await pool.query("SELECT id, name, first_word FROM brand ORDER BY id ASC");
  const [products] = await pool.query("SELECT id, title FROM bstock_product WHERE brand_id IS NULL");

  // Meerdere merken kunnen per ongeluk hetzelfde first_word hebben (bv. na een
  // handmatige rename van brand.name). Gebruik dan enkel het oudste merk-id,
  // anders "wint" een willekeurig merk de gekoppelde producten.
  const brandsByWord = new Map();
  // Secundaire index op brand.name: de pipe-extractie (salesall) levert de
  // volledige merknaam op, die kan overeenkomen met een merk waarvan de name
  // handmatig hernoemd is (first_word wijkt dan af, bv. first_word "Lab" maar
  // name "Lab Gruppen"). Gebruikt als fallback wanneer first_word niet matcht.
  const brandsByName = new Map();
  for (const brand of brandRows) {
    const wordKey = brand.first_word.toLowerCase();
    if (!brandsByWord.has(wordKey)) {
      brandsByWord.set(wordKey, brand);
    } else {
      console.warn(
        `  ⚠ Merk-id ${brand.id} heeft hetzelfde first_word "${brand.first_word}" als merk-id ${brandsByWord.get(wordKey).id}. Merk-id ${brand.id} wordt overgeslagen — dubbele merken opruimen aanbevolen.`
      );
    }
    brandsByName.set(brand.name.toLowerCase(), brand);
  }
  const brands = [...brandsByWord.values()];

  console.log(`${brands.length} merk(en), ${products.length} product(en) gevonden.`);

  // Groepeer producten per (lowercase) eerste woord/merknaam na een eventueel
  // B-stock-voorvoegsel
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

  for (const [key, productIds] of productIdsByWord) {
    const resolvedKey = BRAND_ALIASES[key] || key;
    const brand = brandsByWord.get(resolvedKey) || brandsByName.get(resolvedKey);
    if (!brand || productIds.length === 0) continue;

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
