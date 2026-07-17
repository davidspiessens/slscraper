<?php

declare(strict_types=1);

require __DIR__ . '/helpers.php';

$productId = filter_input(INPUT_GET, 'id', FILTER_VALIDATE_INT);

if (!$productId) {
    http_response_code(400);
    die('Ongeldig of ontbrekend product-id.');
}

$mysqli = get_db_connection();

$productStmt = $mysqli->prepare(
    'SELECT p.id, p.name, p.ean, p.archived, p.created,
            b.id AS brand_id, b.name AS brand_name, b.weight
     FROM product p
     LEFT JOIN brand b ON b.id = p.brand_id
     WHERE p.id = ?'
);
$productStmt->bind_param('i', $productId);
$productStmt->execute();
$product = $productStmt->get_result()->fetch_assoc();
$productStmt->close();

if (!$product) {
    http_response_code(404);
    die('Product niet gevonden.');
}

$listingsSql = "
    SELECT bp.id, bp.title, bp.url, bp.created AS product_created, bp.product_id, bp.ignored,
           b.id AS brand_id, b.name AS brand_name, b.weight,
           lp.priceOriginal, lp.priceNow, lp.discount_label, lp.created AS price_created,
           (lp.priceOriginal - lp.priceNow) AS price_diff,
           pr.highest_price, pr.lowest_price
    FROM bstock_product bp
    LEFT JOIN brand b ON b.id = bp.brand_id
    JOIN (
        SELECT bpp.bstock_product_id, bpp.priceOriginal, bpp.priceNow, bpp.discount_label, bpp.created
        FROM bstock_product_price bpp
        INNER JOIN (
            SELECT bstock_product_id, MAX(id) AS max_id
            FROM bstock_product_price
            GROUP BY bstock_product_id
        ) m ON m.max_id = bpp.id
    ) lp ON lp.bstock_product_id = bp.id
    JOIN (
        SELECT bstock_product_id,
               MAX(priceNow) AS highest_price,
               MIN(priceNow) AS lowest_price
        FROM bstock_product_price
        GROUP BY bstock_product_id
    ) pr ON pr.bstock_product_id = bp.id
    WHERE bp.product_id = ? AND bp.ignored = 0
    ORDER BY bp.created DESC
";

$listingsStmt = $mysqli->prepare($listingsSql);
$listingsStmt->bind_param('i', $productId);
$listingsStmt->execute();
$listings = $listingsStmt->get_result()->fetch_all(MYSQLI_ASSOC);
$listingsStmt->close();

$suppliersStmt = $mysqli->prepare(
    'SELECT s.name AS supplier_name, ps.url
     FROM product_x_supplier ps
     JOIN supplier s ON s.id = ps.supplier_id
     WHERE ps.product_id = ?
     ORDER BY s.name ASC'
);
$suppliersStmt->bind_param('i', $productId);
$suppliersStmt->execute();
$suppliers = $suppliersStmt->get_result()->fetch_all(MYSQLI_ASSOC);
$suppliersStmt->close();

$mysqli->close();

?>
<!DOCTYPE html>
<html lang="nl">
<head>
    <meta charset="UTF-8">
    <title><?= htmlspecialchars($product['name']) ?> - Bax B-Stock overzicht</title>
    <style>
        body {
            font-family: Arial, Helvetica, sans-serif;
            margin: 2rem;
            color: #222;
        }
        h1 {
            font-size: 1.3rem;
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
        .meta {
            margin: 0.2rem 0;
        }
    </style>
</head>
<body>
    <p><a href="index.php">&larr; Terug naar overzicht</a></p>
    <h1><?= htmlspecialchars($product['name']) ?></h1>

    <p class="meta">
        Merk:
        <?php if ($product['brand_id']): ?>
            <a href="brand.php?id=<?= (int) $product['brand_id'] ?>"><?= htmlspecialchars($product['brand_name']) ?></a>
            (gewicht: <?= htmlspecialchars((string) $product['weight']) ?>)
        <?php else: ?>
            -
        <?php endif; ?>
    </p>
    <p class="meta">EAN: <?= $product['ean'] !== null ? htmlspecialchars($product['ean']) : '-' ?></p>
    <p class="meta">Product aangemaakt: <?= htmlspecialchars($product['created']) ?></p>

    <h2>Leveranciers</h2>
    <?php if (empty($suppliers)): ?>
        <p>Geen leveranciers gevonden voor dit product.</p>
    <?php else: ?>
        <p class="meta">
            <?php foreach ($suppliers as $i => $supplier): ?>
                <?= $i > 0 ? ' - ' : '' ?><a href="<?= htmlspecialchars($supplier['url']) ?>" target="_blank" rel="noopener"><?= htmlspecialchars($supplier['supplier_name']) ?> &#8599;</a>
            <?php endforeach; ?>
        </p>
    <?php endif; ?>

    <h2>B-stock listings (<?= count($listings) ?>)</h2>
    <table>
        <thead>
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
        </thead>
        <tbody>
            <?php if (empty($listings)): ?>
                <tr><td colspan="12">Geen B-stock listings gevonden voor dit product.</td></tr>
            <?php else: foreach ($listings as $row): render_product_row($row); endforeach; endif; ?>
        </tbody>
    </table>

    <h2>Naam bewerken</h2>
    <form method="post" action="update_product_name.php">
        <input type="hidden" name="id" value="<?= (int) $product['id'] ?>">
        <input type="text" name="name" value="<?= htmlspecialchars($product['name']) ?>" size="100" required>
        <button type="submit">Opslaan</button>
    </form>
</body>
</html>
