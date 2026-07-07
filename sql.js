/**
 * Kopieert brand.name naar brand.first_word voor alle rijen.
 *
 * Uitvoeren:
 *     node copy_first_word.js
 */

const pool = require("./db");

async function run() {
  const [result] = await pool.query("UPDATE brand SET first_word = name where length(first_word) = 0");
  console.log(`✓ ${result.affectedRows} rij(en) bijgewerkt.`);
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
