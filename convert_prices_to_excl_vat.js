/**
 * Eenmalige migratie: zet bestaande prijzen van bax, bekafun en progear
 * (die incl. BTW werden opgeslagen) om naar excl. BTW door te delen door 1,21.
 * aed en xlrpro leverden al excl. BTW en blijven ongewijzigd.
 *
 * Uitvoeren:
 *     node convert_prices_to_excl_vat.js
 */

const pool = require("./db");

const VAT_SUPPLIERS = [1, 2, 3]; // Bax, Bekafun, ProGear
const VAT_RATE = 1.21;

async function run() {
  const [result] = await pool.query(
    `
    UPDATE bstock_product_price bpp
    JOIN bstock_product bp ON bp.id = bpp.bstock_product_id
    SET bpp.priceOriginal = ROUND(bpp.priceOriginal / ?, 2),
        bpp.priceNow = ROUND(bpp.priceNow / ?, 2)
    WHERE bp.supplier_id IN (?)
    `,
    [VAT_RATE, VAT_RATE, VAT_SUPPLIERS]
  );

  console.log(`✓ ${result.affectedRows} prijsrij(en) omgezet van incl. naar excl. BTW.`);

  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
