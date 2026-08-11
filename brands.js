/**
 * Extraheert merknamen uit bstock_product.title (eerste woord, na een eventueel
 * "(B-Stock)" of "B-stock:" voorvoegsel — titelopbouw verschilt per leverancier)
 * en slaat nieuwe, unieke merken op in de tabel `brand`.
 *
 * Uitvoeren:
 *     node brands.js
 */

const pool = require("./db");

// cuesale-titels hebben geen betrouwbaar merk-scheidingsteken (geen pipes,
// geen B-stock-voorvoegsel — gewoon "Merk Model" of soms enkel "Model").
// Eerste-woord-extractie levert er evenveel ruis op (Flightcase, Cable,
// Generic, Power, ...) als echte merken, dus deze leverancier wordt
// uitgesloten van nieuwe merk-aanmaak. Bestaande merken linken (link_brands.js)
// blijft wel gewoon werken voor cuesale-producten.
const CUESALE_SUPPLIER_ID = 11;

// Strip een optioneel B-stock-voorvoegsel in eender welke vorm:
// bax-shop: "(B-Stock) ", progear: "B-stock: ". Titels zonder voorvoegsel
// (bv. sommige progear-artikels) blijven ongewijzigd.
const BSTOCK_PREFIX_REGEX = /^\(?b-stock\)?:?\s*/i;
// kinxsound zet vaak een aantal vooraan de titel ("8X MARTIN AUDIO...",
// "11+1 VARI*LITE...") — zonder dit te strippen wordt dat aantal zelf als
// (nep-)merk herkend.
const QUANTITY_PREFIX_REGEX = /^\d+(?:\+\d+)?x?\s+/i;
// Sommige titels laten het eerste woord op een leesteken eindigen (bv.
// kinxsound "AD-SYSTEMS: ...", "DYNACORD: ..."), dat hoort niet bij de merknaam.
const TRAILING_PUNCTUATION_REGEX = /[:,.]+$/;
const FIRST_WORD_REGEX = /^(\S+)/;
// salesall: "Used | Merk | Model" of "B-Stock | Merk | Model" — het merk staat
// tussen de eerste twee pipes en kan uit meerdere woorden bestaan
// (bv. "Lab Gruppen", "Clay Paky"), dus niet enkel het eerste woord nemen.
const PIPE_BRAND_REGEX = /^(?:used|b-stock)\s*\|\s*([^|]+?)\s*\|/i;
// salesall heeft ook titels zonder apart merk-segment (generieke accessoires
// zoals kabels/flightcases, bv. "Used | Floodlight 1000W HQI Symmetric") —
// zonder tweede pipe is er geen betrouwbaar merk, dus overslaan i.p.v. "Used"
// zelf als merk te nemen.
const PIPE_NO_BRAND_REGEX = /^(?:used|b-stock)\s*\|/i;

// Sommige producttitels beginnen met een sub-merk/productlijn die feitelijk
// hetzelfde bedrijf is als een reeds bestaand merk (bv. "GrandMA" is de
// consolelijn van "MA Lighting"). Zonder deze alias-mapping zou het eerste
// woord ("GrandMA") als apart, fout merk worden aangemaakt. Key = lowercase
// eerste woord uit de titel, value = lowercase brand.name van het bestaande
// merk waaraan het moet worden gekoppeld.
const BRAND_ALIASES = {
  grandma: "ma lighting",
};

// Merken waarvan het eerste woord alleen ambigu is: "Martin" op zich matcht
// het bestaande merk "Martin Professional" (first_word "Martin"), terwijl
// titels als "Martin Audio ..." (kinxsound) eigenlijk het andere, al
// bestaande merk "Martin Audio" bedoelen. Deze lijst met lowercase
// twee-woord-voorvoegsels wordt vóór de eerste-woord-extractie gecontroleerd
// zodat zulke titels niet fout aan het eerste-woord-merk gekoppeld worden.
const MULTI_WORD_BRAND_PREFIXES = ["martin audio"];

function extractBrand(title) {
  const pipeMatch = title.match(PIPE_BRAND_REGEX);
  if (pipeMatch) {
    return pipeMatch[1].trim();
  }
  if (PIPE_NO_BRAND_REGEX.test(title)) {
    return null;
  }

  const withoutPrefix = title.replace(BSTOCK_PREFIX_REGEX, "").replace(QUANTITY_PREFIX_REGEX, "");

  const lower = withoutPrefix.toLowerCase();
  const multiWordMatch = MULTI_WORD_BRAND_PREFIXES.find(
    (prefix) => lower === prefix || lower.startsWith(`${prefix} `)
  );
  if (multiWordMatch) {
    return withoutPrefix.slice(0, multiWordMatch.length);
  }

  const match = withoutPrefix.match(FIRST_WORD_REGEX);
  return match ? match[1].replace(TRAILING_PUNCTUATION_REGEX, "") : null;
}

// Zowel first_word als name tellen als "bestaand": first_word omdat dat de
// gebruikelijke vergelijking is (name kan handmatig hernoemd zijn, bv.
// "Pioneer" -> "Pioneer DJ"), name omdat de pipe-extractie (salesall) meteen
// de volledige merknaam oplevert, die toevallig al kan overeenkomen met een
// eerder handmatig hernoemd merk (bv. "Lab" -> "Lab Gruppen") — zonder deze
// check zou brand.name's unique index dat als duplicate-insert weigeren.
async function getExistingBrandKeys() {
  const [rows] = await pool.query("SELECT first_word, name FROM brand");
  const keys = new Set();
  for (const row of rows) {
    keys.add(row.first_word.toLowerCase());
    keys.add(row.name.toLowerCase());
  }
  return keys;
}

async function run() {
  const [rows] = await pool.query(
    "SELECT DISTINCT title FROM bstock_product WHERE brand_id IS NULL AND supplier_id != ?",
    [CUESALE_SUPPLIER_ID]
  );
  console.log(`${rows.length} unieke producttitels gevonden (cuesale uitgesloten).`);

  const existing = await getExistingBrandKeys();
  // Map i.p.v. Set: dedupliceren op lowercase key, want brand.name heeft een
  // case-insensitive unique index (anders botsen bv. "APEX" en "Apex" binnen
  // dezelfde run).
  const newBrands = new Map();
  let skipped = 0;

  for (const { title } of rows) {
    const brand = extractBrand(title);
    if (!brand) {
      skipped += 1;
      continue;
    }
    const key = brand.toLowerCase();
    const resolvedKey = BRAND_ALIASES[key] || key;
    if (!existing.has(resolvedKey) && !newBrands.has(resolvedKey)) {
      newBrands.set(resolvedKey, brand);
    }
  }

  if (skipped > 0) {
    console.log(`  ⚠ ${skipped} titel(s) overgeslagen: geen merk gevonden.`);
  }

  for (const brand of newBrands.values()) {
    await pool.query("INSERT INTO brand (name, first_word) VALUES (?, ?)", [brand, brand]);
    existing.add(brand.toLowerCase());
  }

  console.log(`\n✓ ${newBrands.size} nieuw(e) merk(en) opgeslagen in de database.`);

  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
