<?php

declare(strict_types=1);

require __DIR__ . '/helpers.php';

$mysqli = get_db_connection();

$brandListSql = "
    SELECT b.id, b.name, b.weight, COUNT(p.id) AS product_count
    FROM brand b
    LEFT JOIN bstock_product p ON p.brand_id = b.id AND p.archived = 0 AND p.ignored = 0
    WHERE b.ignored = 0
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
    p.id, p.title, p.url, p.created AS product_created, p.product_id,
    b.id AS brand_id, b.name AS brand_name, b.weight,
    lp.priceOriginal, lp.priceNow, lp.discount_label, lp.created AS price_created,
    (lp.priceOriginal - lp.priceNow) AS price_diff,
    pr.highest_price, pr.lowest_price
";

$lightestProductsSql = "
    SELECT $commonSelect
    FROM bstock_product p
    JOIN brand b ON b.id = p.brand_id
    $latestPriceJoin
    $priceRangeJoin
    WHERE p.archived = 0 AND p.ignored = 0 AND b.ignored = 0
    ORDER BY b.weight ASC
    LIMIT 50
";

$biggestDiscountsSql = "
    SELECT $commonSelect
    FROM bstock_product p
    LEFT JOIN brand b ON b.id = p.brand_id
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
    $latestPriceJoin
    $priceRangeJoin
    WHERE p.archived = 0 AND p.ignored = 0
      AND (b.id IS NULL OR b.ignored = 0)
    ORDER BY p.created DESC
    LIMIT 50
";

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
        .num {
            text-align: right;
        }
        a {
            color: #0a4d92;
        }
    </style>
</head>
<body>
    <h1>Bax B-Stock overzicht</h1>

    <h2>Merken</h2>
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

    <?php
    $tableHeaders = function (): void {
        ?>
        <tr>
            <th>Titel</th>
            <th>Merk</th>
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
                <tr><td colspan="12">Geen producten gevonden.</td></tr>
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
                <tr><td colspan="12">Geen producten gevonden.</td></tr>
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
                <tr><td colspan="12">Geen producten gevonden.</td></tr>
            <?php else: foreach ($recentProducts as $row): render_product_row($row); endforeach; endif; ?>
        </tbody>
    </table>
</body>
</html>
