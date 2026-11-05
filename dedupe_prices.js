/**
 * Kuist bstock_product_price op: per listing en per dag blijft er van elk
 * prijspunt (priceNow + priceOriginal) maar één rij over. Verschillende
 * prijzen op dezelfde dag blijven dus allemaal bestaan.
 *
 * De laatste rij van elk prijspunt blijft behouden, zodat de laatste prijs
 * en het tijdstip waarop een listing laatst gezien werd (archive_products.js)
 * niet veranderen.
 *
 * Uitvoeren:
 *     node dedupe_prices.js
 *     node dedupe_prices.js --dry      (toont enkel hoeveel rijen er weg zouden gaan)
 */

const pool = require("./db");

const DRY = process.argv.includes("--dry");
const BATCH_SIZE = 5000;

async function dedupe() {
  const [rows] = await pool.query(`
    SELECT bpp.id
    FROM bstock_product_price bpp
    JOIN (
        SELECT bstock_product_id, DATE(created) AS day, priceNow, priceOriginal, MAX(id) AS keep_id
        FROM bstock_product_price
        GROUP BY bstock_product_id, DATE(created), priceNow, priceOriginal
    ) k ON k.bstock_product_id = bpp.bstock_product_id
       AND k.day = DATE(bpp.created)
       AND k.priceNow <=> bpp.priceNow
       AND k.priceOriginal <=> bpp.priceOriginal
    WHERE bpp.id < k.keep_id
  `);
  const ids = rows.map((r) => r.id);
  console.log(`${ids.length} dubbele prijspunten gevonden.`);

  if (DRY || ids.length === 0) {
    await pool.end();
    return;
  }

  let deleted = 0;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const [result] = await pool.query("DELETE FROM bstock_product_price WHERE id IN (?)", [
      ids.slice(i, i + BATCH_SIZE),
    ]);
    deleted += result.affectedRows;
    process.stdout.write(`\r${deleted}/${ids.length} verwijderd`);
  }
  console.log(`\n✓ ${deleted} dubbele prijspunten verwijderd.`);

  await pool.end();
}

dedupe().catch((err) => {
  console.error(err);
  process.exit(1);
});
