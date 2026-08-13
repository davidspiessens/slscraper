/**
 * Archiveert xlrpro-producten (supplier_id 4) die volgens hun meest recente
 * scrape "Sold out" zijn, maar toch nog op de website blijven staan.
 *
 * Uitvoeren:
 *     node archive_soldout_xlrpro.js
 */

const pool = require("./db");
const { log } = require("./logger");

const SUPPLIER = 4; // XLR Pro

async function run() {
  await log(SUPPLIER, "Start van archive_soldout_xlrpro.js", "start");

  const [result] = await pool.query(
    `
    UPDATE bstock_product bp
    JOIN (
        SELECT bpp.bstock_product_id, bpp.discount_label
        FROM bstock_product_price bpp
        INNER JOIN (
            SELECT bstock_product_id, MAX(id) AS max_id
            FROM bstock_product_price
            GROUP BY bstock_product_id
        ) m ON m.max_id = bpp.id
    ) lp ON lp.bstock_product_id = bp.id
    SET bp.archived = 1
    WHERE bp.supplier_id = ?
      AND bp.archived = 0
      AND lp.discount_label = 'Sold out'
    `,
    [SUPPLIER]
  );

  console.log(`✓ ${result.affectedRows} uitverkocht(e) xlrpro-product(en) gearchiveerd.`);
  await log(SUPPLIER, `Einde van archive_soldout_xlrpro.js: ${result.affectedRows} gearchiveerd`, "success");

  await pool.end();
}

run().catch(async (err) => {
  console.error(err);
  await log(SUPPLIER, `Fout in archive_soldout_xlrpro.js: ${err.message}`, "error");
  process.exit(1);
});
