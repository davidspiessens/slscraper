/**
 * Koppelt bstock_product.brand_id aan de juiste brand, op basis van
 * brand.first_word (het eerste woord na een eventueel B-stock-voorvoegsel
 * in de producttitel — titelopbouw verschilt per leverancier).
 *
 * Uitvoeren:
 *     node link_brands.js
 */

const pool = require("./db");
const { log } = require("./logger");
const { stripQuantityPrefix } = require("./quantity");
const { loadAliases, matchAliasExact, matchAliasPrefix } = require("./brandAlias");

// Strip een optioneel B-stock-voorvoegsel in eender welke vorm:
// bax-shop: "(B-Stock) ", progear: "B-stock: ". Titels zonder voorvoegsel
// (bv. sommige progear-artikels) blijven ongewijzigd.
const BSTOCK_PREFIX_REGEX = /^\(?b-stock\)?:?\s*/i;
// Zie brands.js: sommige titels laten het eerste woord op een leesteken
// eindigen (bv. kinxsound "AD-SYSTEMS: ...", "DYNACORD: ..."), dat hoort niet
// bij de merknaam.
const TRAILING_PUNCTUATION_REGEX = /[:,.]+$/;
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

// Alternatieve schrijfwijzen en meerwoord-voorvoegsels ("GrandMA" -> MA Lighting,
// "Martin Audio" i.p.v. Martin Professional, "L’Acoustics" -> L-Acoustics, ...)
// staan in de tabel brand_alias, zie brandAlias.js.

/** Geeft { aliasBrandId, word }: een alias-treffer (brand-id) of het eerste woord / pipe-merk. */
function extractFirstWord(title, aliases) {
  const pipeMatch = title.match(PIPE_BRAND_REGEX);
  if (pipeMatch) {
    const word = pipeMatch[1].trim();
    return { aliasBrandId: matchAliasExact(word, aliases), word };
  }
  if (PIPE_NO_BRAND_REGEX.test(title)) {
    return { aliasBrandId: null, word: null };
  }

  const withoutPrefix = stripQuantityPrefix(title.replace(BSTOCK_PREFIX_REGEX, ""));

  const prefixHit = matchAliasPrefix(withoutPrefix, aliases);
  if (prefixHit) {
    return { aliasBrandId: prefixHit, word: null };
  }

  const match = withoutPrefix.match(FIRST_WORD_REGEX);
  const word = match ? match[1].replace(TRAILING_PUNCTUATION_REGEX, "") : null;
  return { aliasBrandId: word ? matchAliasExact(word, aliases) : null, word };
}

async function run() {
  await log(null, "Start van link_brands.js", "start");

  const [brandRows] = await pool.query("SELECT id, name, first_word FROM brand ORDER BY id ASC");
  const [products] = await pool.query("SELECT id, title FROM bstock_product WHERE brand_id IS NULL");
  const aliases = await loadAliases(pool);

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
  // Producten waarvan een alias het merk al ondubbelzinnig vastlegt.
  const productIdsByAliasBrand = new Map();
  for (const product of products) {
    const { aliasBrandId, word } = extractFirstWord(product.title, aliases);
    if (aliasBrandId) {
      if (!productIdsByAliasBrand.has(aliasBrandId)) {
        productIdsByAliasBrand.set(aliasBrandId, []);
      }
      productIdsByAliasBrand.get(aliasBrandId).push(product.id);
      continue;
    }
    if (!word) continue;
    const key = word.toLowerCase();
    if (!productIdsByWord.has(key)) {
      productIdsByWord.set(key, []);
    }
    productIdsByWord.get(key).push(product.id);
  }

  // Zie brands.js: als de kandidaat geen exacte match heeft, kan het toch een
  // voorvoegsel zijn van een reeds bestaand, langer merk (bv. kandidaat
  // "Austrian" terwijl het merk inmiddels "Austrian Audio" heet). Zonder deze
  // fallback blijft zo'n product simpelweg ongekoppeld liggen.
  function findBrandByPrefix(key) {
    const matches = brands.filter(
      (brand) =>
        brand.first_word.toLowerCase().startsWith(`${key} `) ||
        brand.name.toLowerCase().startsWith(`${key} `)
    );
    // Bij meerdere mogelijke matches is het te onzeker om er automatisch één
    // te kiezen — dan liever ongekoppeld laten dan fout koppelen.
    return matches.length === 1 ? matches[0] : null;
  }

  let totalLinked = 0;

  const brandNameById = new Map(brandRows.map((b) => [b.id, b.name]));
  for (const [brandId, productIds] of productIdsByAliasBrand) {
    const [result] = await pool.query(
      "UPDATE bstock_product SET brand_id = ? WHERE id IN (?)",
      [brandId, productIds]
    );
    totalLinked += result.affectedRows;
    console.log(`  → "${brandNameById.get(brandId)}" (alias): ${result.affectedRows} product(en) gekoppeld.`);
  }

  for (const [key, productIds] of productIdsByWord) {
    const brand = brandsByWord.get(key) || brandsByName.get(key) || findBrandByPrefix(key);
    if (!brand || productIds.length === 0) continue;

    const [result] = await pool.query(
      "UPDATE bstock_product SET brand_id = ? WHERE id IN (?)",
      [brand.id, productIds]
    );
    totalLinked += result.affectedRows;
    console.log(`  → "${brand.name}": ${result.affectedRows} product(en) gekoppeld.`);
  }

  console.log(`\n✓ ${totalLinked} product(en) gekoppeld aan een merk.`);
  await log(null, `Einde van link_brands.js: ${totalLinked} product(en) gekoppeld`, "success");

  await pool.end();
}

run().catch(async (err) => {
  console.error(err);
  await log(null, `Fout in link_brands.js: ${err.message}`, "error");
  process.exit(1);
});
