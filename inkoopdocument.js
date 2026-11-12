/**
 * Maakt een aankoopborderel (inkoopdocument) als PDF, in de stijl van de
 * facturen van AFTER DARK. Voor toestellen die we kopen van particulieren
 * (zonder factuur en zonder btw; bij verkoop meestal onder de margeregeling).
 * Er passen tot 5 toestellen op één borderel.
 *
 * Zonder opties: een leeg borderel met 5 regels om met de hand in te vullen.
 * Met --purchase komen datum, toestel, prijs en serienummers uit de tabellen
 * `purchase` en `purchase_serial` (--serienummer gaat voor); de
 * gegevens van de verkoper geef je mee of vul je met de hand in.
 *
 * Uitvoeren:
 *     node inkoopdocument.js
 *     node inkoopdocument.js --purchase 28 --nummer AB2026-1 \
 *         --naam "Jan Peeters" --adres "Kerkstraat 1" --gemeente "2990 Wuustwezel" \
 *         --serienummer ABC123 --staat "Zeer goed" --inbegrepen "netsnoer, originele verpakking"
 *     node inkoopdocument.js --purchase 31,32 --nummer AB2026-2 \
 *         --serienummer ABC123 --serienummer DEF456
 *
 * Meerdere toestellen: --purchase met id's gescheiden door komma's, of
 * --toestel/--prijs herhalen. --serienummer, --staat en --inbegrepen
 * herhaal je per toestel, in dezelfde volgorde. --regels zet het aantal
 * regels (standaard het aantal toestellen, of 5 bij een leeg borderel);
 * extra regels blijven leeg om met de hand in te vullen.
 *
 * Opties: --purchase, --nummer, --datum (dd-mm-jjjj), --naam, --adres,
 * --gemeente, --contact, --id (identiteitskaartnummer), --toestel,
 * --serienummer, --staat, --inbegrepen, --prijs, --regels, --betaling
 * (contant|overschrijving), --iban, --out (pad van de PDF).
 * Standaard komt de PDF in ./inkoopdocumenten/.
 *
 * Nodig: Google Chrome (maakt de PDF, zie documents.js) en voor --purchase
 * de database (.env).
 */

const path = require("path");
const { parseArgs, esc, euro, dmy, field, check, page, printPdf } = require("./documents");

const MAX_ROWS = 5;
const BLANK_ROWS = 5;
const ITEM_FIELDS = ["toestel", "serienummer", "staat", "inbegrepen", "prijs"];

const list = (v) => (v === undefined ? [] : [].concat(v));

async function fromPurchases(ids) {
  require("dotenv").config({ quiet: true });
  const pool = require("./db");
  const [rows] = await pool.query(
    `SELECT p.id, p.price, p.invoice_date, pr.name AS model, b.name AS brand
       FROM purchase p
       LEFT JOIN product pr ON pr.id = p.product_id
       LEFT JOIN brand b ON b.id = pr.brand_id
      WHERE p.id IN (?)`,
    [ids]
  );
  const [serials] = await pool.query(
    "SELECT purchase_id, serial, label FROM purchase_serial WHERE purchase_id IN (?) ORDER BY position, id",
    [ids]
  );
  await pool.end();
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  // Meerdere serienummers (bv. zender en ontvanger) samen in één veld; zonder serienummer leeg.
  const serienummer = (id) =>
    serials
      .filter((s) => String(s.purchase_id) === id)
      .map((s) => (s.label ? `${s.serial} (${s.label})` : s.serial))
      .join(", ");
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`Aankoop ${missing.join(", ")} niet gevonden`);
  const sorted = ids.map((id) => byId.get(id));
  return {
    datum: sorted[0].invoice_date ? dmy(new Date(sorted[0].invoice_date)) : "",
    toestel: sorted.map((r) => [r.brand, r.model].filter(Boolean).join(" ")),
    prijs: sorted.map((r) => r.price),
    serienummer: ids.map(serienummer),
  };
}

// Eén object per regel; de n-de waarde van elke optie hoort bij het n-de toestel.
function items(d) {
  const lists = Object.fromEntries(ITEM_FIELDS.map((f) => [f, list(d[f])]));
  const filled = Math.max(...ITEM_FIELDS.map((f) => lists[f].length));
  const count = d.regels ? Number(d.regels) : filled || BLANK_ROWS;
  if (!Number.isInteger(count) || count < 1) throw new Error(`Ongeldig aantal regels: ${d.regels}`);
  if (count > MAX_ROWS) throw new Error(`Er passen maar ${MAX_ROWS} toestellen op één borderel (nu ${count})`);
  if (count < filled) throw new Error(`--regels ${count} is minder dan het aantal toestellen (${filled})`);
  return Array.from({ length: count }, (_, i) => Object.fromEntries(ITEM_FIELDS.map((f) => [f, lists[f][i]])));
}

const CSS = `
  .contact { line-height: 1.25; }
  .company { margin: 4mm 0 1.5mm; }
  .head { margin-top: 4mm; }
  table.items { margin-top: 5mm; }
  .items td { padding: 1.8mm 0 2.2mm; }
  .items .line { display: flex; align-items: flex-end; }
  .items .sub { margin-top: 1.2mm; }
  .items .lbl { flex: none; color: var(--grey); font-size: 9.5pt; margin: 0 2mm 0 5mm; }
  .items .line > .lbl:first-child { margin-left: 4mm; }
  .items .what { flex: none; margin-right: 1.5mm; }
  .items .desc { width: 80%; }
  .items .blank { min-width: 0; }
  .items .price .blank { width: 26mm; }
  .bottom { display: flex; justify-content: space-between; margin-top: 3mm; }
  .pay { width: 92mm; line-height: 1.8; }
  .pay strong { display: block; }
  .pay .blank { min-width: 44mm; flex: none; }
  .totals { width: 72mm; }
  .totals .r { display: flex; justify-content: space-between; padding: 1.4mm 0; }
  .totals .r.sep { border-bottom: 2px solid var(--line); }
  .totals .r.total { padding-top: 2.5mm; font-size: 15pt; font-weight: 700; }
  .totals .r.total span:first-child { color: var(--orange); }
  .totals .blank { min-width: 26mm; flex: none; }
  .decl { margin-top: 3mm; font-size: 9pt; line-height: 1.35; }
  .decl h3 { font-size: 11pt; margin: 0 0 1mm; }
  .decl ol { margin: 0; padding-left: 5mm; }
  .sign { margin-top: 3mm; }
  .sign .hint { min-height: 7mm; }
  .sign .space { height: 14mm; }
`;

function itemRow(it) {
  return `<tr>
      <td class="desc">
        <div class="line"><span class="what">Aankoop tweedehands</span>${field(it.toestel)}<span class="lbl">Serienummer</span>${field(it.serienummer)}</div>
        <div class="line sub"><span class="lbl">Staat</span>${field(it.staat)}<span class="lbl">Inbegrepen</span>${field(it.inbegrepen)}</div>
      </td>
      <td>${it.toestel || it.prijs ? 1 : ""}</td>
      <td class="num price">${it.prijs ? euro(it.prijs) : '<span class="blank"></span>'}</td>
    </tr>`;
}

function render(d) {
  const rows = items(d);
  const one = rows.length === 1;
  const total = rows.every((it) => it.prijs) ? euro(rows.reduce((s, it) => s + Number(it.prijs), 0)) : "";
  const het = one ? "dit toestel" : "deze toestellen";

  return page({
    title: "Aankoopborderel",
    nummer: d.nummer,
    meta: [["Aankoopdatum", d.datum]],
    party: {
      title: "Verkoper",
      rows: [
        ["Naam", d.naam],
        ["Adres", d.adres],
        ["Postcode en gemeente", d.gemeente],
        ["E-mail of telefoon", d.contact],
        ["Identiteitskaartnr.", d.id],
      ],
    },
    css: CSS,
    body: `
  <table class="items">
    <tr><th>Beschrijving</th><th>Aantal</th><th class="num">Prijs</th></tr>
    ${rows.map(itemRow).join("\n    ")}
  </table>

  <div class="bottom">
    <div class="pay">
      <strong>Betaling</strong>
      ${check(d.betaling === "contant")}Contant, ontvangen bij de overdracht<br>
      ${check(d.betaling === "overschrijving")}Overschrijving naar IBAN ${field(d.iban)}
    </div>
    <div class="totals">
      <div class="r sep"><span>Btw</span><span>niet van toepassing</span></div>
      <div class="r total"><span>TOTAAL</span><span>${total || '<span class="blank"></span>'}</span></div>
      <div class="note">Aankoop van een particulier, zonder btw.</div>
    </div>
  </div>

  <div class="decl">
    <h3>Verklaring van de verkoper</h3>
    <ol>
      <li>Ik verkoop ${het} als particulier, niet in het kader van een economische activiteit, en reik er geen factuur met btw voor uit.</li>
      <li>Ik ben de rechtmatige eigenaar. ${one ? "Het toestel is" : "De toestellen zijn"} niet gestolen, niet gehuurd of geleased, en vrij van schulden, pand of andere rechten van derden.</li>
      <li>${one ? "Het toestel wordt" : "De toestellen worden"} verkocht in de staat waarin ${one ? "het" : "ze"} bij de overdracht gezien en getest ${one ? "werd" : "werden"}. Gebreken die ik ken, heb ik gemeld.</li>
      <li>De eigendom gaat over op AFTER DARK bij de betaling van de prijs hierboven.</li>
    </ol>
  </div>

  <div class="sign">
    <div><div class="who">Verkoper</div><div class="hint">Naam, datum en handtekening, voorafgegaan door "gelezen en goedgekeurd"</div><div class="space"></div></div>
    <div><div class="who">Koper: AFTER DARK</div><div class="hint">David Spiessens</div><div class="space"></div></div>
  </div>
`,
    footer: "",
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ids = list(args.purchase).flatMap((v) => String(v).split(",")).map((s) => s.trim()).filter(Boolean);
  const data = ids.length ? { ...(await fromPurchases(ids)), ...args } : args;
  for (const p of list(data.prijs)) {
    if (p !== "" && isNaN(Number(p))) throw new Error(`Ongeldige prijs: ${p}`);
  }

  const out = args.out || path.join("inkoopdocumenten", `${data.nummer || "leeg"}.pdf`);
  console.log(printPdf(render(data), out));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
