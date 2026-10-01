/**
 * EENMALIG script: scrapet het hoogste/huidige bod van alle kavels uit alle
 * GESLOTEN veilingen op audiovisual-auctions.com en slaat ze op in de
 * database. Bedragen staan excl. BTW en excl. veilingkosten — het
 * veilingkostenpercentage staat per kavel vermeld (her en der verschillend,
 * her waargenomen 18%) en wordt dus per kavel uitgelezen i.p.v. hardcoded.
 * Wij verhogen elk bod met dat percentage en vermelden dat in discount_label
 * ("incl. X% veilingkost").
 *
 * Alle veilingen die dit script bekijkt zijn al gesloten — de uitslag
 * verandert niet meer — dus dit is een eenmalige historische import, geen
 * terugkerende scrape. Dit script hoort daarom NIET thuis in run.sh en moet
 * handmatig gedraaid worden.
 *
 * Site-eigenaardigheden:
 * - Zowel de veilinglijst (homepage) als de kavellijst (dashboard) tonen maar
 *   een deel van de resultaten; de rest laadt pas bij scrollen (oneindig
 *   scrollen, geen "Load more"-knop of paginanummers).
 * - Het bodbedrag ÉN het veilingkostenpercentage op de kaveldetailpagina
 *   staan niet in de server-HTML (lege <span id="currentBid">/
 *   <span id="buyersPremium">) — ze worden na page load ingevuld via een
 *   live SignalR/Blazor-verbinding. Er is geen hardcoded placeholder-bug
 *   zoals bij CueSale Veilingen, maar wél moet er gewacht worden tot de
 *   span niet meer leeg is voor het bedrag uitgelezen wordt, anders krijg je
 *   gewoon niets.
 * - Hervatbaar: als een kavel al een prijs heeft (van een eerdere,
 *   onderbroken run), wordt de detailpagina niet opnieuw bezocht.
 *
 * Uitvoeren:
 *     node audiovisualauctions.js
 */

const { chromium } = require("playwright");
const pool = require("./db");
const { log } = require("./logger");
const { parseQuantity } = require("./quantity");

const BASE_URL = "https://www.audiovisual-auctions.com";
const SUPPLIER = 20; // Audiovisual Auctions

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// "2.000,00 €" -> 2000 (punt = duizendtal, komma = decimalen — zelfde formaat
// als bv. cuesale.js, in tegenstelling tot de "€ 4500"-stijl van CueSale
// Veilingen/Pro Applestar).
function parsePrice(text) {
  if (!text) return null;
  const normalized = text.replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
  const value = parseFloat(normalized);
  return isNaN(value) ? null : value;
}

function parsePercentage(text) {
  if (!text) return null;
  const match = text.match(/([\d.,]+)\s*%/);
  if (!match) return null;
  const value = parseFloat(match[1].replace(",", "."));
  return isNaN(value) ? null : value;
}

/** Haalt de dashboardlinks van alle GESLOTEN veilingen op van de homepage (niet "Aankomende veilingen"). */
async function getClosedAuctionUrls(page) {
  await page.goto(`${BASE_URL}/nl`, { waitUntil: "load", timeout: 30000 });
  // De veilingkaarten op de homepage druppelen na page load binnen via
  // dezelfde live verbinding als de bod-data op de detailpagina's — ze komen
  // niet allemaal tegelijk. Eén enkele waitForSelector (die al bij de eerste
  // kaart resolvet) is dus niet genoeg: wachten tot het aantal links twee
  // metingen na elkaar gelijk blijft.
  await page.waitForSelector('a[href*="auctionid="]', { timeout: 15000 });
  let prevCount = -1;
  let stable = 0;
  for (let i = 0; i < 20 && stable < 3; i++) {
    const count = await page.evaluate(() => document.querySelectorAll('a[href*="auctionid="]').length);
    stable = count === prevCount ? stable + 1 : 0;
    prevCount = count;
    await sleep(500);
  }

  const hrefs = await page.evaluate(() => {
    const heading = Array.from(document.querySelectorAll("*")).find(
      (e) => e.children.length === 0 && /Gesloten Veilingen/i.test(e.textContent.trim())
    );
    if (!heading) return [];
    const links = Array.from(document.querySelectorAll('a[href*="auctionid="]'));
    const after = links.filter((a) => heading.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);
    return [...new Set(after.map((a) => a.getAttribute("href")))];
  });
  return hrefs.map((href) => (href.startsWith("http") ? href : BASE_URL + href));
}

/**
 * Scrolt net zo lang naar onder (oneindig scrollen, geen "Load more"-knop)
 * tot alle kavels van de veiling geladen zijn: aantal geladen kaarten matcht
 * de "TONEN N KAVELS"-teller, of — als die tekst niet gevonden wordt — het
 * aantal geladen kaarten stabiliseert.
 */
async function loadAllLotsOnDashboard(page) {
  const expectedTotal = await page.evaluate(() => {
    const match = document.body.innerText.match(/TONEN\s+(\d+)\s+KAVELS/i);
    return match ? parseInt(match[1], 10) : null;
  });

  let prevCount = -1;
  let stable = 0;
  let iterations = 0;
  const maxIterations = expectedTotal ? Math.ceil(expectedTotal / 10) + 20 : 80;

  while (iterations < maxIterations) {
    const count = await page.evaluate(() => document.querySelectorAll("a.lot-card-title").length);
    if (expectedTotal != null && count >= expectedTotal) break;
    stable = count === prevCount ? stable + 1 : 0;
    if (stable >= 4) break; // geen teller gevonden, of geladen aantal blijft steken
    prevCount = count;

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(600);
    iterations += 1;
  }
}

/** Haalt id/titel/url van elk kavel op van de huidige, volledig geladen kavellijst. */
async function getLotStubsOnPage(page) {
  return page.evaluate(() => {
    const results = [];
    const links = document.querySelectorAll("a.lot-card-title");

    links.forEach((linkEl) => {
      const url = linkEl.href;
      const idMatch = url.match(/\/lot-details\/(\d+)\//);
      const id = idMatch ? idMatch[1] : null;
      const title = linkEl.textContent.trim();

      if (id && title && url) {
        results.push({ id, title, url });
      }
    });

    return results;
  });
}

/**
 * Bezoekt de detailpagina van één kavel en wacht tot het bod-element via de
 * live verbinding ingevuld is. Blijft het leeg tot de timeout, dan heeft dit
 * kavel geen enkel bod gekregen.
 */
async function getBidForLot(page, lot) {
  await page.goto(lot.url, { waitUntil: "load", timeout: 30000 });

  try {
    await page.waitForFunction(
      () => (document.getElementById("currentBid")?.textContent || "").trim().length > 0,
      { timeout: 15000 }
    );
  } catch (err) {
    return { bidText: null, premiumText: null, timedOut: true };
  }

  const data = await page.evaluate(() => ({
    bidText: document.getElementById("currentBid")?.textContent.trim() || null,
    premiumText: document.getElementById("buyersPremium")?.textContent.trim() || null,
  }));
  return { ...data, timedOut: false };
}

/** Zoekt een bestaand product op basis van supplier + supplier_product_id, of maakt het aan. */
async function getOrCreateProductId(lot) {
  const [rows] = await pool.query(
    "SELECT id FROM bstock_product WHERE supplier_id = ? AND supplier_product_id = ? LIMIT 1",
    [SUPPLIER, lot.id]
  );
  if (rows.length > 0) {
    return rows[0].id;
  }

  const [result] = await pool.query(
    "INSERT INTO bstock_product (supplier_id, supplier_product_id, title, quantity, url) VALUES (?, ?, ?, ?, ?)",
    [SUPPLIER, lot.id, lot.title, parseQuantity(lot.title), lot.url]
  );
  return result.insertId;
}

/** true als dit kavel al een prijs heeft (eerdere, onderbroken run) — dan niet opnieuw bezoeken. */
async function alreadyScraped(productId) {
  const [rows] = await pool.query("SELECT id FROM bstock_product_price WHERE bstock_product_id = ? LIMIT 1", [
    productId,
  ]);
  return rows.length > 0;
}

async function saveLot(productId, bid, premiumPercent) {
  const priceInclVeilingkost = Math.round(bid * (1 + premiumPercent / 100) * 100) / 100;
  await pool.query(
    "INSERT INTO bstock_product_price (bstock_product_id, priceOriginal, priceNow, discount_label) VALUES (?, ?, ?, ?)",
    [productId, priceInclVeilingkost, priceInclVeilingkost, `incl. ${premiumPercent}% veilingkost`]
  );
}

async function scrape() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/124.0.0.0 Safari/537.36",
    locale: "nl-BE",
  });
  const page = await context.newPage();

  await log(SUPPLIER, "Start van audiovisualauctions.js", "start");

  const auctionUrls = await getClosedAuctionUrls(page);
  console.log(`Gevonden gesloten veilingen: ${auctionUrls.length}`);

  let totalFound = 0;
  let totalSaved = 0;
  let totalSkippedNoBid = 0;
  let totalTimedOut = 0;
  let totalAlreadyDone = 0;

  for (let i = 0; i < auctionUrls.length; i++) {
    const auctionUrl = auctionUrls[i];
    console.log(`\nVeiling ${i + 1}/${auctionUrls.length}: ${auctionUrl}`);
    await page.goto(auctionUrl, { waitUntil: "load", timeout: 30000 });

    try {
      await page.waitForSelector("a.lot-card-title", { timeout: 15000 });
    } catch (err) {
      console.log("  ⚠ Geen kavels gevonden op deze veiling.");
      await log(SUPPLIER, `Waarschuwing: geen kavels gevonden op ${auctionUrl}, overgeslagen.`, "warning");
      continue;
    }

    await loadAllLotsOnDashboard(page);
    const lots = await getLotStubsOnPage(page);
    totalFound += lots.length;
    console.log(`  → ${lots.length} kavels gevonden, bod per kavel ophalen...`);

    let saved = 0;
    let skippedNoBid = 0;
    let timedOut = 0;
    let alreadyDone = 0;

    for (let j = 0; j < lots.length; j++) {
      const lot = lots[j];
      const productId = await getOrCreateProductId(lot);

      if (await alreadyScraped(productId)) {
        alreadyDone += 1;
      } else {
        const { bidText, premiumText, timedOut: didTimeOut } = await getBidForLot(page, lot);

        if (didTimeOut) {
          timedOut += 1;
        } else {
          const bid = parsePrice(bidText);
          const premiumPercent = parsePercentage(premiumText);
          if (bid == null || premiumPercent == null) {
            skippedNoBid += 1;
          } else {
            await saveLot(productId, bid, premiumPercent);
            saved += 1;
          }
        }

        // Lichte pagina, maar wel een live SignalR-verbinding per bezoek —
        // een korte pauze i.p.v. de 30s die elders tussen volledige
        // catalogus-pagina's gehanteerd wordt.
        await sleep(400);
      }

      if ((j + 1) % 100 === 0 || j === lots.length - 1) {
        console.log(
          `    ${j + 1}/${lots.length} kavels verwerkt (${saved} opgeslagen, ${alreadyDone} al gedaan, ${skippedNoBid} zonder bod, ${timedOut} timeout)`
        );
        await log(
          SUPPLIER,
          `${auctionUrl}: ${j + 1}/${lots.length} kavels verwerkt (${saved} opgeslagen, ${alreadyDone} al gedaan, ${skippedNoBid} zonder bod, ${timedOut} timeout)`
        );
      }
    }

    totalSaved += saved;
    totalSkippedNoBid += skippedNoBid;
    totalTimedOut += timedOut;
    totalAlreadyDone += alreadyDone;
    console.log(
      `  ✓ Veiling klaar: ${saved} opgeslagen, ${alreadyDone} al gedaan, ${skippedNoBid} zonder bod, ${timedOut} timeout`
    );
    await log(
      SUPPLIER,
      `${auctionUrl}: klaar — ${saved} opgeslagen, ${alreadyDone} al gedaan, ${skippedNoBid} zonder bod, ${timedOut} timeout`
    );
  }

  await browser.close();

  console.log(
    `\n✓ ${totalSaved} kavel(s) opgeslagen (${totalFound} gevonden, ${totalAlreadyDone} al gedaan, ${totalSkippedNoBid} zonder bod, ${totalTimedOut} timeout)`
  );
  await log(
    SUPPLIER,
    `Einde van audiovisualauctions.js: ${totalSaved} opgeslagen (${totalFound} gevonden, ${totalAlreadyDone} al gedaan, ${totalSkippedNoBid} zonder bod, ${totalTimedOut} timeout)`,
    "success"
  );

  await pool.end();
}

scrape().catch(async (err) => {
  console.error(err);
  await log(SUPPLIER, `Fout in audiovisualauctions.js: ${err.message}`, "error");
  process.exit(1);
});
