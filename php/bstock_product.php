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
    'SELECT p.id, p.title, p.url, p.created AS product_created, p.product_id, p.ignored,
            b.id AS brand_id, b.name AS brand_name, b.weight
     FROM bstock_product p
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

$historyStmt = $mysqli->prepare(
    'SELECT priceOriginal, priceNow, discount_label, created
     FROM bstock_product_price
     WHERE bstock_product_id = ?
     ORDER BY created ASC, id ASC'
);
$historyStmt->bind_param('i', $productId);
$historyStmt->execute();
$history = $historyStmt->get_result()->fetch_all(MYSQLI_ASSOC);
$historyStmt->close();

$mysqli->close();

$chart = render_price_chart($history);
$historyDesc = array_reverse($history);

?>
<!DOCTYPE html>
<html lang="nl">
<head>
    <meta charset="UTF-8">
    <title><?= htmlspecialchars($product['title']) ?> - Bax B-Stock overzicht</title>
    <style>
        body {
            font-family: Arial, Helvetica, sans-serif;
            margin: 2rem;
            color: #222;
        }
        h1 {
            font-size: 1.3rem;
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
        .meta {
            margin: 0.2rem 0;
        }
    </style>
</head>
<body>
    <p><a href="index.php">&larr; Terug naar overzicht</a></p>
    <h1><?= htmlspecialchars($product['title']) ?></h1>

    <p class="meta">
        Merk:
        <?php if ($product['brand_id']): ?>
            <a href="brand.php?id=<?= (int) $product['brand_id'] ?>"><?= htmlspecialchars($product['brand_name']) ?></a>
            (gewicht: <?= htmlspecialchars((string) $product['weight']) ?>)
        <?php else: ?>
            -
        <?php endif; ?>
    </p>
    <p class="meta">Product aangemaakt: <?= htmlspecialchars($product['product_created']) ?></p>
    <p class="meta"><a href="<?= htmlspecialchars($product['url']) ?>" target="_blank" rel="noopener">Bekijk op bax-shop.be &#8599;</a></p>
    <?php if ($product['product_id']): ?>
        <p class="meta"><a href="product.php?id=<?= (int) $product['product_id'] ?>">Bekijk productoverzicht &rarr;</a></p>
    <?php endif; ?>
    <p class="meta">
        Genegeerd: <?= $product['ignored'] ? 'Ja' : 'Nee' ?>
        <?php if (!$product['ignored']): ?>
            <form method="post" action="ignore_bstock_product.php" style="display:inline;">
                <input type="hidden" name="id" value="<?= (int) $product['id'] ?>">
                <input type="hidden" name="redirect" value="<?= htmlspecialchars($_SERVER['REQUEST_URI'] ?? 'index.php') ?>">
                <button type="submit" onclick="return confirm('Dit product negeren?');">Negeren</button>
            </form>
        <?php endif; ?>
    </p>

    <h2>Prijshistoriek</h2>
    <?= $chart ?>

    <table>
        <thead>
            <tr>
                <th>Datum</th>
                <th class="num">Prijs (van)</th>
                <th class="num">Prijs (nu)</th>
                <th class="num">Verschil</th>
                <th>Korting</th>
            </tr>
        </thead>
        <tbody>
            <?php if (empty($historyDesc)): ?>
                <tr><td colspan="5">Geen prijshistoriek gevonden.</td></tr>
            <?php else: foreach ($historyDesc as $row): ?>
                <tr>
                    <td><?= htmlspecialchars($row['created']) ?></td>
                    <td class="num"><?= euro($row['priceOriginal']) ?></td>
                    <td class="num"><?= euro($row['priceNow']) ?></td>
                    <td class="num"><?= euro((string) ($row['priceOriginal'] - $row['priceNow'])) ?></td>
                    <td><?= htmlspecialchars($row['discount_label'] ?? '') ?></td>
                </tr>
            <?php endforeach; endif; ?>
        </tbody>
    </table>
</body>
</html>
