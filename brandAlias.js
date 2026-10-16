/**
 * Alternatieve schrijfwijzen van merken, uit de tabel `brand_alias`
 * (alias -> brand_id). Vervangt de vroeger hardcoded BRAND_ALIASES en
 * MULTI_WORD_BRAND_PREFIXES in brands.js/link_brands.js. Een alias wordt
 * vergeleken met het begin van een titel (op een woordgrens), dus een alias
 * kan uit meerdere woorden bestaan ("martin audio") en wint daarbij van de
 * eerste-woord-extractie ("martin" zou anders aan Martin Professional
 * gekoppeld worden).
 *
 * Beheer via de merkpagina in de PHP-viewer, of rechtstreeks in de tabel.
 */

// Vergelijking is accent-, hoofdletter- en apostrof-ongevoelig, aan beide
// kanten (titel én alias), zodat "L’Acoustics" en "l'acoustics" hetzelfde zijn.
function normalizeAlias(text) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’‘´`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Laadt alle aliassen; langste eerst, zodat een specifiekere alias voorrang krijgt. */
async function loadAliases(pool) {
  const [rows] = await pool.query("SELECT alias, brand_id FROM brand_alias");
  return rows
    .map((row) => ({ alias: normalizeAlias(row.alias), brandId: row.brand_id }))
    .filter((entry) => entry.alias !== "")
    .sort((a, b) => b.alias.length - a.alias.length);
}

/** brand_id als de volledige tekst exact een alias is, anders null. */
function matchAliasExact(text, aliases) {
  const normalized = normalizeAlias(text);
  const hit = aliases.find((entry) => entry.alias === normalized);
  return hit ? hit.brandId : null;
}

/** brand_id als de tekst begint met een alias (op een woordgrens), anders null. */
function matchAliasPrefix(text, aliases) {
  const normalized = normalizeAlias(text);
  const hit = aliases.find(
    (entry) => normalized === entry.alias || normalized.startsWith(`${entry.alias} `)
  );
  return hit ? hit.brandId : null;
}

module.exports = { normalizeAlias, loadAliases, matchAliasExact, matchAliasPrefix };
