/**
 * Schrijft monitoring-berichten naar de `log`-tabel: start van een script,
 * per paginascrape één bericht, en het einde van een script. supplierId mag
 * null zijn voor scripts die niet aan één leverancier gebonden zijn (bv.
 * brands.js, link_brands.js, link_products.js).
 */

const pool = require("./db");

async function log(supplierId, message) {
  try {
    await pool.query("INSERT INTO log (supplier_id, message) VALUES (?, ?)", [supplierId, message]);
  } catch (error) {
    // Een logfout mag een scrape-run nooit laten crashen.
    console.error("Kon logbericht niet opslaan:", error);
  }
}

module.exports = { log };
