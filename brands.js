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

// brand.name's unique index is accent-ongevoelig (MySQL's standaard
// utf8mb4-collation): "Terre" en "Terré" botsen daar als duplicaten, ook al
// zijn het als kale JS-strings niet gelijk. Zonder accenten weg te halen bij
// het vergelijken zou de in-memory bestaand-check dat soort duplicaten missen
// en de INSERT verderop laten crashen.
function normalizeForComparison(text) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
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
    keys.add(normalizeForComparison(row.first_word));
    keys.add(normalizeForComparison(row.name));
  }
  return keys;
}

// Zonder deze check herhaalt zich telkens hetzelfde probleem: een bestaand
// merk is handmatig van een korte naar een volledige naam hernoemd (bv.
// "Austrian" -> "Austrian Audio"), maar een latere titel levert opnieuw enkel
// het korte eerste woord ("Austrian") op — dat matcht geen enkele bestaande
// key exact, en wordt dus telkens opnieuw als apart, afgekapt duplicaat-merk
// aangemaakt. Hier wordt gecontroleerd of de kandidaat een voorvoegsel is
// (op woordgrens) van een reeds bestaande, langere merknaam; zo ja, dan is er
// al een vollediger merk en wordt er geen nieuw kort duplicaat aangemaakt.
async function getExistingBrandNames() {
  const [rows] = await pool.query("SELECT first_word, name FROM brand");
  const names = new Set();
  for (const row of rows) {
    names.add(row.first_word);
    names.add(row.name);
  }
  return [...names];
}

function isPrefixOfExistingLongerBrand(candidate, existingNames) {
  const candidateLower = normalizeForComparison(candidate);
  return existingNames.some((name) => {
    const nameLower = normalizeForComparison(name);
    return nameLower.length > candidateLower.length && nameLower.startsWith(`${candidateLower} `);
  });
}

async function run() {
  const [rows] = await pool.query(
    "SELECT DISTINCT title FROM bstock_product WHERE brand_id IS NULL AND supplier_id != ?",
    [CUESALE_SUPPLIER_ID]
  );
  console.log(`${rows.length} unieke producttitels gevonden (cuesale uitgesloten).`);

  const existing = await getExistingBrandKeys();
  const existingNames = await getExistingBrandNames();
  // Map i.p.v. Set: dedupliceren op genormaliseerde key, want brand.name heeft
  // een case- én accent-ongevoelige unique index (anders botsen bv. "APEX" en
  // "Apex", of "Terre" en "Terré", binnen dezelfde run).
  const newBrands = new Map();
  let skipped = 0;
  let skippedAsPrefix = 0;

  for (const { title } of rows) {
    const brand = extractBrand(title);
    if (!brand) {
      skipped += 1;
      continue;
    }
    const key = normalizeForComparison(brand);
    const resolvedKey = BRAND_ALIASES[key] || key;
    if (existing.has(resolvedKey) || newBrands.has(resolvedKey)) {
      continue;
    }
    if (isPrefixOfExistingLongerBrand(brand, existingNames)) {
      skippedAsPrefix += 1;
      continue;
    }
    newBrands.set(resolvedKey, brand);
  }

  if (skipped > 0) {
    console.log(`  ⚠ ${skipped} titel(s) overgeslagen: geen merk gevonden.`);
  }
  if (skippedAsPrefix > 0) {
    console.log(
      `  ⚠ ${skippedAsPrefix} titel(s) overgeslagen: kandidaat is een voorvoegsel van een al bestaand, langer merk (mogelijk moet link_brands.js dit product alsnog koppelen).`
    );
  }

  let created = 0;
  let duplicates = 0;

  for (const brand of newBrands.values()) {
    try {
      await pool.query("INSERT INTO brand (name, first_word) VALUES (?, ?)", [brand, brand]);
      existing.add(normalizeForComparison(brand));
      created += 1;
    } catch (error) {
      // Verdedigend: de in-memory check hierboven dekt de gekende accent-
      // ongevoeligheid af, maar laat de hele run niet crashen als de database
      // toch nog een duplicate-key tegenkomt (bv. een accentvariant die de
      // NFD-normalisatie niet ving, of een gelijktijdige run).
      if (error.code === "ER_DUP_ENTRY") {
        duplicates += 1;
        console.log(`  ⚠ "${brand}" overgeslagen: botst met een bestaand merk (duplicate-key).`);
      } else {
        throw error;
      }
    }
  }

  if (duplicates > 0) {
    console.log(`  ⚠ ${duplicates} merk(en) overgeslagen wegens duplicate-key.`);
  }

  console.log(`\n✓ ${created} nieuw(e) merk(en) opgeslagen in de database.`);

  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
