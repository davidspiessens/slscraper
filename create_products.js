/**
 * Maakt unieke producten aan in de tabel `product` op basis van bstock_product.
 * Unieke sleutel: brand_id + naam (titel zonder leverancier-specifieke
 * B-stock/second-hand markeringen). product.name bevat geen merknaam (die
 * komt uit de brand-koppeling, zie link_products.js/helpers.php).
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
// AED-feed dupliceert soms de merknaam (bv. "L-ACOUSTICS SPEAKER SYSTEM
// L- ACOUSTICS 5 XT" -> "L-ACOUSTICS 5 XT").
const LACOUSTICS_DUPLICATE_REGEX = /L-ACOUSTICS\s+SPEAKER\s+SYSTEM\s+L-\s?ACOUSTICS/gi;
// salesall: "Used | Merk | Model" of "B-Stock | Merk | Model" — enkel het
// modelgedeelte (na de tweede pipe) hoort in product.name.
const PIPE_TITLE_REGEX = /^(?:used|b-stock)\s*\|\s*[^|]+?\s*\|\s*(.+)$/i;

/** Strip het langst passende merkvoorvoegsel (zie link_products.js). */
function stripBrandPrefix(title, brandPrefixes) {
  for (const prefix of brandPrefixes) {
    if (!prefix) continue;
    const regex = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+`, "i");
    if (regex.test(title)) {
      return title.replace(regex, "");
    }
  }
  return title;
}

function cleanName(title, brandPrefixes) {
  const pipeMatch = title.match(PIPE_TITLE_REGEX);
  if (pipeMatch) {
    return pipeMatch[1]
      .replace(PAREN_REGEX, "")
      .replace(DASH_SUFFIX_REGEX, "")
      .replace(SECOND_HAND_SUFFIX_REGEX, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // B-stock-voorvoegsel eerst weg (bax "(B-Stock) Fazley ...") — anders
  // begint de titel niet letterlijk met de merknaam en mist de brand-strip.
  const withoutBstockPrefix = title.replace(BSTOCK_PREFIX_REGEX, "");
  const working = stripBrandPrefix(withoutBstockPrefix, brandPrefixes);

  return working
    .replace(PAREN_REGEX, "")
    .replace(DASH_SUFFIX_REGEX, "")
    .replace(SECOND_HAND_SUFFIX_REGEX, "")
    .replace(LACOUSTICS_DUPLICATE_REGEX, "L-ACOUSTICS")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normaliseert een naam enkel voor vergelijkingsdoeleinden: haakjes (en hun
 * inhoud) en koppeltekens worden genegeerd, zodat bv. "PLX1000" niet als
 * apart product wordt aangemaakt naast het bestaande "PLX-1000", en "VM-50
 * actieve DJ-monitor" niet naast "VM-50 actieve DJ-monitor (per stuk)" (waar
 * de haakjes wél bij de officiële naam horen). Zie ook link_products.js. */
function normalizeForMatching(name) {
  return name
    .toLowerCase()
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/-/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function getExistingProductKeys() {
  const [rows] = await pool.query("SELECT brand_id, name FROM product");
  return new Set(rows.map((row) => `${row.brand_id}::${normalizeForMatching(row.name)}`));
}

async function run() {
  const brandId = process.argv[2] ? parseInt(process.argv[2], 10) : null;
  if (process.argv[2] && (!Number.isInteger(brandId) || brandId < 1)) {
    console.error("Gebruik: node create_products.js [merk-id]");
    console.error("Merk-id moet een geheel getal groter dan of gelijk aan 1 zijn.");
    process.exit(1);
  }

  const [brands] = await pool.query("SELECT id, name, first_word FROM brand");
  const brandPrefixesById = new Map(
    brands.map((b) => {
      // Langste eerst, zie stripBrandPrefix.
      const prefixes = [...new Set([b.name, b.first_word])].sort((a, b2) => b2.length - a.length);
      return [b.id, prefixes];
    })
  );

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
    const name = cleanName(row.title, brandPrefixesById.get(row.brand_id) || []);
    if (!name) continue;

    const key = `${row.brand_id}::${normalizeForMatching(name)}`;
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
