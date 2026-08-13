<?php

declare(strict_types=1);

require __DIR__ . '/helpers.php';

$brandId = filter_input(INPUT_GET, 'id', FILTER_VALIDATE_INT);

if (!$brandId) {
    http_response_code(400);
    die('Ongeldig of ontbrekend merk-id.');
}

$mysqli = get_db_connection();

$brandStmt = $mysqli->prepare('SELECT id, name, weight, ignored FROM brand WHERE id = ?');
$brandStmt->bind_param('i', $brandId);
$brandStmt->execute();
$brand = $brandStmt->get_result()->fetch_assoc();
$brandStmt->close();

if (!$brand) {
    http_response_code(404);
    die('Merk niet gevonden.');
}

$productsSql = "
    SELECT p.id, p.title, p.url, p.created AS product_created, p.product_id, p.archived,
           b.id AS brand_id, b.name AS brand_name, b.weight, b.ignored AS brand_ignored,
           sup.name AS supplier_name,
           lp.priceOriginal, lp.priceNow, lp.discount_label, lp.created AS price_created,
           (lp.priceOriginal - lp.priceNow) AS price_diff,
           pr.highest_price, pr.lowest_price
    FROM bstock_product p
    JOIN brand b ON b.id = p.brand_id
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
    WHERE p.brand_id = ? AND p.ignored = 0
    ORDER BY p.archived ASC, p.created DESC
";

$productsStmt = $mysqli->prepare($productsSql);
$productsStmt->bind_param('i', $brandId);
$productsStmt->execute();
$products = $productsStmt->get_result()->fetch_all(MYSQLI_ASSOC);
$productsStmt->close();

$allProductsStmt = $mysqli->prepare(
    'SELECT id, name, ean, archived, created FROM product WHERE brand_id = ? AND ignored = 0 ORDER BY name ASC'
);
$allProductsStmt->bind_param('i', $brandId);
$allProductsStmt->execute();
$allProducts = $allProductsStmt->get_result()->fetch_all(MYSQLI_ASSOC);
$allProductsStmt->close();

$mysqli->close();

?>
<!DOCTYPE html>
<html lang="nl">
<head>
    <meta charset="UTF-8">
    <title><?= htmlspecialchars($brand['name']) ?> - Bax B-Stock overzicht</title>
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
    <h1><?= htmlspecialchars($brand['name']) ?> (gewicht: <?= htmlspecialchars((string) $brand['weight']) ?>)</h1>

    <p class="meta">
        Genegeerd: <?= $brand['ignored'] ? 'Ja' : 'Nee' ?>
        <?php if (!$brand['ignored']): ?>
            <form method="post" action="ignore_brand.php" style="display:inline;">
                <input type="hidden" name="id" value="<?= (int) $brand['id'] ?>">
                <input type="hidden" name="redirect" value="<?= htmlspecialchars($_SERVER['REQUEST_URI'] ?? 'index.php') ?>">
                <button type="submit" title="Negeren" onclick="return confirm('Dit merk negeren?');">&#128683;</button>
            </form>
        <?php endif; ?>
    </p>

    <h2>Bstock producten</h2>
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
                <tr><td colspan="13">Geen producten gevonden voor dit merk.</td></tr>
            <?php else: foreach ($products as $row): render_product_row($row, true); endforeach; endif; ?>
        </tbody>
    </table>

    <h2>Producten (<?= count($allProducts) ?>)</h2>
    <table>
        <thead>
            <tr>
                <th>Naam</th>
                <th>EAN</th>
                <th>Gearchiveerd</th>
                <th>Aangemaakt</th>
                <th>Actie</th>
            </tr>
        </thead>
        <tbody>
            <?php if (empty($allProducts)): ?>
                <tr><td colspan="5">Geen producten gevonden voor dit merk.</td></tr>
            <?php else: foreach ($allProducts as $row): ?>
                <tr>
                    <td><a href="product.php?id=<?= (int) $row['id'] ?>"><?= htmlspecialchars($row['name']) ?></a></td>
                    <td><?= $row['ean'] !== null ? htmlspecialchars($row['ean']) : '-' ?></td>
                    <td><?= $row['archived'] ? 'Ja' : 'Nee' ?></td>
                    <td><?= htmlspecialchars($row['created']) ?></td>
                    <td>
                        <form method="post" action="ignore_product.php" style="margin:0;">
                            <input type="hidden" name="id" value="<?= (int) $row['id'] ?>">
                            <input type="hidden" name="redirect" value="<?= htmlspecialchars($_SERVER['REQUEST_URI'] ?? 'index.php') ?>">
                            <button type="submit" title="Negeren" onclick="return confirm('Dit product negeren?');">&#128683;</button>
                        </form>
                    </td>
                </tr>
            <?php endforeach; endif; ?>
        </tbody>
    </table>

    <h2>Merk hernoemen</h2>
    <form method="post" action="update_brand_name.php">
        <input type="hidden" name="id" value="<?= (int) $brand['id'] ?>">
        <input type="text" name="name" value="<?= htmlspecialchars($brand['name']) ?>" required>
        <button type="submit" title="Opslaan">&#128190;</button>
    </form>

    <h2>Gewicht aanpassen</h2>
    <form method="post" action="update_brand_weight.php">
        <input type="hidden" name="id" value="<?= (int) $brand['id'] ?>">
        <input type="number" name="weight" value="<?= (int) $brand['weight'] ?>" required>
        <button type="submit" title="Opslaan">&#128190;</button>
    </form>
</body>
</html>
