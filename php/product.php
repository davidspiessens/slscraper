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
    'SELECT p.id, p.name, p.ean, p.archived, p.ignored, p.created,
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
    SELECT bp.id, bp.title, bp.url, bp.created AS product_created, bp.product_id, bp.ignored, bp.archived,
           b.id AS brand_id, b.name AS brand_name, b.weight, b.ignored AS brand_ignored,
           sup.id AS supplier_id, sup.name AS supplier_name,
           lp.priceOriginal, lp.priceNow, lp.discount_label, lp.created AS price_created,
           (lp.priceOriginal - lp.priceNow) AS price_diff,
           pr.highest_price, pr.lowest_price
    FROM bstock_product bp
    LEFT JOIN brand b ON b.id = bp.brand_id
    LEFT JOIN supplier sup ON sup.id = bp.supplier_id
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

$priceSeries = [];
$listingIds = array_column($listings, 'id');
if (!empty($listingIds)) {
    $placeholders = implode(',', array_fill(0, count($listingIds), '?'));
    $types = str_repeat('i', count($listingIds));

    $historyStmt = $mysqli->prepare(
        "SELECT bstock_product_id, priceNow, created
         FROM bstock_product_price
         WHERE bstock_product_id IN ($placeholders)
         ORDER BY created ASC, id ASC"
    );
    $historyStmt->bind_param($types, ...$listingIds);
    $historyStmt->execute();
    $priceHistoryRows = $historyStmt->get_result()->fetch_all(MYSQLI_ASSOC);
    $historyStmt->close();

    $pointsByListing = [];
    foreach ($priceHistoryRows as $row) {
        $pointsByListing[$row['bstock_product_id']][] = [
            't' => strtotime($row['created']),
            'price' => (float) $row['priceNow'],
        ];
    }

    foreach ($pointsByListing as $listingId => $points) {
        $priceSeries[] = ['label' => "#$listingId", 'points' => $points];
    }
}
$allPrices = array_column(array_merge(...array_column($priceSeries, 'points')), 'price');
$minPrice = empty($allPrices) ? null : (string) min($allPrices);
$maxPrice = empty($allPrices) ? null : (string) max($allPrices);

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

$purchasesStmt = $mysqli->prepare(
    'SELECT pu.id, pu.price, pu.invoice_date, pu.invoice_number,
            s.name AS supplier_name,
            bp.id AS bstock_product_id, bp.title AS bstock_title
     FROM purchase pu
     JOIN supplier s ON s.id = pu.supplier_id
     LEFT JOIN bstock_product bp ON bp.id = pu.bstock_product_id
     WHERE pu.product_id = ?
     ORDER BY pu.invoice_date DESC, pu.id DESC'
);
$purchasesStmt->bind_param('i', $productId);
$purchasesStmt->execute();
$purchases = $purchasesStmt->get_result()->fetch_all(MYSQLI_ASSOC);
$purchasesStmt->close();

$mysqli->close();

// Aankopen op de gedeelde tijdsas van de grafiek tonen, duidelijk
// onderscheiden van de (per-listing gekleurde) b-stock prijspunten.
$purchasePoints = array_map(fn($p) => [
    't' => strtotime($p['invoice_date']),
    'price' => (float) $p['price'],
    'label' => $p['supplier_name'],
], $purchases);
$listingsChart = render_multi_price_chart($priceSeries, $purchasePoints);

// Merknaam zit niet meer in product.name (zie ignore_product.php-historiek) —
// hier expliciet samenvoegen voor titel/heading, elders (bv. de productlijst
// op brand.php) volstaat de kale naam omdat het merk al uit de context blijkt.
$productFullName = trim(($product['brand_name'] ?? '') . ' ' . $product['name']);

?>
<!DOCTYPE html>
<html lang="nl">
<head>
    <meta charset="UTF-8">
    <title><?= htmlspecialchars($productFullName) ?> - Bax B-Stock overzicht</title>
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
    <h1><?= htmlspecialchars($productFullName) ?></h1>

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
    <p class="meta">
        Genegeerd: <?= $product['ignored'] ? 'Ja' : 'Nee' ?>
        <?php if (!$product['ignored']): ?>
            <form method="post" action="ignore_product.php" style="display:inline;">
                <input type="hidden" name="id" value="<?= (int) $product['id'] ?>">
                <input type="hidden" name="redirect" value="<?= htmlspecialchars($_SERVER['REQUEST_URI'] ?? 'index.php') ?>">
                <button type="submit" title="Negeren" onclick="return confirm('Dit product negeren?');">&#128683;</button>
            </form>
        <?php endif; ?>
    </p>
    <p class="meta">Laagste prijs: <?= euro($minPrice) ?> &nbsp;|&nbsp; Hoogste prijs: <?= euro($maxPrice) ?></p>
    <p class="meta"><a href="add_purchase.php?product_id=<?= (int) $product['id'] ?>">Aankoop registreren &rarr;</a></p>

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
            <?php if (empty($listings)): ?>
                <tr><td colspan="13">Geen B-stock listings gevonden voor dit product.</td></tr>
            <?php else: foreach ($listings as $row): render_product_row($row); endforeach; endif; ?>
        </tbody>
    </table>

    <h2>Prijsverloop (alle gekoppelde B-stock listings)</h2>
    <?= $listingsChart ?>

    <h2>Aankopen (<?= count($purchases) ?>)</h2>
    <table>
        <thead>
            <tr>
                <th>Leverancier</th>
                <th>Bstock-listing</th>
                <th class="num">Prijs</th>
                <th>Factuurdatum</th>
                <th>Factuurnummer</th>
                <th>Actie</th>
            </tr>
        </thead>
        <tbody>
            <?php if (empty($purchases)): ?>
                <tr><td colspan="6">Geen aankopen gevonden voor dit product.</td></tr>
            <?php else: foreach ($purchases as $row): ?>
                <tr>
                    <td><?= htmlspecialchars($row['supplier_name']) ?></td>
                    <td>
                        <?php if ($row['bstock_product_id']): ?>
                            <a href="bstock_product.php?id=<?= (int) $row['bstock_product_id'] ?>"><?= htmlspecialchars($row['bstock_title']) ?></a>
                        <?php else: ?>
                            -
                        <?php endif; ?>
                    </td>
                    <td class="num"><?= euro((string) $row['price']) ?></td>
                    <td><?= htmlspecialchars($row['invoice_date']) ?></td>
                    <td><?= htmlspecialchars($row['invoice_number']) ?></td>
                    <td><a href="add_purchase.php?id=<?= (int) $row['id'] ?>" title="Bewerken">&#9999;&#65039;</a></td>
                </tr>
            <?php endforeach; endif; ?>
        </tbody>
    </table>

    <h2>Naam bewerken</h2>
    <form method="post" action="update_product_name.php">
        <input type="hidden" name="id" value="<?= (int) $product['id'] ?>">
        <input type="text" name="name" value="<?= htmlspecialchars($product['name']) ?>" size="100" required>
        <button type="submit" title="Opslaan">&#128190;</button>
    </form>
</body>
</html>
