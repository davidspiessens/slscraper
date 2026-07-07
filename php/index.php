<?php

declare(strict_types=1);

$config = require __DIR__ . '/config.php';

// "localhost" laat mysqli een unix-socket gebruiken i.p.v. TCP, waardoor
// een SSH-tunnel op een custom poort genegeerd wordt. Forceer daarom TCP.
if ($config['host'] === 'localhost') {
    $config['host'] = '127.0.0.1';
}

$mysqli = new mysqli(
    $config['host'],
    $config['user'],
    $config['password'],
    $config['database'],
    $config['port']
);

if ($mysqli->connect_errno) {
    http_response_code(500);
    die('Databaseconnectie mislukt: ' . htmlspecialchars($mysqli->connect_error));
}

$mysqli->set_charset('utf8mb4');

$lightestProductsSql = "
    SELECT p.id, p.title, p.url, b.name AS brand_name, b.weight,
           lp.priceOriginal, lp.priceNow, lp.discount_label, lp.created AS price_created
    FROM bstock_product p
    JOIN brand b ON b.id = p.brand_id
    JOIN (
        SELECT bpp.bstock_product_id, bpp.priceOriginal, bpp.priceNow, bpp.discount_label, bpp.created
        FROM bstock_product_price bpp
        INNER JOIN (
            SELECT bstock_product_id, MAX(id) AS max_id
            FROM bstock_product_price
            GROUP BY bstock_product_id
        ) m ON m.max_id = bpp.id
    ) lp ON lp.bstock_product_id = p.id
    ORDER BY b.weight ASC
    LIMIT 20
";

$biggestDiscountsSql = "
    SELECT p.id, p.title, p.url,
           lp.priceOriginal, lp.priceNow, lp.discount_label, lp.created AS price_created,
           (lp.priceOriginal - lp.priceNow) AS price_diff
    FROM bstock_product p
    JOIN (
        SELECT bpp.bstock_product_id, bpp.priceOriginal, bpp.priceNow, bpp.discount_label, bpp.created
        FROM bstock_product_price bpp
        INNER JOIN (
            SELECT bstock_product_id, MAX(id) AS max_id
            FROM bstock_product_price
            GROUP BY bstock_product_id
        ) m ON m.max_id = bpp.id
    ) lp ON lp.bstock_product_id = p.id
    ORDER BY price_diff DESC
    LIMIT 20
";

$lightestProducts = $mysqli->query($lightestProductsSql)->fetch_all(MYSQLI_ASSOC);
$biggestDiscounts = $mysqli->query($biggestDiscountsSql)->fetch_all(MYSQLI_ASSOC);

$mysqli->close();

function euro(?string $value): string
{
    return $value === null ? '-' : '€ ' . number_format((float) $value, 2, ',', '.');
}

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

    <h2>20 producten met het laagste merkgewicht</h2>
    <table>
        <thead>
            <tr>
                <th>Titel</th>
                <th>Merk</th>
                <th class="num">Gewicht</th>
                <th class="num">Prijs (van)</th>
                <th class="num">Prijs (nu)</th>
                <th>Korting</th>
                <th>Prijs bijgewerkt</th>
            </tr>
        </thead>
        <tbody>
            <?php if (empty($lightestProducts)): ?>
                <tr><td colspan="7">Geen producten gevonden.</td></tr>
            <?php else: foreach ($lightestProducts as $row): ?>
                <tr>
                    <td><a href="<?= htmlspecialchars($row['url']) ?>" target="_blank" rel="noopener"><?= htmlspecialchars($row['title']) ?></a></td>
                    <td><?= htmlspecialchars($row['brand_name']) ?></td>
                    <td class="num"><?= htmlspecialchars((string) $row['weight']) ?></td>
                    <td class="num"><?= euro($row['priceOriginal']) ?></td>
                    <td class="num"><?= euro($row['priceNow']) ?></td>
                    <td><?= htmlspecialchars($row['discount_label'] ?? '') ?></td>
                    <td><?= htmlspecialchars($row['price_created']) ?></td>
                </tr>
            <?php endforeach; endif; ?>
        </tbody>
    </table>

    <h2>20 producten met het grootste prijsverschil</h2>
    <table>
        <thead>
            <tr>
                <th>Titel</th>
                <th class="num">Prijs (van)</th>
                <th class="num">Prijs (nu)</th>
                <th class="num">Verschil</th>
                <th>Korting</th>
                <th>Prijs bijgewerkt</th>
            </tr>
        </thead>
        <tbody>
            <?php if (empty($biggestDiscounts)): ?>
                <tr><td colspan="6">Geen producten gevonden.</td></tr>
            <?php else: foreach ($biggestDiscounts as $row): ?>
                <tr>
                    <td><a href="<?= htmlspecialchars($row['url']) ?>" target="_blank" rel="noopener"><?= htmlspecialchars($row['title']) ?></a></td>
                    <td class="num"><?= euro($row['priceOriginal']) ?></td>
                    <td class="num"><?= euro($row['priceNow']) ?></td>
                    <td class="num"><?= euro($row['price_diff']) ?></td>
                    <td><?= htmlspecialchars($row['discount_label'] ?? '') ?></td>
                    <td><?= htmlspecialchars($row['price_created']) ?></td>
                </tr>
            <?php endforeach; endif; ?>
        </tbody>
    </table>
</body>
</html>
