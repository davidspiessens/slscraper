/**
 * Schrijft monitoring-berichten naar de `log`-tabel: start van een script,
 * per paginascrape één bericht, en het einde van een script. supplierId mag
 * null zijn voor scripts die niet aan één leverancier gebonden zijn (bv.
 * brands.js, link_brands.js, link_products.js).
 *
 * Elk bericht krijgt automatisch een run_id en scriptnaam mee, zodat alle
 * berichten van één run.sh-uitvoering (over alle scripts heen) achteraf
 * gegroepeerd kunnen worden voor een dashboard. run_id komt uit de RUN_ID
 * env var (door run.sh vóór alle scripts gezet); ontbreekt die (bv. bij
 * handmatig een los script draaien), dan genereert dit script er zelf één.
 *
 * status geeft de aard van het bericht aan: "start" | "info" | "warning" |
 * "success" | "error". Standaard "info" zodat bestaande log(...)-aanroepen
 * zonder wijziging blijven werken.
 */

const path = require("path");
const crypto = require("crypto");
const pool = require("./db");

const RUN_ID = process.env.RUN_ID || crypto.randomUUID();
const SCRIPT = path.basename(process.argv[1] || "unknown");

async function log(supplierId, message, status = "info") {
  try {
    await pool.query(
      "INSERT INTO log (run_id, script, status, supplier_id, message) VALUES (?, ?, ?, ?, ?)",
      [RUN_ID, SCRIPT, status, supplierId, message]
    );
  } catch (error) {
    // Een logfout mag een scrape-run nooit laten crashen.
    console.error("Kon logbericht niet opslaan:", error);
  }
}

module.exports = { log, RUN_ID, SCRIPT };
