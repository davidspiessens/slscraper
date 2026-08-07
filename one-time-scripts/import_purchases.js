/**
 * Eenmalige import van een lijst aankopen (aangeleverd door de gebruiker)
 * in de tabel `purchase`. Merken/producten/leveranciers worden hergebruikt
 * indien ze al bestaan; ontbrekende leveranciers en het ontbrekende product
 * "Pioneer DJ RMX-1000" worden aangemaakt.
 *
 * "Bax-shop.be" wordt gemapt op de bestaande leverancier "Bax" (id 1).
 *
 * Uitvoeren:
 *     node import_purchases.js
 */

const pool = require("../db");

// productName is de exacte, canonieke naam in de tabel `product` (globaal
// uniek). brand is enkel gebruikt om het merk te loggen/aan te maken indien
// nodig (product.brand_id is al gekend via het bestaande product).
const PURCHASES = [
  { brand: "AlphaTheta", productName: "AlphaTheta XDJ-AZ", invoiceDate: "02/03/2026", invoiceNumber: "SI25908535", price: "€ 1.862,30", supplier: "Bekafun" },
  { brand: "Pioneer DJ", productName: "Pioneer DJ DJM-A9", invoiceDate: "02/03/2026", invoiceNumber: "SI25908535", price: "€ 1.540,56", supplier: "Bekafun" },
  { brand: "AlphaTheta", productName: "AlphaTheta FLT-XDJAZ", invoiceDate: "16/03/2026", invoiceNumber: "31396074", price: "€ 190,30", supplier: "Bax-shop.be" },
  { brand: "AlphaTheta", productName: "AlphaTheta RMX-Ignite", invoiceDate: "23/05/2026", invoiceNumber: "INV205341", price: "€ 911,64", supplier: "Fritz Events" },
  { brand: "Pioneer DJ", productName: "Pioneer DJ DJC-STS1", invoiceDate: "28/05/2026", invoiceNumber: "79976", price: "€ 84,05", supplier: "ToneControl" },
  { brand: "Pioneer DJ", productName: "Pioneer DJ DJC-STS1", invoiceDate: "07/06/2026", invoiceNumber: "31573807", price: "€ 88,72", supplier: "Bax-shop.be" },
  { brand: "AlphaTheta", productName: "AlphaTheta CDJ-3000X", invoiceDate: "12/06/2026", invoiceNumber: "SI25912482", price: "€ 2.112,45", supplier: "Bekafun" },
  { brand: "AlphaTheta", productName: "AlphaTheta CDJ-3000X", invoiceDate: "12/06/2026", invoiceNumber: "SI25912482", price: "€ 2.112,45", supplier: "Bekafun" },
  { brand: "Pioneer DJ", productName: "Pioneer DJ RMX-1000", invoiceDate: "16/06/2026", invoiceNumber: "2026-8", price: "€ 500,00", supplier: "Yordi Coussement" },
  { brand: "Pioneer DJ", productName: "Pioneer DJ DDJ-FLX4", invoiceDate: "23/06/2026", invoiceNumber: "20262000494", price: "€ 235,54", supplier: "ProGear" },
  { brand: "AlphaTheta", productName: "AlphaTheta Euphonia", invoiceDate: "06/07/2026", invoiceNumber: "SI26900121", price: "€ 1.858,17", supplier: "Bekafun" },
  { brand: "Pioneer DJ", productName: "Pioneer DJ DJS-1000", invoiceDate: "09/07/2026", invoiceNumber: "31640452", price: "€ 804,26", supplier: "Bax-shop.be" },
  { brand: "Pioneer DJ", productName: "Pioneer DJ XDJ-RX3", invoiceDate: "17/07/2026", invoiceNumber: "31655288", price: "€ 1.259,20", supplier: "Bax-shop.be" },
];

// "Bax-shop.be" is dezelfde leverancier als de bestaande "Bax".
const SUPPLIER_ALIASES = {
  "Bax-shop.be": "Bax",
};

function parseDate(text) {
  const [day, month, year] = text.split("/");
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function parsePrice(text) {
  const normalized = text.replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
  return parseFloat(normalized);
}

async function getOrCreateSupplierId(name) {
  const resolvedName = SUPPLIER_ALIASES[name] || name;

  const [rows] = await pool.query("SELECT id FROM supplier WHERE name = ?", [resolvedName]);
  if (rows.length > 0) return rows[0].id;

  const [result] = await pool.query("INSERT INTO supplier (name) VALUES (?)", [resolvedName]);
  console.log(`  + nieuwe leverancier aangemaakt: "${resolvedName}" (id ${result.insertId})`);
  return result.insertId;
}

async function getOrCreateProductId(name, brandName) {
  const [rows] = await pool.query("SELECT id FROM product WHERE name = ?", [name]);
  if (rows.length > 0) return rows[0].id;

  const [brandRows] = await pool.query("SELECT id FROM brand WHERE name = ?", [brandName]);
  if (brandRows.length === 0) {
    throw new Error(`Merk "${brandName}" niet gevonden, kan product "${name}" niet aanmaken.`);
  }

  const [result] = await pool.query("INSERT INTO product (brand_id, name) VALUES (?, ?)", [
    brandRows[0].id,
    name,
  ]);
  console.log(`  + nieuw product aangemaakt: "${name}" (id ${result.insertId})`);
  return result.insertId;
}

async function run() {
  let inserted = 0;

  for (const purchase of PURCHASES) {
    const supplierId = await getOrCreateSupplierId(purchase.supplier);
    const productId = await getOrCreateProductId(purchase.productName, purchase.brand);
    const price = parsePrice(purchase.price);
    const invoiceDate = parseDate(purchase.invoiceDate);

    await pool.query(
      "INSERT INTO purchase (product_id, supplier_id, price, invoice_date, invoice_number) VALUES (?, ?, ?, ?, ?)",
      [productId, supplierId, price, invoiceDate, purchase.invoiceNumber]
    );

    console.log(
      `✓ ${purchase.productName} | ${invoiceDate} | ${purchase.invoiceNumber} | € ${price.toFixed(2)} | ${purchase.supplier}`
    );
    inserted += 1;
  }

  console.log(`\n${inserted} aankoop/aankopen toegevoegd.`);
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
