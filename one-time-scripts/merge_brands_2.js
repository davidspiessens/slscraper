/**
 * Tweede ronde merk-samenvoegingen (zie merge_brands.js voor de eerste).
 * Ontstaan door dezelfde oorzaak: eerste-woord-extractie/pipe-extractie
 * die verschillende schrijfwijzen van dezelfde merknaam als apart merk
 * aanmaakte.
 *
 * Uitvoeren:
 *     node merge_brands_2.js
 */

const pool = require("../db");

// keepId blijft bestaan, dropIds worden na herlinking verwijderd. finalName
// is de door de gebruiker gekozen definitieve schrijfwijze. finalFirstWord
// wordt enkel meegegeven als het gewenste first_word niet al op keepId
// staat (first_word = ruwe eerste woord voor toekomstige auto-linking,
// name = opgekuiste/definitieve naam — bestaande conventie in dit project).
const MERGES = [
  { keepId: 578, dropIds: [417, 609], finalName: "Clear-Com", finalFirstWord: "ClearCom" },
  { keepId: 526, dropIds: [565], finalName: "DeSisti" },
  { keepId: 30, dropIds: [586], finalName: "Electro-Voice" },
  { keepId: 391, dropIds: [753], finalName: "L-Acoustics" },
  { keepId: 493, dropIds: [639], finalName: "Lab Gruppen" },
  { keepId: 568, dropIds: [809], finalName: "Master Audio" },
  { keepId: 210, dropIds: [611], finalName: "Magic FX" },
  { keepId: 552, dropIds: [705, 703], finalName: "Vari-Lite", finalFirstWord: "Vari*Lite" },
  { keepId: 564, dropIds: [806], finalName: "Green Hippo" },
  { keepId: 541, dropIds: [614], finalName: "Sound Projects" },
  { keepId: 567, dropIds: [772], finalName: "Wireless Solution" },
  { keepId: 523, dropIds: [648, 545], finalName: "CM Lodestar" },
];

async function mergeBrand({ keepId, dropIds, finalName, finalFirstWord }) {
  let bpTotal = 0;
  let prodTotal = 0;

  for (const dropId of dropIds) {
    const [bp] = await pool.query("UPDATE bstock_product SET brand_id = ? WHERE brand_id = ?", [
      keepId,
      dropId,
    ]);
    const [prod] = await pool.query("UPDATE product SET brand_id = ? WHERE brand_id = ?", [
      keepId,
      dropId,
    ]);
    bpTotal += bp.affectedRows;
    prodTotal += prod.affectedRows;

    // Eerst verwijderen, pas dan hernoemen: anders botst de unique index op
    // brand.name tijdelijk als finalName gelijk is aan de huidige naam van
    // dropId.
    await pool.query("DELETE FROM brand WHERE id = ?", [dropId]);
  }

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
    `✓ Merk(en) ${dropIds.join(", ")} samengevoegd in ${keepId} ("${finalName}"): ${bpTotal} bstock_product(en), ${prodTotal} product(en) herlinkt.`
  );
}

async function run() {
  for (const merge of MERGES) {
    await mergeBrand(merge);
  }

  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
