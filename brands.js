/**
 * Extraheert merknamen uit bstock_product.title (eerste woord, na een eventueel
 * "(B-Stock)" of "B-stock:" voorvoegsel — titelopbouw verschilt per leverancier)
 * en slaat nieuwe, unieke merken op in de tabel `brand`.
 *
 * Uitvoeren:
 *     node brands.js
 */

const pool = require("./db");

// Strip een optioneel B-stock-voorvoegsel in eender welke vorm:
// bax-shop: "(B-Stock) ", progear: "B-stock: ". Titels zonder voorvoegsel
// (bv. sommige progear-artikels) blijven ongewijzigd.
const BSTOCK_PREFIX_REGEX = /^\(?b-stock\)?:?\s*/i;
const FIRST_WORD_REGEX = /^(\S+)/;

function extractBrand(title) {
  const withoutPrefix = title.replace(BSTOCK_PREFIX_REGEX, "");
  const match = withoutPrefix.match(FIRST_WORD_REGEX);
  return match ? match[1] : null;
}

async function getExistingFirstWords() {
  const [rows] = await pool.query("SELECT first_word FROM brand");
  return new Set(rows.map((row) => row.first_word.toLowerCase()));
}

async function run() {
  const [rows] = await pool.query("SELECT DISTINCT title FROM bstock_product WHERE brand_id IS NULL");
  console.log(`${rows.length} unieke producttitels gevonden.`);

  // Vergelijk met first_word (niet name): name kan handmatig hernoemd zijn
  // (bv. "Pioneer" -> "Pioneer DJ"), first_word blijft het geëxtraheerde woord.
  const existing = await getExistingFirstWords();
  // Map i.p.v. Set: dedupliceren op lowercase key, want brand.name heeft een
  // case-insensitive unique index (anders botsen bv. "APEX" en "Apex" binnen
  // dezelfde run).
  const newBrands = new Map();
  let skipped = 0;

  for (const { title } of rows) {
    const brand = extractBrand(title);
    if (!brand) {
      skipped += 1;
      continue;
    }
    const key = brand.toLowerCase();
    if (!existing.has(key) && !newBrands.has(key)) {
      newBrands.set(key, brand);
    }
  }

  if (skipped > 0) {
    console.log(`  ⚠ ${skipped} titel(s) overgeslagen: geen merk gevonden.`);
  }

  for (const brand of newBrands.values()) {
    await pool.query("INSERT INTO brand (name, first_word) VALUES (?, ?)", [brand, brand]);
    existing.add(brand.toLowerCase());
  }

  console.log(`\n✓ ${newBrands.size} nieuw(e) merk(en) opgeslagen in de database.`);

  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
