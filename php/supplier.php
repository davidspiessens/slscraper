<?php

declare(strict_types=1);

require __DIR__ . '/helpers.php';

$supplierId = filter_input(INPUT_GET, 'id', FILTER_VALIDATE_INT);

if (!$supplierId) {
    http_response_code(400);
    die('Ongeldig of ontbrekend leverancier-id.');
}

$mysqli = get_db_connection();

$supplierStmt = $mysqli->prepare('SELECT id, name FROM supplier WHERE id = ?');
$supplierStmt->bind_param('i', $supplierId);
$supplierStmt->execute();
$supplier = $supplierStmt->get_result()->fetch_assoc();
$supplierStmt->close();

if (!$supplier) {
    http_response_code(404);
    die('Leverancier niet gevonden.');
}

// Alle bstock-producten van deze leverancier, aflopend op aanmaakdatum, met
// gearchiveerde producten onderaan (zelfde sortering als brand.php). Toont
// ook genegeerde producten (in tegenstelling tot brand.php) — render_product_row
// markeert die dan wel visueel (rode achtergrond) via p.ignored hieronder.
$productsSql = "
    SELECT p.id, p.title, p.url, p.created AS product_created, p.product_id, p.archived, p.ignored,
           b.id AS brand_id, b.name AS brand_name, b.weight, b.ignored AS brand_ignored,
           sup.id AS supplier_id, sup.name AS supplier_name,
           lp.priceOriginal, lp.priceNow, lp.discount_label, lp.created AS price_created,
           (lp.priceOriginal - lp.priceNow) AS price_diff,
           pr.highest_price, pr.lowest_price
    FROM bstock_product p
    LEFT JOIN brand b ON b.id = p.brand_id
    LEFT JOIN supplier sup ON sup.id = p.supplier_id
    JOIN (
        SELECT bpp.bstock_product_id, bpp.priceOriginal, bpp.priceNow, bpp.discount_label, bpp.created
        FROM bstock_product_price bpp
        INNER JOIN (
            SELECT bstock_product_id, MAX(id) AS max_id
            FROM bstock_product_price
            GROUP BY bstock_product_id
        ) m ON m.max_id = bpp.id
    ) lp ON lp.bstock_product_id = p.id
    JOIN (
        SELECT bstock_product_id,
               MAX(priceNow) AS highest_price,
               MIN(priceNow) AS lowest_price
        FROM bstock_product_price
        GROUP BY bstock_product_id
    ) pr ON pr.bstock_product_id = p.id
    WHERE p.supplier_id = ?
    ORDER BY p.archived ASC, p.created DESC
";

$productsStmt = $mysqli->prepare($productsSql);
$productsStmt->bind_param('i', $supplierId);
$productsStmt->execute();
$products = $productsStmt->get_result()->fetch_all(MYSQLI_ASSOC);
$productsStmt->close();

$mysqli->close();

?>
<!DOCTYPE html>
<html lang="nl">
<head>
    <meta charset="UTF-8">
    <title><?= htmlspecialchars($supplier['name']) ?> - Bax B-Stock overzicht</title>
    <style>
        body {
            font-family: Arial, Helvetica, sans-serif;
            margin: 2rem;
            color: #222;
        }
        h1 {
            font-size: 1.4rem;
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
    <p><a href="index.php">&larr; Terug naar overzicht</a></p>
    <h1><?= htmlspecialchars($supplier['name']) ?></h1>

    <h2>Bstock producten (<?= count($products) ?>)</h2>
    <table>
        <thead>
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
        </thead>
        <tbody>
            <?php if (empty($products)): ?>
                <tr><td colspan="13">Geen producten gevonden voor deze leverancier.</td></tr>
            <?php else: foreach ($products as $row): render_product_row($row, true); endforeach; endif; ?>
        </tbody>
    </table>
</body>
</html>
