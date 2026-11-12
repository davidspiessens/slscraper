/**
 * Zoekt producten op reverb.com via een zoekterm en slaat ze op in de
 * database. Gebruikt de publieke Reverb API (zelfde resultaten als
 * https://reverb.com/marketplace?query=...), dus geen browser nodig.
 * Prijzen worden in EUR opgevraagd. Reverb-verkopers zijn grotendeels
 * particulieren en de prijs is "tax_included: false", dus geen omrekening.
 *
 * Bij een prijsdaling geeft Reverb de oorspronkelijke prijs mee; die wordt
 * als priceOriginal opgeslagen, met het "x% price drop"-label als korting.
 *
 * Opgelet: archive_products.js 23 archiveert álle Reverb-producten die niet
 * in de laatste 3 uur een prijs kregen — draai dus alle zoektermen vlak na
 * elkaar vóór het archiveren, anders verdwijnen de producten van andere
 * zoektermen.
 *
 * Uitvoeren:
 *     node reverb.js "<zoekterm>"
 *     node reverb.js "rodec mx"
 */

const pool = require("./db");
const { log } = require("./logger");
const { parseQuantity } = require("./quantity");

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error('Gebruik: node reverb.js "<zoekterm>"');
  process.exit(1);
}

const API_URL = "https://api.reverb.com/api/listings";
const SUPPLIER = 23; // Reverb
const PER_PAGE = 50;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Haalt één pagina resultaten op van de Reverb API. */
async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      "Accept-Version": "3.0",
      Accept: "application/hal+json",
      "Content-Type": "application/hal+json",
      "X-Display-Currency": "EUR",
    },
  });
  if (!res.ok) {
    throw new Error(`Reverb API gaf HTTP ${res.status} voor ${url}`);
  }
  return res.json();
}

/**
 * Splitst een merknaam die aan het model vastgeplakt is ("RodecMX 180" ->
 * "Rodec MX 180"), zodat brands.js/link_brands.js het merk herkennen.
 * Reverb geeft het merk apart mee in listing.make.
 */
function splitGluedBrand(title, make) {
  if (!title || !make) return title;
  const brand = make.trim();
  if (!brand || /\s/.test(brand)) return title;
  const firstWord = title.split(/\s/, 1)[0];
  if (firstWord.length > brand.length && firstWord.toLowerCase().startsWith(brand.toLowerCase())) {
    return `${title.slice(0, brand.length)} ${title.slice(brand.length)}`;
  }
  return title;
}

/** Zet een Reverb-listing om naar het formaat dat saveProducts verwacht. */
function toProduct(listing) {
  const priceNow = listing.price ? parseFloat(listing.price.amount) : null;
  const original = listing.price_drop?.original_price || listing.original_price;
  const priceOriginal = original ? parseFloat(original.amount) : priceNow;

  return {
    id: String(listing.id),
    title: listing.title ? splitGluedBrand(listing.title.trim(), listing.make) : null,
    url: listing._links?.web?.href || null,
    priceNow: isNaN(priceNow) ? null : priceNow,
    priceOriginal: isNaN(priceOriginal) ? null : priceOriginal,
    discount: listing.price_drop?.display || null,
    currency: listing.price?.currency,
    state: listing.state?.slug,
  };
}

/** Zoekt een bestaand product op basis van supplier + supplier_product_id, of maakt het aan. */
async function getOrCreateProductId(prod) {
  const [rows] = await pool.query(
    "SELECT id FROM bstock_product WHERE supplier_id = ? AND supplier_product_id = ? LIMIT 1",
    [SUPPLIER, prod.id]
  );
  if (rows.length > 0) {
    return rows[0].id;
  }

  const [result] = await pool.query(
    "INSERT INTO bstock_product (supplier_id, supplier_product_id, title, quantity, url) VALUES (?, ?, ?, ?, ?)",
    [SUPPLIER, prod.id, prod.title, parseQuantity(prod.title), prod.url]
  );
  return result.insertId;
}

/** Slaat producten en hun prijzen op in de database. */
async function saveProducts(products) {
  let saved = 0;
  let skipped = 0;

  for (const prod of products) {
    if (!prod.id || !prod.title || !prod.url) {
      skipped += 1;
      continue;
    }
    if (prod.priceOriginal == null || prod.priceNow == null || prod.currency !== "EUR") {
      skipped += 1;
      continue;
    }
    if (prod.state && prod.state !== "live") {
      skipped += 1;
      continue;
    }

    const productId = await getOrCreateProductId(prod);

    try {
      await pool.query(
        "INSERT INTO bstock_product_price (bstock_product_id, priceOriginal, priceNow, discount_label) VALUES (?, ?, ?, ?)",
        [productId, prod.priceOriginal, prod.priceNow, prod.discount || ""]
      );
      saved += 1;
    } catch (error) {
      console.error(error);
    }
  }

  if (skipped > 0) {
    console.log(`  ⚠ ${skipped} product(en) overgeslagen wegens ontbrekende velden, andere munt of niet live.`);
  }

  return saved;
}

async function scrape() {
  await log(SUPPLIER, `Start van reverb.js (zoekterm: "${query}")`, "start");

  let currentUrl = `${API_URL}?${new URLSearchParams({ query, per_page: PER_PAGE })}`;
  let pageNum = 1;
  let totalFound = 0;
  let totalSaved = 0;
  const seen = new Set();

  while (currentUrl) {
    console.log(`Pagina ${pageNum}: ${currentUrl}`);
    const data = await fetchPage(currentUrl);

    const products = (data.listings || []).map(toProduct);
    totalFound += products.length;

    const unique = products.filter((prod) => {
      if (seen.has(prod.id)) return false;
      seen.add(prod.id);
      return true;
    });

    const saved = await saveProducts(unique);
    totalSaved += saved;
    console.log(`  → ${products.length} producten gevonden, ${saved} opgeslagen (totaal opgeslagen: ${totalSaved})`);
    await log(SUPPLIER, `Zoekterm "${query}", pagina ${pageNum}: ${products.length} gevonden, ${saved} opgeslagen`);

    const nextUrl = data._links?.next?.href || null;
    currentUrl = nextUrl && nextUrl !== currentUrl ? nextUrl : null;
    pageNum += 1;

    if (currentUrl) {
      console.log("  ⏳ 5s wachten voor volgende pagina...");
      await sleep(5000);
    }
  }

  console.log(`\n✓ ${totalSaved} product(en) opgeslagen in de database (${totalFound} gevonden)`);
  await log(SUPPLIER, `Einde van reverb.js (zoekterm: "${query}"): ${totalSaved} opgeslagen (${totalFound} gevonden)`, "success");

  await pool.end();
}

scrape().catch(async (err) => {
  console.error(err);
  await log(SUPPLIER, `Fout in reverb.js (zoekterm: "${query}"): ${err.message}`, "error");
  process.exit(1);
});
