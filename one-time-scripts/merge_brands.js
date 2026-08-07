/**
 * Eenmalige opkuis: merkt dubbele merken samen (kort "eerste woord"-merk +
 * volledige naam — ontstaan doordat eerste-woord-extractie enkel één woord
 * ving terwijl salesall's pipe-extractie de volledige naam oplevert) en
 * negeert twee twijfelachtige merken.
 *
 * Uitvoeren:
 *     node merge_brands.js
 */

const pool = require("../db");

// keepId blijft bestaan (meestal het merk met de meeste gekoppelde producten,
// om zo min mogelijk te moeten herlinken), dropId wordt na herlinking
// verwijderd. finalFirstWord wordt enkel meegegeven als het huidige
// first_word van keepId niet al het gewenste korte woord is — first_word
// blijft altijd het korte woord (bestaande conventie: first_word = ruwe
// eerste woord, name = volledige/opgekuiste naam), zodat toekomstige titels
// zonder pipe-formaat correct blijven auto-linken.
const MERGES = [
  { keepId: 293, dropId: 499, finalName: "dB Technologies" }, // dB Technologies (16) + dBTechnologies (2)
  { keepId: 464, dropId: 533, finalName: "High End Systems" }, // HIGH (225) + High End Systems (3)
  { keepId: 528, dropId: 422, finalName: "MA Lighting", finalFirstWord: "MA" }, // MA Lighting (6) + MA (4)
  { keepId: 403, dropId: 549, finalName: "Robert Juliat" }, // ROBERT (76) + Robert Juliat (9)
];

const IGNORE_IDS = [534, 557]; // URC, URC / Expolite / Showtec

async function mergeBrand({ keepId, dropId, finalName, finalFirstWord }) {
  const [bp] = await pool.query("UPDATE bstock_product SET brand_id = ? WHERE brand_id = ?", [
    keepId,
    dropId,
  ]);
  const [prod] = await pool.query("UPDATE product SET brand_id = ? WHERE brand_id = ?", [
    keepId,
    dropId,
  ]);

  // Eerst het dubbele merk verwijderen, pas dan hernoemen: anders botst de
  // unique index op brand.name tijdelijk als finalName gelijk is aan de
  // huidige naam van dropId (bv. "HIGH" -> "High End Systems").
  await pool.query("DELETE FROM brand WHERE id = ?", [dropId]);

  if (finalFirstWord) {
    await pool.query("UPDATE brand SET name = ?, first_word = ? WHERE id = ?", [
      finalName,
      finalFirstWord,
      keepId,
    ]);
  } else {
    await pool.query("UPDATE brand SET name = ? WHERE id = ?", [finalName, keepId]);
  }

  console.log(
    `✓ Merk ${dropId} samengevoegd in ${keepId} ("${finalName}"): ${bp.affectedRows} bstock_product(en), ${prod.affectedRows} product(en) herlinkt.`
  );
}

async function run() {
  for (const merge of MERGES) {
    await mergeBrand(merge);
  }

  const [result] = await pool.query("UPDATE brand SET ignored = 1 WHERE id IN (?)", [IGNORE_IDS]);
  console.log(`✓ ${result.affectedRows} merk(en) genegeerd: ${IGNORE_IDS.join(", ")}`);

  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
