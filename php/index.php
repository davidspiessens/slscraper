<?php

declare(strict_types=1);

require __DIR__ . '/helpers.php';

// Een HEAD-request (bv. een beschikbaarheidscheck) krijgt geen body; de
// zware queries hieronder zijn dan overbodig.
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'HEAD') {
    exit;
}

$mysqli = get_db_connection();

$brandListSql = "
    SELECT b.id, b.name, b.weight, COUNT(p.id) AS product_count
    FROM brand b
    LEFT JOIN bstock_product p ON p.brand_id = b.id AND p.archived = 0 AND p.ignored = 0
    WHERE b.ignored = 0 AND b.weight < 10000
    GROUP BY b.id, b.name, b.weight
    ORDER BY b.weight ASC, b.name ASC
";

// Meest recente prijs per product
$latestPriceJoin = "
    JOIN (
        SELECT bpp.bstock_product_id, bpp.priceOriginal, bpp.priceNow, bpp.discount_label, bpp.created
        FROM bstock_product_price bpp
        INNER JOIN (
            SELECT bstock_product_id, MAX(id) AS max_id
            FROM bstock_product_price
            GROUP BY bstock_product_id
        ) m ON m.max_id = bpp.id
    ) lp ON lp.bstock_product_id = p.id
";

// Hoogste en laagste ooit geregistreerde priceNow per product
$priceRangeJoin = "
    JOIN (
        SELECT bstock_product_id,
               MAX(priceNow) AS highest_price,
               MIN(priceNow) AS lowest_price
        FROM bstock_product_price
        GROUP BY bstock_product_id
    ) pr ON pr.bstock_product_id = p.id
";

$commonSelect = "
    p.id, p.title, p.quantity, p.url, p.created AS product_created, p.product_id,
    b.id AS brand_id, b.name AS brand_name, b.weight, b.ignored AS brand_ignored,
    sup.id AS supplier_id, sup.name AS supplier_name,
    lp.priceOriginal, lp.priceNow, lp.discount_label, lp.created AS price_created,
    (lp.priceOriginal - lp.priceNow) AS price_diff,
    pr.highest_price, pr.lowest_price
";

$lightestProductsSql = "
    SELECT $commonSelect
    FROM bstock_product p
    JOIN brand b ON b.id = p.brand_id
    LEFT JOIN supplier sup ON sup.id = p.supplier_id
    $latestPriceJoin
    $priceRangeJoin
    WHERE p.archived = 0 AND p.ignored = 0 AND b.ignored = 0
    ORDER BY b.weight ASC, p.created DESC
    LIMIT 50
";

$biggestDiscountsSql = "
    SELECT $commonSelect
    FROM bstock_product p
    LEFT JOIN brand b ON b.id = p.brand_id
    LEFT JOIN supplier sup ON sup.id = p.supplier_id
    $latestPriceJoin
    $priceRangeJoin
    WHERE p.archived = 0 AND p.ignored = 0
      AND (b.id IS NULL OR b.ignored = 0)
      AND (b.weight IS NULL OR b.weight < 10000)
    ORDER BY price_diff DESC
    LIMIT 50
";

$recentProductsSql = "
    SELECT $commonSelect
    FROM bstock_product p
    LEFT JOIN brand b ON b.id = p.brand_id
    LEFT JOIN supplier sup ON sup.id = p.supplier_id
    $latestPriceJoin
    $priceRangeJoin
    WHERE p.archived = 0 AND p.ignored = 0
      AND (b.id IS NULL OR b.ignored = 0)
    ORDER BY p.created DESC
    LIMIT 50
";

// Echte deals: een actieve listing die minstens DEAL_MIN_BELOW onder de
// mediaanprijs van hetzelfde product zit. De mediaan neemt per listing van
// het afgelopen jaar één prijs (de laatste, per stuk), over alle
// leveranciers, zodat een listing die lang online staat niet zwaarder weegt.
const DEAL_MIN_BELOW = 0.2;
const DEAL_MIN_LISTINGS = 4;
// Meer dan 70% onder de mediaan is bijna altijd een verkeerde koppeling
// (een hoes of tas aan het toestel gelinkt) of een set waarvan het aantal
// niet herkend werd.
const DEAL_MAX_BELOW = 0.7;
// Accessoires, packages en sets in de titel, terwijl de productnaam ze niet
// vermeldt. Zulke listings tellen niet mee voor de mediaan (een "Kara II
// Package" van € 64.705 trekt die anders omhoog) en zijn zelf geen deal.
// MariaDB-REGEXP (PCRE), niet hoofdlettergevoelig.
const DEAL_SUSPECT_REGEXP = '(?i)\\\\b(tas|bag|gig ?bag|cover|hoes|case|top hat|rigging|bumper|frame|grid|bracket|beugel|dolly|kabel|cable|receiver|transmitter|set|package|pakket|[0-9]+ *x)\\\\b';

$dealsSql = "
    WITH last_price AS (
        SELECT bpp.bstock_product_id, bpp.priceNow, bpp.created
        FROM bstock_product_price bpp
        JOIN (
            SELECT bstock_product_id, MAX(id) AS max_id
            FROM bstock_product_price
            GROUP BY bstock_product_id
        ) m ON m.max_id = bpp.id
    ),
    listing AS (
        SELECT p.id, p.product_id, p.archived, p.ignored,
               lp.priceNow / GREATEST(p.quantity, 1) AS unit_price
        FROM bstock_product p
        JOIN last_price lp ON lp.bstock_product_id = p.id
        JOIN product pr ON pr.id = p.product_id
        WHERE lp.priceNow > 0
          AND lp.created > NOW() - INTERVAL 365 DAY
          AND (p.title NOT REGEXP '" . DEAL_SUSPECT_REGEXP . "' OR pr.name REGEXP '" . DEAL_SUSPECT_REGEXP . "')
    ),
    reference AS (
        SELECT DISTINCT product_id,
               MEDIAN(unit_price) OVER (PARTITION BY product_id) AS median_price,
               MIN(unit_price) OVER (PARTITION BY product_id) AS lowest_price,
               COUNT(*) OVER (PARTITION BY product_id) AS listing_count
        FROM listing
    )
    SELECT p.id, p.title, p.url, p.quantity, p.product_id, pr.name AS product_name,
           b.id AS brand_id, b.name AS brand_name, b.weight,
           sup.id AS supplier_id, sup.name AS supplier_name,
           l.unit_price, r.median_price, r.lowest_price, r.listing_count,
           1 - l.unit_price / r.median_price AS below_median
    FROM listing l
    JOIN reference r ON r.product_id = l.product_id
    JOIN bstock_product p ON p.id = l.id
    JOIN product pr ON pr.id = l.product_id
    LEFT JOIN brand b ON b.id = p.brand_id
    LEFT JOIN supplier sup ON sup.id = p.supplier_id
    WHERE l.archived = 0 AND l.ignored = 0
      AND (b.id IS NULL OR (b.ignored = 0 AND b.weight < 10000))
      AND r.listing_count >= " . DEAL_MIN_LISTINGS . "
      AND l.unit_price <= r.median_price * " . (1 - DEAL_MIN_BELOW) . "
      AND l.unit_price >= r.median_price * " . (1 - DEAL_MAX_BELOW) . "
    ORDER BY below_median DESC
";

$allDeals = $mysqli->query($dealsSql)->fetch_all(MYSQLI_ASSOC);

// Speciale deals: actieve listings waarvan de prijs per stuk onder de
// dealprijs zit die per product is ingegeven (product.deal_price, op
// product.php).
$specialDealsSql = "
    SELECT p.id, p.title, p.url, p.quantity, p.product_id, pr.name AS product_name, pr.deal_price,
           b.id AS brand_id, b.name AS brand_name,
           sup.id AS supplier_id, sup.name AS supplier_name,
           lp.priceNow / GREATEST(p.quantity, 1) AS unit_price, lp.created AS price_created,
           1 - lp.priceNow / GREATEST(p.quantity, 1) / pr.deal_price AS below_deal_price
    FROM bstock_product p
    JOIN product pr ON pr.id = p.product_id
    $latestPriceJoin
    LEFT JOIN brand b ON b.id = p.brand_id
    LEFT JOIN supplier sup ON sup.id = p.supplier_id
    WHERE pr.deal_price IS NOT NULL
      AND p.archived = 0 AND p.ignored = 0
      AND lp.priceNow > 0
      AND lp.priceNow / GREATEST(p.quantity, 1) <= pr.deal_price
    ORDER BY below_deal_price DESC
";
$specialDeals = $mysqli->query($specialDealsSql)->fetch_all(MYSQLI_ASSOC);

$dealPriceProducts = $mysqli->query(
    'SELECT pr.id, pr.name, pr.deal_price, b.name AS brand_name
     FROM product pr
     LEFT JOIN brand b ON b.id = pr.brand_id
     WHERE pr.deal_price IS NOT NULL
     ORDER BY b.name ASC, pr.name ASC'
)->fetch_all(MYSQLI_ASSOC);

// Filteropties: enkel merken en leveranciers die effectief deals hebben.
$dealBrands = [];
$dealSuppliers = [];
foreach ($allDeals as $row) {
    if ($row['brand_id']) $dealBrands[(int) $row['brand_id']] = $row['brand_name'];
    if ($row['supplier_id']) $dealSuppliers[(int) $row['supplier_id']] = $row['supplier_name'];
}
natcasesort($dealBrands);
natcasesort($dealSuppliers);
$dealBrandFilter = array_map('intval', (array) ($_GET['deal_brand'] ?? []));
$dealSupplierFilter = array_map('intval', (array) ($_GET['deal_supplier'] ?? []));

// Eén lijn per product: de beste deal (de lijst is al gesorteerd op korting);
// de overige deals van hetzelfde product worden enkel geteld.
$deals = [];
foreach ($allDeals as $row) {
    if ($dealBrandFilter && !in_array((int) $row['brand_id'], $dealBrandFilter, true)) continue;
    if ($dealSupplierFilter && !in_array((int) $row['supplier_id'], $dealSupplierFilter, true)) continue;
    $productId = (int) $row['product_id'];
    if (isset($deals[$productId])) {
        $deals[$productId]['other_deals']++;
        continue;
    }
    $deals[$productId] = $row + ['other_deals' => 0];
}
$dealCount = count($deals);
$deals = array_slice(array_values($deals), 0, 50);

$brandList = $mysqli->query($brandListSql)->fetch_all(MYSQLI_ASSOC);
$lightestProducts = $mysqli->query($lightestProductsSql)->fetch_all(MYSQLI_ASSOC);
$biggestDiscounts = $mysqli->query($biggestDiscountsSql)->fetch_all(MYSQLI_ASSOC);
$recentProducts = $mysqli->query($recentProductsSql)->fetch_all(MYSQLI_ASSOC);

$mysqli->close();

?>
<!DOCTYPE html>
<html lang="nl">
<head>
    <meta charset="UTF-8">
    <title>Bax B-Stock overzicht</title>
    <style>
        body {
            font-family: Arial, Helvetica, sans-serif;
            margin: 2rem;
            color: #222;
        }
        h1 {
            font-size: 1.4rem;
        }
        h2 {
            font-size: 1.1rem;
            margin-top: 2.5rem;
        }
        table {
            border-collapse: collapse;
            width: 100%;
            margin-top: 0.5rem;
        }
        th, td {
            border: 1px solid #ccc;
            padding: 0.4rem 0.6rem;
            text-align: left;
            font-size: 0.9rem;
        }
        th {
            background: #f2f2f2;
        }
        tr:nth-child(even) {
            background: #fafafa;
        }
        tr:hover {
            background: #eaf2ff !important;
        }
        .num {
            text-align: right;
        }
        a {
            color: #0a4d92;
        }
        .meta {
            margin: 0.2rem 0;
        }
    </style>
</head>
<body>
    <?= render_vat_toggle() ?>
    <h1>Bax B-Stock overzicht</h1>

    <form method="get" action="search.php" style="margin: 0.5rem 0 1rem 0;">
        <input type="text" name="q" placeholder="Zoek op titel...">
        <button type="submit">Zoeken</button>
    </form>

    <p class="meta">Aankopen: <a href="purchases.php">Overzicht</a> - <a href="add_purchase.php">Nieuwe aankoop</a></p>
    <p class="meta">Verkopen: <a href="sales.php">Overzicht</a> - <a href="add_sale.php">Nieuwe verkoop</a></p>
    <p class="meta">Scraper runs: <a href="runs.php">Overzicht</a></p>

    <h2>Merken <small>(<a href="manage_brands.php">Beheer merken</a>)</small></h2>
    
    <p class="brand-list">
        <?php if (empty($brandList)): ?>
            Geen merken gevonden.
        <?php else: ?>
            <?php $brandLinks = array_map(
                fn($row) => '<a href="brand.php?id=' . (int) $row['id'] . '">' . htmlspecialchars($row['name']) . '</a> (' . (int) $row['product_count'] . ')',
                $brandList
            ); ?>
            <?= implode(' - ', $brandLinks) ?>
        <?php endif; ?>
    </p>

    <h2>Speciale deals</h2>
    <p class="meta">
        Actieve listings waarvan de prijs per stuk onder de dealprijs zit die je op de productpagina ingeeft.
        <?php if ($dealPriceProducts): ?>
            <br>Dealprijzen (<?= count($dealPriceProducts) ?>):
            <?= implode(' - ', array_map(
                fn($row) => '<a href="product.php?id=' . (int) $row['id'] . '">' . htmlspecialchars(trim($row['brand_name'] . ' ' . $row['name'])) . '</a> ' . euro($row['deal_price']),
                $dealPriceProducts
            )) ?>
        <?php else: ?>
            Nog geen dealprijzen ingegeven.
        <?php endif; ?>
    </p>
    <table>
        <thead>
            <tr>
                <th>Titel</th>
                <th>Product</th>
                <th>Merk</th>
                <th>Leverancier</th>
                <th class="num">Prijs nu</th>
                <th class="num">Dealprijs</th>
                <th class="num">Onder dealprijs</th>
                <th>Prijs bijgewerkt</th>
                <th>Actie</th>
            </tr>
        </thead>
        <tbody>
            <?php if (empty($specialDeals)): ?>
                <tr><td colspan="9">Geen speciale deals gevonden.</td></tr>
            <?php else: foreach ($specialDeals as $row): ?>
                <tr data-listing-id="<?= (int) $row['id'] ?>">
                    <td>
                        <a href="bstock_product.php?id=<?= (int) $row['id'] ?>"><?= htmlspecialchars($row['title']) ?></a>
                        &nbsp;<a href="<?= htmlspecialchars($row['url']) ?>" target="_blank" rel="noopener" title="Bekijk bij de leverancier">&#8599;</a>
                    </td>
                    <td><a href="product.php?id=<?= (int) $row['product_id'] ?>"><?= htmlspecialchars($row['product_name']) ?></a></td>
                    <td>
                        <?php if ($row['brand_id']): ?>
                            <a href="brand.php?id=<?= (int) $row['brand_id'] ?>"><?= htmlspecialchars($row['brand_name']) ?></a>
                        <?php else: ?>
                            -
                        <?php endif; ?>
                    </td>
                    <td>
                        <?php if ($row['supplier_id']): ?>
                            <a href="supplier.php?id=<?= (int) $row['supplier_id'] ?>"><?= htmlspecialchars($row['supplier_name']) ?></a>
                        <?php else: ?>
                            -
                        <?php endif; ?>
                    </td>
                    <td class="num">
                        <?= euro($row['unit_price']) ?>
                        <?php if ((int) $row['quantity'] > 1): ?><br><small>per stuk (&times;<?= (int) $row['quantity'] ?>)</small><?php endif; ?>
                    </td>
                    <td class="num"><?= euro($row['deal_price']) ?></td>
                    <td class="num"><strong>-<?= (int) round((float) $row['below_deal_price'] * 100) ?>%</strong></td>
                    <td><?= htmlspecialchars($row['price_created']) ?></td>
                    <td>
                        <form method="post" action="ignore_bstock_product.php" style="margin:0;">
                            <input type="hidden" name="id" value="<?= (int) $row['id'] ?>">
                            <input type="hidden" name="redirect" value="<?= htmlspecialchars($_SERVER['REQUEST_URI'] ?? 'index.php') ?>">
                            <button type="submit" title="Negeren" onclick="return confirm('Dit product negeren?');">&#128683;</button>
                        </form>
                    </td>
                </tr>
            <?php endforeach; endif; ?>
        </tbody>
    </table>

    <h2>Echte deals</h2>
    <p class="meta">
        Actieve listings die minstens <?= (int) round(DEAL_MIN_BELOW * 100) ?>% onder de mediaanprijs van hetzelfde product zitten
        (laatste prijs per listing, per stuk, alle leveranciers, afgelopen jaar, minstens <?= DEAL_MIN_LISTINGS ?> listings).
        Listings met accessoires, packages of sets in de titel tellen niet mee, ook niet voor de mediaan.
        Meer dan <?= (int) round(DEAL_MAX_BELOW * 100) ?>% eronder wordt weggelaten: dat is meestal een verkeerde koppeling.
        Per product staat enkel de beste deal.
    </p>
    <form method="get" action="index.php" style="margin: 0.5rem 0;">
        <?php foreach (['deal_brand' => ['Merk', $dealBrands, $dealBrandFilter], 'deal_supplier' => ['Leverancier', $dealSuppliers, $dealSupplierFilter]] as $param => [$label, $options, $checked]): ?>
            <p class="meta">
                <strong><?= $label ?>:</strong>
                <?php foreach ($options as $id => $name): ?>
                    <label style="margin-right: 0.8rem; white-space: nowrap;">
                        <input type="checkbox" name="<?= $param ?>[]" value="<?= $id ?>" onchange="this.form.submit()"<?= in_array($id, $checked, true) ? ' checked' : '' ?>>
                        <?= htmlspecialchars($name) ?>
                    </label>
                <?php endforeach; ?>
            </p>
        <?php endforeach; ?>
        <p class="meta">
            <span style="color: #666;"><?= $dealCount ?> product<?= $dealCount === 1 ? '' : 'en' ?><?= $dealCount > 50 ? ', top 50 getoond' : '' ?></span>
            <?php if ($dealBrandFilter || $dealSupplierFilter): ?>
                &nbsp;<a href="index.php">Filters wissen</a>
            <?php endif; ?>
        </p>
    </form>
    <table>
        <thead>
            <tr>
                <th>Titel</th>
                <th>Product</th>
                <th>Merk</th>
                <th>Leverancier</th>
                <th class="num">Prijs nu</th>
                <th class="num">Mediaan</th>
                <th class="num">Onder mediaan</th>
                <th class="num">Laagste listing</th>
                <th class="num">Listings</th>
                <th>Actie</th>
            </tr>
        </thead>
        <tbody>
            <?php if (empty($deals)): ?>
                <tr><td colspan="10">Geen deals gevonden.</td></tr>
            <?php else: foreach ($deals as $row): ?>
                <?php $isLowest = (float) $row['unit_price'] <= (float) $row['lowest_price']; ?>
                <tr data-listing-id="<?= (int) $row['id'] ?>">
                    <td>
                        <a href="bstock_product.php?id=<?= (int) $row['id'] ?>"><?= htmlspecialchars($row['title']) ?></a>
                        &nbsp;<a href="<?= htmlspecialchars($row['url']) ?>" target="_blank" rel="noopener" title="Bekijk bij de leverancier">&#8599;</a>
                        <?php if ($row['other_deals'] > 0): ?>
                            <br><small><a href="product.php?id=<?= (int) $row['product_id'] ?>">+<?= (int) $row['other_deals'] ?> andere deal<?= $row['other_deals'] === 1 ? '' : 's' ?></a></small>
                        <?php endif; ?>
                    </td>
                    <td><a href="product.php?id=<?= (int) $row['product_id'] ?>"><?= htmlspecialchars($row['product_name']) ?></a></td>
                    <td>
                        <?php if ($row['brand_id']): ?>
                            <a href="brand.php?id=<?= (int) $row['brand_id'] ?>"><?= htmlspecialchars($row['brand_name']) ?></a>
                        <?php else: ?>
                            -
                        <?php endif; ?>
                    </td>
                    <td>
                        <?php if ($row['supplier_id']): ?>
                            <a href="supplier.php?id=<?= (int) $row['supplier_id'] ?>"><?= htmlspecialchars($row['supplier_name']) ?></a>
                        <?php else: ?>
                            -
                        <?php endif; ?>
                    </td>
                    <td class="num"<?= $isLowest ? ' style="background-color: #d4f7d4;" title="Laagste prijs van alle listings van dit product"' : '' ?>>
                        <?= euro($row['unit_price']) ?>
                        <?php if ((int) $row['quantity'] > 1): ?><br><small>per stuk (&times;<?= (int) $row['quantity'] ?>)</small><?php endif; ?>
                    </td>
                    <td class="num"><?= euro($row['median_price']) ?></td>
                    <td class="num"><strong>-<?= (int) round((float) $row['below_median'] * 100) ?>%</strong></td>
                    <td class="num"><?= euro($row['lowest_price']) ?></td>
                    <td class="num"><?= (int) $row['listing_count'] ?></td>
                    <td>
                        <form method="post" action="ignore_bstock_product.php" style="margin:0;">
                            <input type="hidden" name="id" value="<?= (int) $row['id'] ?>">
                            <input type="hidden" name="redirect" value="<?= htmlspecialchars($_SERVER['REQUEST_URI'] ?? 'index.php') ?>">
                            <button type="submit" title="Negeren" onclick="return confirm('Dit product negeren?');">&#128683;</button>
                        </form>
                    </td>
                </tr>
            <?php endforeach; endif; ?>
        </tbody>
    </table>

    <?php
    $tableHeaders = function (): void {
        ?>
        <tr>
            <th>Titel</th>
            <th>Merk</th>
            <th>Leverancier</th>
            <th class="num">Gewicht</th>
            <th class="num">Prijs (van)</th>
            <th class="num">Prijs (nu)</th>
            <th class="num">Verschil</th>
            <th class="num">Hoogste prijs</th>
            <th class="num">Laagste prijs</th>
            <th>Korting</th>
            <th>Prijs bijgewerkt</th>
            <th>Product aangemaakt</th>
            <th>Actie</th>
        </tr>
        <?php
    };
    ?>

    <h2>20 producten met het laagste merkgewicht</h2>
    <table>
        <thead>
            <?php $tableHeaders(); ?>
        </thead>
        <tbody>
            <?php if (empty($lightestProducts)): ?>
                <tr><td colspan="13">Geen producten gevonden.</td></tr>
            <?php else: foreach ($lightestProducts as $row): render_product_row($row); endforeach; endif; ?>
        </tbody>
    </table>

    <h2>20 producten met het grootste prijsverschil</h2>
    <table>
        <thead>
            <?php $tableHeaders(); ?>
        </thead>
        <tbody>
            <?php if (empty($biggestDiscounts)): ?>
                <tr><td colspan="13">Geen producten gevonden.</td></tr>
            <?php else: foreach ($biggestDiscounts as $row): render_product_row($row); endforeach; endif; ?>
        </tbody>
    </table>

    <h2>50 meest recente producten</h2>
    <table>
        <thead>
            <?php $tableHeaders(); ?>
        </thead>
        <tbody>
            <?php if (empty($recentProducts)): ?>
                <tr><td colspan="13">Geen producten gevonden.</td></tr>
            <?php else: foreach ($recentProducts as $row): render_product_row($row); endforeach; endif; ?>
        </tbody>
    </table>
</body>
</html>
