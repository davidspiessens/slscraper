/**
 * Eenmalige import van een tweede lijst aankopen (aangeleverd door de
 * gebruiker) in de tabel `purchase`. Zelfde aanpak als import_purchases.js:
 * merken/producten/leveranciers worden hergebruikt indien ze al bestaan,
 * ontbrekende worden aangemaakt.
 *
 * Uitvoeren:
 *     node import_purchases_2.js
 */

const pool = require("../db");

const PURCHASES = [
  { brand: "Hilec", productName: "Hilec LS64", invoiceDate: "28/11/2025", invoiceNumber: "SI25905024", price: "€ 40,95", supplier: "Bekafun" },
  { brand: "AlphaTheta", productName: "AlphaTheta XDJ-AZ", invoiceDate: "03/03/2026", invoiceNumber: "SI25908590", price: "€ 1.862,30", supplier: "Bekafun" },
  { brand: "AlphaTheta", productName: "AlphaTheta Euphonia", invoiceDate: "12/06/2026", invoiceNumber: "SI25912482", price: "€ 1.983,44", supplier: "Bekafun" },
  { brand: "Pioneer DJ", productName: "Pioneer DJ XDJ-RX3", invoiceDate: "02/03/2026", invoiceNumber: "SI25908535", price: "€ 1.149,91", supplier: "Bekafun" },
];

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

async function getOrCreateBrandId(name) {
  const [rows] = await pool.query("SELECT id FROM brand WHERE name = ?", [name]);
  if (rows.length > 0) return rows[0].id;

  const [result] = await pool.query("INSERT INTO brand (name, first_word) VALUES (?, ?)", [name, name]);
  console.log(`  + nieuw merk aangemaakt: "${name}" (id ${result.insertId})`);
  return result.insertId;
}

async function getOrCreateProductId(name, brandName) {
  const [rows] = await pool.query("SELECT id FROM product WHERE name = ?", [name]);
  if (rows.length > 0) return rows[0].id;

  const brandId = await getOrCreateBrandId(brandName);

  const [result] = await pool.query("INSERT INTO product (brand_id, name) VALUES (?, ?)", [
    brandId,
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
