/**
 * Archiveert producten van één leverancier waarvan de meest recente prijs
 * ouder is dan 3 uur (of die nog nooit een prijs hebben gekregen).
 *
 * Uitvoeren:
 *     node archive_products.js <supplier_id>
 */

const pool = require("./db");
const { log } = require("./logger");

const supplierId = process.argv[2] ? parseInt(process.argv[2], 10) : NaN;
if (!Number.isInteger(supplierId) || supplierId < 1) {
  console.error("Gebruik: node archive_products.js <supplier_id>");
  console.error("supplier_id moet een geheel getal groter dan of gelijk aan 1 zijn.");
  process.exit(1);
}

async function archive() {
  await log(supplierId, "Start van archive_products.js");

  await pool.query(`UPDATE bstock_product SET archived = FALSE WHERE supplier_id = ?`, [
    supplierId,
  ]);

  const [result] = await pool.query(
    `
    UPDATE bstock_product p
    LEFT JOIN (
        SELECT bstock_product_id, MAX(created) AS last_created
        FROM bstock_product_price
        GROUP BY bstock_product_id
    ) lp ON lp.bstock_product_id = p.id
    SET p.archived = 1
    WHERE p.supplier_id = ?
      AND p.archived = 0
      AND (lp.last_created IS NULL OR lp.last_created < (NOW() - INTERVAL 3 HOUR))
    `,
    [supplierId]
  );

  console.log(`✓ ${result.affectedRows} product(en) van leverancier ${supplierId} gearchiveerd.`);
  await log(supplierId, `Einde van archive_products.js: ${result.affectedRows} gearchiveerd`);

  await pool.end();
}

archive().catch((err) => {
  console.error(err);
  process.exit(1);
});
