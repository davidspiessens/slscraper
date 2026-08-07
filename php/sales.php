<?php

declare(strict_types=1);

require __DIR__ . '/helpers.php';

$mysqli = get_db_connection();

$sql = "
    SELECT sa.id, sa.price AS sale_price, sa.invoice_date AS sale_invoice_date, sa.invoice_number AS sale_invoice_number,
           pu.id AS purchase_id, pu.price AS purchase_price, pu.invoice_date AS purchase_invoice_date, pu.invoice_number AS purchase_invoice_number,
           p.id AS product_id, p.name AS product_name,
           b.id AS brand_id, b.name AS brand_name,
           s.name AS supplier_name,
           (sa.price - pu.price) AS profit
    FROM sale sa
    JOIN purchase pu ON pu.id = sa.purchase_id
    JOIN product p ON p.id = pu.product_id
    LEFT JOIN brand b ON b.id = p.brand_id
    JOIN supplier s ON s.id = pu.supplier_id
    ORDER BY sa.invoice_date DESC, sa.id DESC
";

$sales = $mysqli->query($sql)->fetch_all(MYSQLI_ASSOC);

$mysqli->close();

?>
<!DOCTYPE html>
<html lang="nl">
<head>
    <meta charset="UTF-8">
    <title>Verkopen - Bax B-Stock overzicht</title>
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
    <h1>Verkopen (<?= count($sales) ?>)</h1>
    <p class="meta"><a href="add_sale.php">+ Nieuwe verkoop registreren</a></p>

    <table>
        <thead>
            <tr>
                <th>Product</th>
                <th>Merk</th>
                <th>Leverancier</th>
                <th class="num">Aankoopprijs</th>
                <th class="num">Verkoopprijs</th>
                <th class="num">Marge (excl. BTW)</th>
                <th>Verkoopfactuurdatum</th>
                <th>Verkoopfactuurnummer</th>
                <th>Actie</th>
            </tr>
        </thead>
        <tbody>
            <?php if (empty($sales)): ?>
                <tr><td colspan="9">Geen verkopen gevonden.</td></tr>
            <?php else: foreach ($sales as $row): ?>
                <tr>
                    <td><a href="product.php?id=<?= (int) $row['product_id'] ?>"><?= htmlspecialchars($row['product_name']) ?></a></td>
                    <td>
                        <?php if ($row['brand_id']): ?>
                            <a href="brand.php?id=<?= (int) $row['brand_id'] ?>"><?= htmlspecialchars($row['brand_name']) ?></a>
                        <?php else: ?>
                            -
                        <?php endif; ?>
                    </td>
                    <td><?= htmlspecialchars($row['supplier_name']) ?></td>
                    <td class="num"><?= euro((string) $row['purchase_price']) ?></td>
                    <td class="num"><?= euro((string) $row['sale_price']) ?></td>
                    <td class="num"><?= euro_excl((string) $row['profit']) ?></td>
                    <td><?= htmlspecialchars($row['sale_invoice_date']) ?></td>
                    <td><?= htmlspecialchars($row['sale_invoice_number']) ?></td>
                    <td><a href="add_sale.php?id=<?= (int) $row['id'] ?>" title="Bewerken">&#9999;&#65039;</a></td>
                </tr>
            <?php endforeach; endif; ?>
        </tbody>
    </table>
</body>
</html>
