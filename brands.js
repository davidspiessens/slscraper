/**
 * Extraheert merknamen uit bstock_product.title (eerste woord na "(B-Stock)")
 * en slaat nieuwe, unieke merken op in de tabel `brand`.
 *
 * Uitvoeren:
 *     node brands.js
 */

const pool = require("./db");

const BRAND_REGEX = /\(B-Stock\)\s+(\S+)/i;

function extractBrand(title) {
  const match = title.match(BRAND_REGEX);
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
  const newBrands = new Set();
  let skipped = 0;

  for (const { title } of rows) {
    const brand = extractBrand(title);
    if (!brand) {
      skipped += 1;
      continue;
    }
    if (!existing.has(brand.toLowerCase())) {
      newBrands.add(brand);
    }
  }

  if (skipped > 0) {
    console.log(`  ⚠ ${skipped} titel(s) overgeslagen: geen merk gevonden na "(B-Stock)".`);
  }

  for (const brand of newBrands) {
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
