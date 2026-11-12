# CLAUDE.md

Werkinfo voor Claude. Twee projecten horen samen:

- **baxscraper** (deze repo): Node.js-scrapers voor B-stock/occasions, een MySQL-database met producten, aankopen en verkopen, en scripts die verkoopproducten op after-dark.be aanmaken.
- **after-dark.be**: WooCommerce-site (verhuur én verkoop van DJ-gear) van AFTER DARK, Wuustwezel. Child theme: `/Users/davidspiessens/projects/after-dark.be/wp-content/themes/flatsome-after-dark/` (git-repo = de hele site-root `/Users/davidspiessens/projects/after-dark.be`).

Taal met de gebruiker en op de site: Nederlands (Vlaams).

## Afspraken

- **Niet committen** tot de gebruiker erom vraagt.
- **Theme-bestanden deployt de gebruiker zelf** naar productie. Na een wijziging: zeggen welke bestanden, en bij nieuwe `inc/`-bestanden eerst het nieuwe bestand, daarna `functions.php` (anders fatal error). Na "deployed" de live pagina controleren.
- Op productie enkel wijzigen wat gevraagd is. Producten pas publiceren als de gebruiker dat zegt.
- Credentials staan in `.env`; de gebruiker vult die zelf in. Nooit wachtwoorden of keys invullen of tonen.
- Teksten eerst als voorstel tonen, pas na akkoord op de site zetten (tenzij de gebruiker meteen "pas aan" zegt).

## Database (baxscraper)

`db.js` (mysql2 pool, `.env`: `DB_*`). Belangrijkste tabellen:

| Tabel | Inhoud |
|---|---|
| `product` | unieke producten (merk + model), `brand_id` |
| `brand`, `brand_alias` | merken en alternatieve schrijfwijzen (bv. Amcron → Crown) |
| `bstock_product` | gescrapete listings per leverancier, gekoppeld aan `product_id` |
| `product_x_supplier` | koppeling product ↔ leverancier |
| `supplier` | leveranciers (1 = Bax, …) |
| `purchase` | aankopen: `id`, `product_id`, `bstock_product_id`, `supplier_id`, `price` (excl. btw), `invoice_date`, `invoice_number` |
| `purchase_serial` | serienummers per aankoop: `purchase_id`, `serial`, `label` (bv. "zender"/"ontvanger"), `position`. Optioneel: 0, 1 of meer per aankoop (statief: geen; draadloze microfoon: twee). Ingeven op `php/add_purchase.php`, zoekbaar via `php/search.php` |
| `sale` | verkopen: `purchase_id`, `price`, `invoice_date`, `invoice_number` |
| `bstock_product_price` | prijspunten per listing: `priceNow`/`priceOriginal` (lotprijs; gedeeld door `bstock_product.quantity` = per stuk), `created` |

`product.deal_price` (per stuk, excl. btw): dealprijs die David per product ingeeft op `php/product.php`. Actieve listings tot 1% erboven (`DEAL_PRICE_TOLERANCE`) staan in "Speciale deals" bovenaan `php/index.php`. Dealprijzen van David zijn excl. btw, tenzij hij "incl." zegt.

**Prijspunten met de hand** (geen aankoop, dus geen concept via `sale_products.js`): een `bstock_product` per advertentie of factuurlijn met één `bstock_product_price`.
- 2dehands.be = leverancier 26: `supplier_product_id` = zoekertjesnummer (`m…`), `url` = advertentie, `created` = "Sinds"-datum, prijs = vraagprijs per stuk (quantity 1). Particulier: geen btw. Blijft actief tot David het archiveert (geen scraper).
- Euro-Events = leverancier 25: oude inkoopfacturen 2009-2012, `supplier_product_id` "factuur-<nr>", gearchiveerd, `created` en prijsdatum = factuurdatum, prijs excl. btw.
- Ontbreekt het product, dan aanmaken onder het juiste merk (bv. SYNQ "DIGIT 3K6", Briteq "BT-POWERJET").

`link_products.js` koppelt listings aan producten via prefix-matching op genormaliseerde namen (merknaam en aliassen worden gestript).

## WordPress / WooCommerce

- WooCommerce 10.3, Flatsome + child theme, Yoast SEO. Prijzen in WooCommerce zijn **excl. btw** (21%); de tax-switch-plugin toont excl./incl.
- **REST**: WooCommerce (`WC_URL`, `WC_KEY`, `WC_SECRET`) en WP REST met applicatiewachtwoord (`WP_USER`, `WP_APP_PASSWORD`, rol shop_manager).
  - `.env` bevat een wachtwoord met spaties: niet in de shell `source`n, altijd via `require("dotenv").config({ quiet: true })` in Node (vanuit deze repo, of `NODE_PATH=$PWD/node_modules` voor scripts in de scratchpad).
  - Merken in WC REST als objecten: `brands: [{ id }]`.
  - Model zetten: `POST /wp/v2/product/{id}` met `{ model: [termId] }`; model-terms via `/wp/v2/model`.
  - Producttype `rental` werkt via REST dankzij `class_alias('WC_Rental_Product', 'WC_Product_Rental')` in `functions.php`.
  - Huurproduct met variaties (bv. kabels per lengte): type `variable` met het vinkje "Huurproduct" (`meta_data: [{ key: "_ad_rental", value: "yes" }]`), variaties via `/products/{id}/variations` met hun eigen dagprijs. `ad_is_rental_product()` (`inc/models.php`) beslist op basis van type `rental` of dat vinkje, nooit op categorie; huurperiode en periodetoeslag rekenen met de prijs van de gekozen variatie.
  - `DELETE` zonder `force=true` = prullenbak.
  - Contact Form 7: lezen via `/contact-form-7/v1/contact-forms` werkt, maar aanmaken of bijwerken via REST wordt niet bewaard (200 zonder effect). Formulieren in wp-admin aanpassen. Formulier 885 "Verkoop je DJ-gear" hoort bij pagina 886 `/verkoop-je-dj-gear/` (bedrijfsvelden en btw-controle: `inc/sell-gear.php`).
- **Taxonomie `model`** (`inc/models.php`): URL `/model/<merk>/<model>/`, `/model/<merk>/` → 301 naar `/brand/<merk>/`. Term meta `brand_term_id` (WooCommerce-merk) en `scraper_product_id` (`product.id` in de scraper-DB). Modelpagina toont huur- en verkoopproducten, title "<merk> <model> huren of kopen"; de meta description en og:description zijn de eerste alinea van de termbeschrijving (max. 30 woorden). Zonder producten én zonder beschrijving: noindex. Ook blogposts kunnen modellen krijgen (`POST /wp/v2/posts/{id}` met `{ model: [termIds] }`); die verschijnen onderaan de modelpagina onder "Meer over de <merk> <model>". Naslagvelden (term meta, via `POST /wp/v2/model/{id}` met `meta`): `release_year`, `predecessor`/`successor` (modelnaam, linkt als het model bestaat), `facts` ("Label: waarde" per regel), `about` (HTML, "Over de …") en `faq` ("V: …" / "A: …", lege regel ertussen; geeft FAQPage-schema). Feiten enkel uit officiële bronnen, gecontroleerd.
- **Banner bovenaan een pagina** (homepage, `/verkoop-je-dj-gear/`): sjabloon `page-transparent-header-light.php`, `[ux_banner class="ad-hero" height="30%" height__sm="260px" bg="700" …]` met de H1 in een `text_box` (ook zichtbaar op mobiel). `.ad-hero` in `style.css` geeft een minimumhoogte zodat de titel niet achter het menu valt, en begrenst de banner op grote schermen op de helft van de schermhoogte (wens van David: geen headers hoger dan 50% van het scherm).
- **Categoriepagina's**: de beschrijving (bovenaan, met `<h1>`) en het Flatsome-veld "Bottom Content" (term meta `cat_meta[cat_footer]`, onder de producten) enkel via wp-admin invullen (ingebouwde browser, David logt in). Via REST filtert kses `<h1>`/`<p>` weg en Bottom Content zit niet in REST. FAQ in Bottom Content met `[ad_faq]` ("V: …" / "A: …", `inc/category-faq.php`, geeft FAQPage-schema). Teksten van Licht, Geluid en DJ-gear huren: `voorstellen/categorieteksten-week2.md`.
- **Attributen**: `pa_herkomst` (id 1: Nieuw, Ex-demo, B-stock, Tweedehands) en `pa_staat` (id 2: Nieuw, Nieuwstaat, Zeer goed, Goed, Gebruikssporen). Ze sturen de SEO-titel/description (`inc/product-seo.php`) en `itemCondition` in de structured data (`inc/structured-data.php`, prijzen incl. btw).
- **Merken** (`product_brand`): Pioneer DJ 25, AlphaTheta 57, Hilec 56, JB-Systems 27, ProDJuser 94, Rodec 101.
- **Yoast per product**: `meta_data` `_yoast_wpseo_metadesc` en `_yoast_wpseo_focuskw` via WC REST. Een ingevulde metadesc gaat voor op die van `inc/product-seo.php`; huurproducten krijgen er een eigen ("Huur de <merk> <model>: … Af te halen in Wuustwezel na afspraak of geleverd op jouw event.", max. ±155 tekens).
- **Categorieën**: verkoop 62, DJ-gear kopen 59 (kind van verkoop), Licht kopen 93 (kind van verkoop); verhuur o.a. DJ mixer huren 36, DJ speler huren 41, DJ controller huren 48, Standalone DJ controller huren 37, DJ FX huren 40, DJ toebehoren huren 47, Licht huren 22, Geluid huren 19.
- **Model-terms**: CDJ-3000X 58, XDJ-AZ 65, LS64 66, Euphonia 67, FLT-XDJAZ 68, RMX-Ignite 69, CDJ-1000MK2 70, CDJ-1000MK3 71, DDJ-FLX4 72, DJC-RUCKSACK 73, DJC-STS1 74, DJM-900NXS2 75, DJM-A9 76, DJM-V10 77, DJS-1000 78, OPUS-QUAD 79, RMX-1000 80, XDJ-RX3 81, DJM-V5 82.

## Scripts voor verkoopproducten

- `node sale_products.js [--dry]`: maakt voor elke onverkochte aankoop een **concept**-product aan. SKU = `purchase.id`; naam "<merk> <model> kopen"; prijs excl. btw = aankoopprijs + max(20%, €75); geen voorraadbeheer (een offerteaanvraag verlaagt anders de voorraad en toont het product als verkocht), categorie 59, merk en model van het model op de site. Bestaande SKU's (ook in de prullenbak) worden overgeslagen, er wordt nooit iets overschreven.
- `node upload_photos.js [--dry]`: foto's uit `~/Pictures/Sales/<sku>-<n>.(jpg|png|webp)` → product met die SKU. `-1` wordt hoofdfoto, de rest galerij. Alt/titel "<merk> <model> kopen". Daarna verplaatst naar `~/Pictures/Sales/Uploaded`.
- `node inkoopdocument.js [--purchase <id>[,<id>…]] [--nummer AB2026-1] [--naam … --adres … --gemeente … --serienummer … --staat … --inbegrepen … --regels n --betaling contant|overschrijving]`: aankoopborderel (PDF, stijl van de facturen) voor aankopen van particulieren (zonder btw; de regeling, marge of volle btw, kies je pas bij de verkoop). Tot 5 toestellen per borderel: per-toestelopties (`--toestel`, `--serienummer`, `--staat`, `--inbegrepen`, `--prijs`) herhalen in de volgorde van de aankopen; het totaal telt de prijzen op. Serienummers komen met `--purchase` uit `purchase_serial` (`--serienummer` gaat voor). Zonder opties een leeg borderel met 5 regels om met de hand in te vullen. Uitvoer in `inkoopdocumenten/`.
- `node leveringsbon.js [--nummer … --datum … --factuur …]`: leveringsbon (PDF, zelfde stijl), standaard leeg om met de hand in te vullen; verwijst naar de algemene voorwaarden op https://www.after-dark.be/algemene-voorwaarden/ (verkoop en verhuur). Uitvoer in `leveringsbonnen/`. Gedeelde opmaak van beide documenten: `documents.js`.
- **Productfoto's (fabrikantbeelden)**: 1000×1000 jpg, wit, toestel 910 px breed (of hoog als dat beperkt) en gecentreerd, zoals `pio-ddjflx4-top.jpg`. Naam `<merkprefix>-<model zonder streepjes>-top|front|back.jpg` (`pio-`, `att-` AlphaTheta, `jbs-`, `bri-`, `pdu-` ProDJuser, `rod-` Rodec). Volgorde: top = hoofdfoto, dan front, dan back. Alt "<merk> <model> bovenkant/voorkant/achterkant". Resultaat in `~/Downloads`, nooit overschrijven.
- `swift cutout.swift <uitvoermap> <foto>...`: knipt het toestel uit (macOS Vision) en zet het op wit, zelfde afmetingen; overschrijft nooit bestaande bestanden (bv. uitvoer naar `~/Pictures/Sales/Wit`). Los van `upload_photos.js`. Let op: het AFTER DARK-logo op de foto wordt mee weggeknipt.

## Verkoopproduct afwerken (vragenlijst)

Een automatisch aangemaakt verkoopproduct heeft enkel naam, prijs (berekend), merk, model en categorie. Vraag de gebruiker eerst (bij voorkeur met één vragenlijst):

1. **Herkomst**: Nieuw, Ex-demo, B-stock of Tweedehands.
2. **Staat**: Nieuwstaat, Zeer goed, Goed of Gebruikssporen (bij Nieuw: Nieuw).
3. **Garantie**: standaard 1 jaar op fabrieksfouten voor ex-demo/B-stock/tweedehands, 2 jaar voor nieuw. Vragen.
4. **Inbegrepen** naast het netsnoer: originele verpakking, flightcase, kabels, … (zie regels hieronder).
5. **Verkoopprijs incl. btw**. In WooCommerce excl. btw zetten: `prijs / 1.21`, afgerond op 2 decimalen, en controleren dat × 1.21 terug het bedrag geeft.

Toon ook de aankoop (`purchase` + `bstock_product.title`/`url`) ter info. Daarna:

- Attributen zetten: `attributes: [{ id: 1, options: ["Ex-demo"], visible: true }, { id: 2, options: ["Nieuwstaat"], visible: true }]`.
- Korte beschrijving en beschrijving schrijven (sjabloon hieronder), status **concept** laten tot de gebruiker zegt te publiceren.
- Verkocht? Dan `stock_status: "outofstock"` zetten (voorraadbeheer staat uit, dus dat gebeurt niet automatisch).
- Na publicatie: modelpagina-intro aanpassen naar "huren of kopen" (zin "Liever kopen? Zodra we…" weghalen), live title/description/structured data controleren, en de URL op de Search Console-lijst in `TODO.md` zetten.
- Staat het toestel al op 2dehands? Prijs, staat en inbegrepen uit het zoekertje halen en enkel vragen wat ontbreekt. B-stock die op 2dehands als "nieuw" staat: op de site "B-stock in nieuwstaat". Bestaat er al een concept met de SKU van de aankoop, dat aanvullen in plaats van een nieuw product te maken. Verkoopproducten zonder aankoop krijgen geen SKU.
- Toestellen zonder model op de site (accessoires zoals een flightcase) niet aan een model koppelen: anders staan ze op de modelpagina als "te koop".

## Search Console

Property `sc-domain:after-dark.be`, URL-inspectie in de ingebouwde browser (venster minstens 1280 breed; zoekbalk focussen met `document.querySelector('input[aria-label^="Een URL in"]')`). Eerst inspecteren ("Pagina-indexering" openklappen, "Laatste crawl" lezen) en enkel indexering aanvragen als de pagina niet geïndexeerd is of de laatste crawl van vóór de laatste wijziging is (`date_modified` via WC REST). De knop "Indexering aanvragen" altijd eerst opzoeken (`find`), nooit een ref gokken. Quotum ±10 per 24 uur; bij "Quotum overschreden" stoppen, inspecteren kan nog wel. Wat nog aangevraagd moet worden, staat in `TODO.md`.

### Regels voor "Inbegrepen"

- Netsnoer altijd vermelden. USB-kabels nooit. Handleiding niet, tenzij de gebruiker het voor dat toestel zegt.
- Verpakking: "originele verpakking (mogelijk beschadigd)".
- Een lijst van de gebruiker per toestel gaat voor (bv. CDJ-3000X: netsnoer, cinchkabel, digitale audiokabel, netwerkkabel, handleiding).

### Sjabloon verkooptekst

Korte beschrijving (`<ul>`):
- "<Herkomst>toestel in <staat>, nauwelijks gebruikt" (ex-demo) / "B-stock in <staat>" / "Tweedehands toestel in <staat>" / "Nieuw in gesloten verpakking"
- "<n> jaar garantie op fabrieksfouten"
- "Getest door AFTER DARK, af te halen in Wuustwezel na afspraak" (nieuw: "Af te halen in Wuustwezel na afspraak")
- "Inbegrepen: …"

Beschrijving:
- `<h3>` met een eigen invalshoek + 1-2 alinea's over het toestel, een lijst "Wat de <model> sterk maakt:" met 3-4 `<strong>`-punten, links naar verwante verkoopproducten.
- `<h3>Dit toestel</h3>`: herkomst, staat, wat getest is, garantie. Bij ex-demo daarna: "Op zoek naar een tweedehands <model>? Een ex-demo is de slimste keuze: je betaalt minder dan voor een nieuw toestel." Dan `<p><strong>Inbegrepen:</strong> …</p>`.
- `<h3>Eerst uitproberen?</h3>` met link naar de modelpagina ("alle opties voor de <merk> <model>") als er een huurversie is.
- Overal "af te halen in Wuustwezel na afspraak". Geen tekst tussen vierkante haken op de site.

## Huurproducten

Naam "<merk> <model> huren", type `rental`, prijs per dag excl. btw. Langer huren: tot 8 dagen 1,5 × de dagprijs ("een weekend of een volle week kost 1,5 keer de dagprijs"), daarna +50% per begonnen week (`functions.php`). Levering zonder beperking op de regio. Afhalen/levering: "Af te halen in Wuustwezel na afspraak of geleverd op jouw event" (korte beschrijving en meta description; verkoopproducten enkel afhalen). Beschrijving: wat het toestel is en waarvoor huurders het gebruiken, eventueel een lijst met voordelen, en afsluiten met "Dit omvat:" (`<ul>` met "1 x …"). Geen overgenomen fabrikantentekst; specificaties herschrijven voor huurders. Linken naar toestellen die je ermee combineert (controller, statief, opvolger).
