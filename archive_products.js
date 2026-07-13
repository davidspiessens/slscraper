/**
 * Archiveert producten waarvan de meest recente prijs ouder is dan 6 uur
 * (of die nog nooit een prijs hebben gekregen).
 *
 * Uitvoeren:
 *     node archive_products.js
 */

const pool = require("./db");

async function run() {
  const [result] = await pool.query(`
    UPDATE bstock_product p
    LEFT JOIN (
        SELECT bstock_product_id, MAX(created) AS last_created
        FROM bstock_product_price
        GROUP BY bstock_product_id
    ) lp ON lp.bstock_product_id = p.id
    SET p.archived = 1
    WHERE p.archived = 0
      AND (lp.last_created IS NULL OR lp.last_created < (NOW() - INTERVAL 3 HOUR))
  `);

  console.log(`✓ ${result.affectedRows} product(en) gearchiveerd.`);

  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
