/**
 * Normaliseert de schrijfwijze van de merknaam binnen bstock_product.title en
 * product.name naar de canonieke schrijfwijze van brand.name (bv. "Audio
 * Technica" in een titel wordt "Audio-Technica" als dat de canonieke
 * merknaam is).
 *
 * Hergebruikt dezelfde extractielogica als brands.js/link_brands.js om het
 * merk-segment in de titel te lokaliseren, en vervangt enkel als dat segment
 * overeenkomt met het al gekoppelde merk (veiligheidscheck — voorkomt een
 * foutieve vervanging bij bv. handmatig gekoppelde producten waarvan de
 * titel niet met het merk begint).
 *
 * Standaard een dry run (toont enkel wat zou veranderen, past niets aan).
 *
 * Uitvoeren:
 *     node normalize_brand_in_titles.js          (dry run)
 *     node normalize_brand_in_titles.js --apply  (echt toepassen)
 */

const pool = require("./db");

const APPLY = process.argv.includes("--apply");

// #7123 "Wireless Solutions Sweden ..." (met een s) geeft door het
// enkelvoud/meervoud-verschil met merk "Wireless Solution" een licht
// duplicaat ("Wireless Solution Solutions Sweden ...") — handmatig op te
// lossen, hier overslaan.
const EXCLUDE_IDS = new Set([7123]);

const BSTOCK_PREFIX_REGEX = /^\(?b-stock\)?:?\s*/i;
const FIRST_WORD_REGEX = /^(\S+)/;
const PIPE_BRAND_REGEX = /^(?:used|b-stock)\s*\|\s*([^|]+?)\s*\|/i;
const PIPE_NO_BRAND_REGEX = /^(?:used|b-stock)\s*\|/i;

function normalizeKey(text) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Zoekt het merk-segment in een titel voor het first-word-pad (geen pipes).
 * Consumeert opeenvolgende woorden zolang hun samengevoegde genormaliseerde
 * tekst een prefix blijft van de genormaliseerde merknaam — zo wordt een
 * meerwoordig merk (bv. "Pioneer DJ", "Konig & Meyer", "LD Systems") volledig
 * gevonden, ook als de titel het al voluit correct spelt (anders zou enkel
 * het eerste woord vervangen worden en de rest als duplicaat blijven staan,
 * bv. "Pioneer DJ" -> "Pioneer DJ DJ").
 */
function consumeBrandWords(text, brandName) {
  const brandKey = normalizeKey(brandName);
  if (!brandKey) return null;

  const wordRegex = /\S+/g;
  let consumedKey = "";
  let end = 0;
  let match;

  while ((match = wordRegex.exec(text)) !== null) {
    const candidateKey = consumedKey + normalizeKey(match[0]);
    if (!brandKey.startsWith(candidateKey)) break;
    consumedKey = candidateKey;
    end = match.index + match[0].length;
    if (consumedKey === brandKey) break;
  }

  if (end === 0) return null;
  return { matchedText: text.slice(0, end), end };
}

/** Zoekt het merk-segment in een titel, geeft {matchedText, start, end} terug of null. */
function locateBrandSegment(title, brandName) {
  const pipeMatch = title.match(PIPE_BRAND_REGEX);
  if (pipeMatch) {
    const start = pipeMatch.index + pipeMatch[0].indexOf(pipeMatch[1]);
    return { matchedText: pipeMatch[1], start, end: start + pipeMatch[1].length };
  }
  if (PIPE_NO_BRAND_REGEX.test(title)) {
    return null;
  }

  const prefixMatch = title.match(BSTOCK_PREFIX_REGEX);
  const prefixLength = prefixMatch ? prefixMatch[0].length : 0;
  const rest = title.slice(prefixLength);

  const consumed = consumeBrandWords(rest, brandName);
  if (!consumed) return null;

  return { matchedText: consumed.matchedText, start: prefixLength, end: prefixLength + consumed.end };
}

function buildNewText(text, segment, brandName) {
  return text.slice(0, segment.start) + brandName + text.slice(segment.end);
}

async function processTable(table, textColumn) {
  const [rows] = await pool.query(
    `SELECT t.id AS id, t.${textColumn} AS text, b.name AS brand_name, b.first_word AS brand_first_word
     FROM ${table} t
     JOIN brand b ON b.id = t.brand_id`
  );

  let changed = 0;
  let alreadyCorrect = 0;
  let skippedNoMatch = 0;

  for (const row of rows) {
    if (EXCLUDE_IDS.has(row.id)) {
      continue;
    }

    const segment = locateBrandSegment(row.text, row.brand_name);
    if (!segment) {
      skippedNoMatch += 1;
      continue;
    }

    if (segment.matchedText === row.brand_name) {
      alreadyCorrect += 1;
      continue;
    }

    const newText = buildNewText(row.text, segment, row.brand_name);
    console.log(`  #${row.id}: "${row.text}" -> "${newText}"`);

    if (APPLY) {
      await pool.query(`UPDATE ${table} SET ${textColumn} = ? WHERE id = ?`, [newText, row.id]);
    }
    changed += 1;
  }

  console.log(
    `\n${table}.${textColumn}: ${changed} ${APPLY ? "aangepast" : "zouden aangepast worden"}, ` +
      `${alreadyCorrect} al correct, ` +
      `${skippedNoMatch} overgeslagen (merk-segment niet gevonden aan het begin van de titel).`
  );
}

async function run() {
  console.log(APPLY ? "APPLY-modus: wijzigingen worden echt doorgevoerd.\n" : "DRY RUN: er wordt niets aangepast.\n");

  await processTable("bstock_product", "title");
  console.log("");
  await processTable("product", "name");

  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
