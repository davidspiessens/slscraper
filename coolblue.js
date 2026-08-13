/**
 * Scrapet "Tweedekans" (refurbished) aanbiedingen van coolblue.be voor een
 * vaste lijst pagina's en slaat de tweedekans-prijs op in de database.
 * Coolblue heeft twee verschillende paginatypes voor tweedekans-aanbiedingen,
 * elk met een andere HTML-structuur:
 *
 * - "search": een zoekresultatenpagina (bv. "tweedekans mac" laptops). Elke
 *   productkaart toont de normale prijs plus een apart "Voordelige
 *   Tweedekans van X,-"-linkje naar het tweedekans-aanbod.
 * - "category": een specifieke tweedekans-categoriepagina (bv. tweedekans
 *   Apple-desktops). Elke kaart toont daar de tweedekans-prijs al meteen
 *   zelf (naast de doorgestreepte normale prijs), geen apart linkje nodig.
 *
 * In beide gevallen bewaren we de tweedekans-prijs als priceNow (en de
 * normale prijs als priceOriginal, indien aanwezig). Coolblue-prijzen zijn
 * consumentenprijzen incl. BTW, maar de hele database (en de incl./excl.-
 * toggle in de PHP-UI) gaat uit van prijzen excl. BTW — dus hier terugrekenen
 * vóór het opslaan.
 *
 * Van elk gevonden product wordt ook de detailpagina bezocht om te checken
 * op extra staat/prijs-varianten van hetzelfde basisproduct (zie
 * extractVariants) — dat kost één extra paginabezoek per product, maar
 * anders missen we de andere, vaak goedkopere tweedekans-eenheden van
 * dezelfde productlijst-/zoekpagina. Een detailpagina kan ook een los
 * "Staat"-fieldset hebben (conditie-categorie, bv. "Zichtbaar beschadigd"
 * vs "Onbeschadigd") dat bepaalt welke varianten de "Variant"-fieldset
 * toont — daarom wordt elke "Staat"-optie aangeklikt en telkens opnieuw
 * gelezen (zie expandWithVariants), anders blijven varianten onder een
 * niet-standaard "Staat"-optie onzichtbaar.
 *
 * Uitvoeren:
 *     node coolblue.js
 */

const { chromium } = require("playwright");
const pool = require("./db");
const { log } = require("./logger");

const BASE_URL = "https://www.coolblue.be";
const SUPPLIER = 13; // Coolblue
// Coolblue toont prijzen incl. BTW; database/UI gaan uit van excl. BTW.
const VAT_RATE = 1.21;
// Zoals bij de andere scrapers: 30s tussen requests om geen argwaan te wekken.
const REQUEST_DELAY_MS = 30000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PRODUCT_CARD_SELECTOR = ".product-card";

// Vaste lijst pagina's — geen doorlopende catalogus, dus geen paginering
// zoals bij de andere scrapers. Elk paar (url, type) bepaalt welke
// extractielogica in getProductsOnPage gebruikt wordt.
const TARGETS = [
  { url: `${BASE_URL}/nl/zoeken/producttype:laptops?query=tweedekans%20mac`, type: "search" },
  { url: `${BASE_URL}/nl/desktops/apple/tweedekans`, type: "category" },
  { url: `${BASE_URL}/nl/dj-gear/tweedekans`, type: "category" },
];

/** "718,-" of "1.470,-" -> 718 / 1470 (punt = duizendtal, geen decimalen). */
function parsePrice(text) {
  if (!text) return null;
  const cleaned = text
    .replace(/van/i, "")
    .replace(/[^\d.,]/g, "")
    .replace(/,-?$/, "")
    .replace(/\./g, "");
  const value = parseFloat(cleaned);
  return isNaN(value) ? null : value;
}

/** search-paginatype: apart "Voordelige Tweedekans"-linkje + prijs. */
function extractSearchPageProducts(cardSelector) {
  const results = [];
  const cards = document.querySelectorAll(cardSelector);

  cards.forEach((card) => {
    const tweedekansLink = Array.from(card.querySelectorAll("a")).find((a) =>
      a.textContent.includes("Tweedekans")
    );
    if (!tweedekansLink) return;

    const href = tweedekansLink.getAttribute("href");
    const idMatch = href ? href.match(/\/tweedekans-product\/(\d+)/) : null;
    const id = idMatch ? idMatch[1] : null;
    const url = href ? (href.startsWith("http") ? href : location.origin + href) : null;

    const strong = tweedekansLink.parentElement
      ? tweedekansLink.parentElement.querySelector("strong")
      : null;
    const priceNow = strong ? parsePrice(strong.textContent) : null;

    const titleEl = card.querySelector(".product-card__title a, .product-card__title");
    const title = titleEl ? titleEl.textContent.trim() : null;

    const salesPriceEl = card.querySelector(".sales-price");
    const priceOriginal = salesPriceEl ? parsePrice(salesPriceEl.textContent) : priceNow;

    if (id && title && url && priceNow != null) {
      results.push({ id, title, priceOriginal, priceNow, discount: "Tweedekans", url });
    }
  });

  return results;
}

/**
 * category-paginatype: de kaart toont de tweedekans-prijs meteen zelf, samen
 * met de doorgestreepte normale prijs. De CSS-klassen zijn React/emotion
 * hash-klassen (bv. "css-1c1ve67") die bij elke Coolblue-deploy kunnen
 * wijzigen — behalve op de prijs-container zit ook een stabiele, semantische
 * klassenaam ("product-card-price-and-atc-slice"), die als ankerpunt
 * gebruikt wordt. De titel komt uit de <img alt> (stabieler dan de diep
 * geneste linktekst). De url bevat twee ID's ("/product-tweedekans/BASISID/
 * TWEEDEKANSID"); het tweede is het tweedekans-specifieke aanbod-ID.
 */
function extractCategoryPageProducts(cardSelector) {
  const results = [];
  const cards = document.querySelectorAll(cardSelector);

  cards.forEach((card) => {
    const link = card.querySelector('a[href*="/product-tweedekans/"]');
    const href = link ? link.getAttribute("href") : null;
    const idMatch = href ? href.match(/\/product-tweedekans\/\d+\/(\d+)/) : null;
    const id = idMatch ? idMatch[1] : null;
    const url = href ? (href.startsWith("http") ? href : location.origin + href) : null;

    const title = card.querySelector("img[alt]")?.alt?.trim() || null;

    const priceContainer = card.querySelector('[class*="product-card-price-and-atc-slice"]');
    const priceLines = priceContainer
      ? priceContainer.innerText
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => /^\d[\d.]*,-$/.test(s))
      : [];
    const prices = priceLines.map(parsePrice).filter((v) => v != null);
    // Bij korting: [normale prijs, tweedekans-prijs]. Zonder korting: [prijs].
    const priceOriginal = prices.length >= 2 ? prices[0] : prices[0] ?? null;
    const priceNow = prices.length >= 2 ? prices[1] : prices[0] ?? null;

    if (id && title && url && priceNow != null) {
      results.push({ id, title, priceOriginal, priceNow, discount: "Tweedekans", url });
    }
  });

  return results;
}

/**
 * Detailpagina van een tweedekans-product toont soms een "Variant"-fieldset
 * met meerdere staat/prijs-varianten van hetzelfde basisproduct (bv. "licht
 * beschadigd" voor €291 vs "gerepareerd" voor €282) — elke variant heeft een
 * eigen tweedekans-ID en is los navigeerbaar via
 * "/product-tweedekans/{basisID}/{variantID}". De standaardvariant op de
 * lijst-/zoekpagina is er maar één van; deze functie haalt de varianten op
 * die momenteel in de "Variant"-fieldset staan. Retourneert [] als die er
 * niet is.
 *
 * Belangrijk: er zit vaak ook een apart "Staat"-fieldset bovenaan (bv.
 * "Zichtbaar beschadigd" vs "Onbeschadigd") dat bepaalt WELKE varianten in
 * de "Variant"-fieldset getoond worden — deze functie leest enkel de
 * huidig zichtbare selectie. Om alles te vinden moet aanroepende code elke
 * "Staat"-optie aanklikken en telkens opnieuw extractVariants() aanroepen
 * (zie expandWithVariants).
 */
function extractVariants() {
  const legend = Array.from(document.querySelectorAll("legend")).find(
    (el) => el.textContent.trim() === "Variant"
  );
  const fieldset = legend ? legend.closest("fieldset") : null;
  if (!fieldset) return [];

  const variants = [];
  Array.from(fieldset.children).forEach((div) => {
    const radio = div.querySelector('input[type="radio"]');
    if (!radio || !radio.value) return;
    // "282,-9,- minder" -> eerste match ("282,-") is de eigen prijs van deze
    // variant, een eventuele tweede match is het besparingsbedrag t.o.v. de
    // duurste variant, niet de prijs zelf.
    const priceMatches = div.innerText.match(/\d[\d.]*,-/g) || [];
    const priceText = priceMatches[0] || null;
    if (priceText) {
      variants.push({ id: radio.value, priceText });
    }
  });
  return variants;
}

/** Geeft de waarden van het "Staat"-fieldset (conditie-categorie) terug, of [] als dat er niet is. */
function getStaatOptionValues() {
  const legend = Array.from(document.querySelectorAll("legend")).find(
    (el) => el.textContent.trim() === "Staat"
  );
  const fieldset = legend ? legend.closest("fieldset") : null;
  if (!fieldset) return [];
  return Array.from(fieldset.querySelectorAll('input[type="radio"]'))
    .map((r) => r.value)
    .filter(Boolean);
}

/**
 * Haal alle productkaarten met een tweedekans-aanbod op de pagina op.
 * parsePrice/extractSearchPageProducts/extractCategoryPageProducts draaien
 * in de browsercontext (page.evaluate) en hebben geen toegang tot Node-side
 * functies — daarom worden hun broncodes hier letterlijk mee ingebouwd via
 * .toString() als geneste functies, i.p.v. ze los te injecteren (dat bleek
 * niet globaal beschikbaar te blijven tussen navigaties).
 */
async function getProductsOnPage(page, type) {
  const body = `
    ${parsePrice.toString()}
    ${extractSearchPageProducts.toString()}
    ${extractCategoryPageProducts.toString()}
    return pageType === "category"
      ? extractCategoryPageProducts(cardSelector)
      : extractSearchPageProducts(cardSelector);
  `;
  const dispatch = new Function("args", `const { cardSelector, pageType } = args;\n${body}`);
  return page.evaluate(dispatch, { cardSelector: PRODUCT_CARD_SELECTOR, pageType: type });
}

/**
 * Bezoekt de detailpagina van prod en geeft alle varianten terug over ALLE
 * "Staat"-categorieën heen (elke "Staat"-optie aanklikken toont een andere
 * set in de "Variant"-fieldset — zie extractVariants), elk met hun eigen
 * id/url/prijs maar dezelfde titel en normale (excl.-korting)
 * referentieprijs als prod. Geeft gewoon [prod] terug als er geen
 * "Variant"-fieldset is, of bij een laadfout.
 */
async function expandWithVariants(page, prod) {
  const baseIdMatch = prod.url.match(/\/product-tweedekans\/(\d+)\//);
  if (!baseIdMatch) return [prod];
  const baseId = baseIdMatch[1];

  try {
    await page.goto(prod.url, { waitUntil: "networkidle", timeout: 30000 });
  } catch (err) {
    console.log(`  ⚠ Kon detailpagina niet laden voor variant-check: ${prod.url}`);
    return [prod];
  }

  // De "Variant"-fieldset (en het optionele "Staat"-fieldset) laadt
  // asynchroon ná networkidle (client-side hydration/fetch), en de duur
  // daarvan is niet vast — een blinde vaste wachttijd bleek soms niet
  // genoeg. Actief pollen op de aanwezigheid van de legend is robuuster.
  try {
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll("legend")).some((el) => el.textContent.trim() === "Variant"),
      { timeout: 10000 }
    );
  } catch (err) {
    // Geen "Variant"-fieldset binnen 10s verschenen — waarschijnlijk heeft
    // dit product er gewoon geen (normaal geval), extractVariants() geeft
    // dan terecht [] terug.
  }

  // De "Staat"-fieldset rendert soms pas ná de "Variant"-fieldset (aparte
  // hydration/fetch) — zonder deze extra wacht leest getStaatOptionValues()
  // hieronder soms te vroeg [] uit, waardoor nooit op de andere staat-optie
  // geklikt wordt en varianten onder die staat blijvend gemist worden (ze
  // worden dan na verloop van tijd stil gearchiveerd wegens geen prijs-
  // update meer, zie ook: id 13283 "AlphaTheta Omnis-Duo" bleef steken
  // terwijl 13270, dezelfde base-product/andere staat, wel bleef bijwerken).
  try {
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll("legend")).some((el) => el.textContent.trim() === "Staat"),
      { timeout: 5000 }
    );
  } catch (err) {
    // Geen "Staat"-fieldset binnen 5s verschenen — normaal geval voor
    // producten zonder conditie-variant.
  }

  const readVariants = new Function(`
    ${parsePrice.toString()}
    ${extractVariants.toString()}
    return extractVariants();
  `);
  const readStaatValues = new Function(`
    ${getStaatOptionValues.toString()}
    return getStaatOptionValues();
  `);

  const staatValues = await page.evaluate(readStaatValues);

  // Playwright's page.click() simuleert een echte muisklik op de
  // schermcoördinaten van het element — dat faalt of doet niets bij deze
  // radio's (waarschijnlijk visueel verborgen/overlapt door een custom
  // stijllaag). Een rechtstreekse DOM .click()-aanroep via page.evaluate
  // werkt wel (bevestigd tijdens handmatig testen) en triggert React's
  // synthetic event alsnog, want React luistert op het native click-event.
  const clickStaatOption = new Function(
    "value",
    `
    const radio = document.querySelector('input[value="' + value + '"]');
    if (!radio) return false;
    radio.click();
    return true;
    `
  );

  const variantsById = new Map();
  const collect = async () => {
    const variants = await page.evaluate(readVariants);
    for (const v of variants) {
      variantsById.set(v.id, v);
    }
  };

  if (staatValues.length === 0) {
    await collect();
  } else {
    for (let i = 0; i < staatValues.length; i++) {
      const staatValue = staatValues[i];
      if (i > 0) {
        // 30s tussen requests — klikken op een "Staat"-optie triggert een
        // nieuwe data-fetch voor de bijhorende varianten.
        await sleep(REQUEST_DELAY_MS);
      }
      const clicked = await page.evaluate(clickStaatOption, staatValue);
      if (!clicked) {
        console.log(`  ⚠ "Staat"-optie "${staatValue}" niet gevonden voor ${prod.url}`);
        continue;
      }
      await page.waitForTimeout(1000);
      await collect();
    }
  }

  const variants = [...variantsById.values()];
  if (variants.length === 0) {
    return [prod];
  }

  return variants.map((v) => ({
    ...prod,
    id: v.id,
    priceNow: parsePrice(v.priceText),
    url: `${BASE_URL}/nl/product-tweedekans/${baseId}/${v.id}`,
  }));
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
    if (!prod.id || !prod.title || !prod.url || prod.priceNow == null) {
      skipped += 1;
      continue;
    }

    const productId = await getOrCreateProductId(prod);

    try {
      await pool.query(
        "INSERT INTO bstock_product_price (bstock_product_id, priceOriginal, priceNow, discount_label) VALUES (?, ?, ?, ?)",
        [productId, prod.priceOriginal ?? prod.priceNow, prod.priceNow, prod.discount || ""]
      );
      saved += 1;
    } catch (error) {
      console.error(error);
    }
  }

  if (skipped > 0) {
    console.log(`  ⚠ ${skipped} product(en) overgeslagen wegens ontbrekende velden.`);
  }

  return saved;
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

  await log(SUPPLIER, "Start van coolblue.js", "start");

  let totalFound = 0;
  let totalSaved = 0;
  let isFirstRequest = true;

  for (const { url, type } of TARGETS) {
    if (!isFirstRequest) {
      console.log("  ⏳ 30s wachten voor volgende request...");
      await sleep(REQUEST_DELAY_MS);
    }
    isFirstRequest = false;

    console.log(`Ophalen (${type}): ${url}`);
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

    try {
      await page.waitForSelector(PRODUCT_CARD_SELECTOR, { timeout: 15000 });
    } catch (err) {
      console.log("  ⚠ Geen productkaarten gevonden op deze pagina.");
      await log(SUPPLIER, `Waarschuwing: geen productkaarten gevonden voor (${type}) op ${url}, pagina overgeslagen.`, "warning");
      continue;
    }

    const scraped = await getProductsOnPage(page, type);
    console.log(`  → ${scraped.length} tweedekans-aanbieding(en) gevonden.`);
    totalFound += scraped.length;

    // Elk gevonden product z'n detailpagina bezoeken om te checken op extra
    // staat/prijs-varianten van hetzelfde basisproduct (zie extractVariants).
    const expanded = [];
    for (const prod of scraped) {
      console.log("  ⏳ 30s wachten voor volgende request...");
      await sleep(REQUEST_DELAY_MS);
      const variants = await expandWithVariants(page, prod);
      expanded.push(...variants);
    }
    if (expanded.length > scraped.length) {
      console.log(`  → ${expanded.length - scraped.length} extra variant(en) gevonden via detailpagina's.`);
    }

    // Coolblue toont incl. BTW; terugrekenen naar excl. BTW zoals de rest van de database.
    const products = expanded.map((prod) => ({
      ...prod,
      priceOriginal: prod.priceOriginal != null ? Math.round((prod.priceOriginal / VAT_RATE) * 100) / 100 : null,
      priceNow: prod.priceNow != null ? Math.round((prod.priceNow / VAT_RATE) * 100) / 100 : null,
    }));

    const saved = await saveProducts(products);
    totalSaved += saved;
    await log(SUPPLIER, `Pagina (${type}) ${url}: ${scraped.length} gevonden, ${saved} opgeslagen`);
  }

  await browser.close();

  console.log(`\n✓ ${totalSaved} product(en) opgeslagen in de database (${totalFound} gevonden).`);
  await log(SUPPLIER, `Einde van coolblue.js: ${totalSaved} opgeslagen (${totalFound} gevonden)`, "success");

  await pool.end();
}

scrape().catch(async (err) => {
  console.error(err);
  await log(SUPPLIER, `Fout in coolblue.js: ${err.message}`, "error");
  process.exit(1);
});
