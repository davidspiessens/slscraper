/**
 * Haalt het aantal stuks uit een voorvoegsel vooraan de titel ("4x QSC WL
 * 3082", "11+1 Vari*Lite", "6X ETC Source Four"). Dit is dezelfde regex die
 * brands.js/link_brands.js al gebruikten om dit voorvoegsel te strippen vóór
 * merkherkenning — hier wordt het aantal zelf ook effectief opgehaald i.p.v.
 * enkel weggegooid.
 *
 * "11+1" wordt gelezen als 12 stuks in totaal (bv. 11 hoofdunits + 1
 * reserve/accessoire van hetzelfde type) — een aanname, maar de meest
 * bruikbare voor prijs-per-stuk-vergelijking.
 *
 * Samengestelde bundels van VERSCHILLENDE producten ("18x A + 4x
 * Riggingframe") worden bewust niet opgesplitst: enkel het eerste getal
 * telt als quantity, de rest blijft gewoon in de titel staan. Zo'n bundel is
 * sowieso niet zinvol tot één eenheidsprijs te herleiden.
 *
 * Geeft altijd minstens 1 terug (default voor titels zonder herkenbaar
 * aantal vooraan).
 */

const QUANTITY_PREFIX_REGEX = /^(\d+)(?:\+(\d+))?x?\s+/i;

function parseQuantity(title) {
  if (!title) return 1;
  const match = title.match(QUANTITY_PREFIX_REGEX);
  if (!match) return 1;

  const first = parseInt(match[1], 10);
  const second = match[2] ? parseInt(match[2], 10) : 0;
  const total = first + second;
  return total > 0 ? total : 1;
}

/** Strip hetzelfde voorvoegsel van de titel (voor merk-/productmatching). */
function stripQuantityPrefix(title) {
  return title.replace(QUANTITY_PREFIX_REGEX, "");
}

module.exports = { parseQuantity, stripQuantityPrefix, QUANTITY_PREFIX_REGEX };
