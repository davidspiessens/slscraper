<?php

declare(strict_types=1);

require __DIR__ . '/helpers.php';

$mysqli = get_db_connection();

$sql = "
    SELECT pu.id, pu.price, pu.invoice_date, pu.invoice_number,
           p.id AS product_id, p.name AS product_name,
           b.id AS brand_id, b.name AS brand_name,
           s.id AS supplier_id, s.name AS supplier_name,
           bp.id AS bstock_product_id, bp.title AS bstock_title,
           sa.id AS sale_id, sa.price AS sale_price
    FROM purchase pu
    JOIN product p ON p.id = pu.product_id
    LEFT JOIN brand b ON b.id = p.brand_id
    JOIN supplier s ON s.id = pu.supplier_id
    LEFT JOIN bstock_product bp ON bp.id = pu.bstock_product_id
    LEFT JOIN sale sa ON sa.purchase_id = pu.id
    ORDER BY pu.invoice_date DESC, pu.id DESC
";

$purchases = $mysqli->query($sql)->fetch_all(MYSQLI_ASSOC);

$mysqli->close();

?>
<!DOCTYPE html>
<html lang="nl">
<head>
    <meta charset="UTF-8">
    <title>Aankopen - Bax B-Stock overzicht</title>
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
    <h1>Aankopen (<?= count($purchases) ?>)</h1>
    <p class="meta"><a href="add_purchase.php">+ Nieuwe aankoop registreren</a></p>

    <table>
        <thead>
            <tr>
                <th>Product</th>
                <th>Merk</th>
                <th>Leverancier</th>
                <th>Bstock-listing</th>
                <th class="num">Prijs</th>
                <th>Factuurdatum</th>
                <th>Factuurnummer</th>
                <th>Verkoop</th>
                <th>Actie</th>
            </tr>
        </thead>
        <tbody>
            <?php if (empty($purchases)): ?>
                <tr><td colspan="9">Geen aankopen gevonden.</td></tr>
            <?php else: foreach ($purchases as $row): ?>
                <tr>
                    <td><a href="product.php?id=<?= (int) $row['product_id'] ?>"><?= htmlspecialchars($row['product_name']) ?></a></td>
                    <td>
                        <?php if ($row['brand_id']): ?>
                            <a href="brand.php?id=<?= (int) $row['brand_id'] ?>"><?= htmlspecialchars($row['brand_name']) ?></a>
                        <?php else: ?>
                            -
                        <?php endif; ?>
                    </td>
                    <td><a href="supplier.php?id=<?= (int) $row['supplier_id'] ?>"><?= htmlspecialchars($row['supplier_name']) ?></a></td>
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
                    <td>
                        <?php if ($row['sale_id']): ?>
                            Verkocht (<?= euro((string) $row['sale_price']) ?>)
                        <?php else: ?>
                            <a href="add_sale.php?purchase_id=<?= (int) $row['id'] ?>">Verkoop registreren &rarr;</a>
                        <?php endif; ?>
                    </td>
                    <td><a href="add_purchase.php?id=<?= (int) $row['id'] ?>" title="Bewerken">&#9999;&#65039;</a></td>
                </tr>
            <?php endforeach; endif; ?>
        </tbody>
    </table>
</body>
</html>
