/**
 * Scrapet tweedehands aanbiedingen van connect.kinxsound.com/listings en
 * slaat ze op in de database. Dit is een apart marktplaats-platform van
 * KinxSound (meerdere externe verkopers, niet enkel KinxSound's eigen
 * voorraad zoals bij shop.kinxsound.com/shop, zie kinxsound.js) — vandaar een
 * eigen supplier_id i.p.v. hergebruik van SUPPLIER=12.
 *
 * Prijzen staan al excl. BTW op de site ("Price excl. VAT" op de
 * detailpagina), dus geen omrekening nodig. Sommige listings tonen "Price on
 * inquiry" i.p.v. een bedrag, of een bedrag in een andere munteenheid dan
 * euro (bv. Zwitserse/Deense verkopers) — die worden overgeslagen omdat er
 * geen betrouwbare eurowaarde uit af te leiden is, net als elders in deze
 * scrapers bij ontbrekende velden.
 *
 * De site (Livewire/Alpine, geen React) heeft geen stabiele CSS-klasse op de
 * productkaarten (enkel Tailwind-utilityklassen die bij een volgende
 * layoutwissel kunnen veranderen) — daarom wordt op het href-patroon van de
 * kaart-link gefilterd (drie padsegmenten: /categorie/subcategorie/slug)
 * i.p.v. op een CSS-selector, en op de aanwezigheid van zo'n link gewacht
 * via waitForFunction i.p.v. waitForSelector (zie ook coolblue.js voor
 * hetzelfde patroon bij een site zonder stabiele klasse).
 *
 * Uitvoeren:
 *     node kinxsoundconnect.js [startpagina]
 */

const { chromium } = require("playwright");
const pool = require("./db");
const { log } = require("./logger");

const startPage = process.argv[2] ? parseInt(process.argv[2], 10) : 1;
if (!Number.isInteger(startPage) || startPage < 1) {
  console.error("Gebruik: node kinxsoundconnect.js [startpagina]");
  console.error("Startpagina moet een geheel getal groter dan of gelijk aan 1 zijn.");
  process.exit(1);
}

const BASE_URL = "https://connect.kinxsound.com";
// sort=price_desc i.p.v. de standaard "Most viewed": die laatste kan tussen
// twee paginaverzoeken door verschuiven (bekeken-aantallen wijzigen live),
// waardoor listings tussen pagina's kunnen verspringen of gemist worden.
const QUERY = "sort=price_desc";
const START_URL = `${BASE_URL}/listings?${QUERY}${startPage > 1 ? `&page=${startPage}` : ""}`;
const SUPPLIER = 16; // KinxSound Connect

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Herkent een link naar een listing-detailpagina (bv.
// "/audio/speakers/l-acoustics-8xt-sckqdpmq"), ter onderscheid van de
// nav-/categorielinks ("/audio", "/audio/speakers") die maar 1 of 2
// padsegmenten hebben.
const LISTING_HREF_REGEX = /^https:\/\/connect\.kinxsound\.com\/[a-z-]+\/[a-z-]+\/[a-z0-9-]+$/;

/** Haal alle productkaarten op de huidige pagina op. */
async function getProductsOnPage(page) {
  return page.evaluate(
    ({ hrefRegexSource }) => {
      // Zet een Euro-geformatteerd prijsgetal ("8.299,00" of "80.000") om
      // naar een float. "Price on inquiry" (geen cijfers) geeft null terug.
      function parsePrice(text) {
        if (!text) return null;
        // Enkel euro-bedragen parsen: sellers buiten de eurozone tonen hun
        // eigen munteenheid (bv. "Fr 189.000" CHF, "kr 700.000" DKK) — zonder
        // deze check zou zo'n bedrag als eurobedrag worden opgeslagen, wat
        // sterk zou afwijken van de werkelijke waarde.
        if (!/€/.test(text)) return null;
        const normalized = text.replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
        const value = parseFloat(normalized);
        return isNaN(value) ? null : value;
      }

      const hrefRegex = new RegExp(hrefRegexSource);
      const results = [];
      const links = Array.from(document.querySelectorAll("main a[href]")).filter((a) =>
        hrefRegex.test(a.getAttribute("href") || "")
      );

      links.forEach((card) => {
        const url = card.href;

        // --- Product-ID: het willekeurige suffix van de kaart-link zelf
        // (bv. "l-acoustics-8xt-sckqdpmq" -> "sckqdpmq"), altijd 8
        // alfanumerieke tekens aan het eind van het pad. ---
        const idMatch = url.match(/-([a-z0-9]{8})$/i);
        const id = idMatch ? idMatch[1] : null;

        // --- Titel ---
        const titleEl = card.querySelector("h3");
        const title = titleEl ? titleEl.textContent.trim() : null;

        // --- Prijs: één prijs per listing (geen van/nu-korting). Kan null
        // zijn bij "Price on inquiry" of een niet-euro bedrag (zie parsePrice). ---
        const priceEl = card.querySelector("span.text-lg.font-bold");
        const price = priceEl ? parsePrice(priceEl.textContent) : null;

        // --- Conditie-badge (bv. "Very Good Condition", "Heavily Used") —
        // geen echte korting, maar hergebruikt discount_label omdat er geen
        // beter passende kolom is (vgl. xlrpro's "Sold out"-ribbon). ---
        const conditionEl = card.querySelector(".absolute.top-2\\.5.right-2\\.5");
        const condition = conditionEl ? conditionEl.textContent.trim() || null : null;

        if (id && title && url && price != null) {
          results.push({ id, title, priceOriginal: price, priceNow: price, discount: condition, url });
        }
      });

      return results;
    },
    { hrefRegexSource: LISTING_HREF_REGEX.source }
  );
}

/** Zoekt een bestaand product op basis van supplier + supplier_product_id, of maakt het aan. */
async function getOrCreateProductId(prod) {
  const [rows] = await pool.query(
    "SELECT id FROM bstock_product WHERE supplier_id = ? AND supplier_product_id = ? LIMIT 1",
    [SUPPLIER, prod.id]
  );
  if (rows.length > 0) {
    return rows[0].id;
  }

  const [result] = await pool.query(
    "INSERT INTO bstock_product (supplier_id, supplier_product_id, title, url) VALUES (?, ?, ?, ?)",
    [SUPPLIER, prod.id, prod.title, prod.url]
  );
  return result.insertId;
}

/** Slaat producten en hun prijzen op in de database. */
async function saveProducts(products) {
  let saved = 0;
  let skipped = 0;

  for (const prod of products) {
    if (!prod.id || !prod.title || !prod.url) {
      skipped += 1;
      continue;
    }
    if (prod.priceOriginal == null || prod.priceNow == null) {
      skipped += 1;
      continue;
    }

    const productId = await getOrCreateProductId(prod);

    try {
      await pool.query(
        "INSERT INTO bstock_product_price (bstock_product_id, priceOriginal, priceNow, discount_label) VALUES (?, ?, ?, ?)",
        [productId, prod.priceOriginal, prod.priceNow, prod.discount || ""]
      );
      saved += 1;
    } catch (error) {
      console.error(error);
    }
  }

  if (skipped > 0) {
    console.log(`  ⚠ ${skipped} product(en) overgeslagen wegens ontbrekende velden (bv. "Price on inquiry").`);
  }

  return saved;
}

/** Geeft de URL van de volgende pagina, of null als er geen is. */
async function getNextPageUrl(page) {
  const nextHref = await page.evaluate(() => {
    const btn = document.querySelector('a[rel="next"]');
    return btn ? btn.getAttribute("href") : null;
  });

  if (nextHref) {
    return nextHref.startsWith("http") ? nextHref : BASE_URL + nextHref;
  }
  return null;
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

  await log(SUPPLIER, "Start van kinxsoundconnect.js", "start");

  let currentUrl = START_URL;
  let pageNum = startPage;
  let totalFound = 0;
  let totalSaved = 0;
  const seen = new Set();

  while (currentUrl) {
    console.log(`Pagina ${pageNum}: ${currentUrl}`);
    await page.goto(currentUrl, { waitUntil: "load", timeout: 30000 });

    try {
      await page.waitForFunction(
        (hrefRegexSource) => {
          const hrefRegex = new RegExp(hrefRegexSource);
          return Array.from(document.querySelectorAll("main a[href]")).some((a) =>
            hrefRegex.test(a.getAttribute("href") || "")
          );
        },
        LISTING_HREF_REGEX.source,
        { timeout: 15000 }
      );
    } catch (err) {
      console.log("  ⚠ Geen productkaarten gevonden op deze pagina.");
      await log(SUPPLIER, `Waarschuwing: geen productkaarten gevonden op pagina ${pageNum} (${currentUrl}), scrape gestopt.`, "warning");
      break;
    }

    const products = await getProductsOnPage(page);
    totalFound += products.length;

    // Dedupliceren op url (of titel als fallback), ook over pagina's heen
    const unique = [];
    for (const prod of products) {
      const key = prod.url || prod.title;
      if (key && !seen.has(key)) {
        seen.add(key);
        unique.push(prod);
      }
    }

    const saved = await saveProducts(unique);
    totalSaved += saved;
    console.log(`  → ${products.length} producten gevonden, ${saved} opgeslagen (totaal opgeslagen: ${totalSaved})`);
    await log(SUPPLIER, `Pagina ${pageNum}: ${products.length} gevonden, ${saved} opgeslagen`);

    const nextUrl = await getNextPageUrl(page);
    currentUrl = nextUrl && nextUrl !== currentUrl ? nextUrl : null;
    pageNum += 1;

    if (currentUrl) {
      console.log("  ⏳ 30s wachten voor volgende pagina...");
      await sleep(30000);
    }
  }

  await browser.close();

  console.log(`\n✓ ${totalSaved} product(en) opgeslagen in de database (${totalFound} gevonden)`);
  await log(SUPPLIER, `Einde van kinxsoundconnect.js: ${totalSaved} opgeslagen (${totalFound} gevonden)`, "success");

  await pool.end();
}

scrape().catch(async (err) => {
  console.error(err);
  await log(SUPPLIER, `Fout in kinxsoundconnect.js: ${err.message}`, "error");
  process.exit(1);
});
