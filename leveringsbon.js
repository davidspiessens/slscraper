/**
 * Maakt een leveringsbon als PDF, in de stijl van de facturen van AFTER DARK.
 * Zonder opties een lege bon om af te drukken en met de hand in te vullen,
 * voor verkoop en verhuur (afgehaald of geleverd).
 *
 * Uitvoeren:
 *     node leveringsbon.js
 *     node leveringsbon.js --nummer LB2026-1 --datum 04-11-2026 --factuur 2026-27
 *
 * Opties: --nummer, --datum, --factuur, --naam, --adres, --gemeente,
 * --contact, --btw, --out (pad van de PDF). Standaard komt de PDF in
 * ./leveringsbonnen/.
 */

const path = require("path");
const { TERMS_URL, parseArgs, esc, field, check, page, printPdf } = require("./documents");

const ROWS = 5;

const CSS = `
  .items td { height: 9mm; padding: 0; }
  .items .desc { width: 58%; }
  .items .serial { width: 30%; }
  .items th.num, .items td.num { width: 12%; }
  .section { margin-top: 4mm; }
  .section strong { display: block; margin-bottom: 1mm; }
  .delivery { line-height: 1.9; }
  .delivery .blank { flex: none; width: 140mm; margin-left: 1mm; }
  .lines .blank { display: block; min-width: 0; height: 7mm; }
  .receipt { margin: 5mm 0 0; font-size: 9.5pt; line-height: 1.45; }
  .sign { margin-top: 3mm; }
  .sign .space { height: 15mm; }
`;

function render(d) {
  const rows = Array.from({ length: ROWS }, () => "<tr><td></td><td></td><td></td></tr>").join("\n    ");
  const terms = esc(TERMS_URL.replace(/^https:\/\//, ""));

  return page({
    title: "Leveringsbon",
    nummer: d.nummer,
    meta: [
      ["Datum", d.datum],
      ["Factuur", d.factuur],
    ],
    party: {
      title: "Klant",
      rows: [
        ["Naam", d.naam],
        ["Adres", d.adres],
        ["Postcode en gemeente", d.gemeente],
        ["E-mail of telefoon", d.contact],
        ["Btw-nummer", d.btw],
      ],
    },
    css: CSS,
    body: `
  <table class="items">
    <tr><th>Beschrijving</th><th>Serienummer</th><th class="num">Aantal</th></tr>
    ${rows}
  </table>

  <div class="section delivery">
    <strong>Levering</strong>
    ${check(false)}Afgehaald in Wuustwezel<br>
    ${check(false)}Geleverd op ${field("")}
  </div>

  <div class="section lines">
    <strong>Opmerkingen</strong>
    ${field("")}${field("")}
  </div>

  <p class="receipt">De klant verklaart de goederen hierboven volledig en in goede staat ontvangen te hebben. Ze blijven eigendom van AFTER DARK tot de volledige prijs betaald is.</p>

  <div class="sign">
    <div><div class="who">Klant</div><div class="hint">Naam, datum en handtekening voor ontvangst</div><div class="space"></div></div>
    <div><div class="who">AFTER DARK</div><div class="hint">David Spiessens</div><div class="space"></div></div>
  </div>
`,
    footer: `Op deze levering zijn de algemene voorwaarden van AFTER DARK van toepassing: <a href="${esc(TERMS_URL)}" style="color:inherit">${terms}</a>`,
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = args.out || path.join("leveringsbonnen", `${args.nummer || "leeg"}.pdf`);
  console.log(printPdf(render(args), out));
}

main();
