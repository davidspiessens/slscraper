/**
 * Eenmalige opkuis van foutieve L-Acoustics titels/namen: de AED-feed levert
 * voor sommige producten een dubbele merknaam op, bv.
 * "L-ACOUSTICS SPEAKER SYSTEM L- ACOUSTICS 5 XT" (soms met, soms zonder
 * spatie na "L-"). Dit wordt vervangen door gewoon "L-ACOUSTICS".
 *
 * Werkt zowel bstock_product.title als product.name bij.
 *
 * Uitvoeren:
 *     node fix_lacoustics_titles.js
 */

const pool = require("../db");

const PATTERN = /L-ACOUSTICS\s+SPEAKER\s+SYSTEM\s+L-\s?ACOUSTICS/i;

function hasDuplicate(text) {
  return PATTERN.test(text);
}

function clean(text) {
  return text.replace(new RegExp(PATTERN.source, "gi"), "L-ACOUSTICS").replace(/\s+/g, " ").trim();
}

async function fixTable(table, column) {
  // Brede LIKE-prefilter (goedkoop, benut een index); de exacte regex-match
  // hieronder bepaalt welke rijen echt worden aangepast, zodat ongerelateerde
  // titels (bv. "FOSTEX SPEAKER SYSTEM ...") niet worden geraakt.
  const [rows] = await pool.query(
    `SELECT id, ${column} AS value FROM ${table} WHERE ${column} LIKE '%SPEAKER SYSTEM%'`
  );

  let updated = 0;
  for (const row of rows) {
    if (!hasDuplicate(row.value)) continue;

    const newValue = clean(row.value);
    if (newValue !== row.value) {
      await pool.query(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [newValue, row.id]);
      console.log(`  #${row.id}: "${row.value}" -> "${newValue}"`);
      updated += 1;
    }
  }

  console.log(`✓ ${updated} rij(en) bijgewerkt in ${table}.${column}.\n`);
}

async function run() {
  console.log("bstock_product.title:");
  await fixTable("bstock_product", "title");

  console.log("product.name:");
  await fixTable("product", "name");

  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
