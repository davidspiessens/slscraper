<?php

declare(strict_types=1);

require __DIR__ . '/helpers.php';

$query = trim((string) ($_GET['q'] ?? ''));

$bstockResults = [];
$productResults = [];
$purchaseResults = [];
$saleResults = [];

if ($query !== '') {
    $mysqli = get_db_connection();

    // Alle rijen inladen en in PHP filteren (exact + fuzzy) i.p.v. losse
    // SQL LIKE-queries per tabel: bij deze schaal (enkele duizenden rijen)
    // is dat snel genoeg, en zo hoeft de fuzzy-logica maar op één plek
    // (bstock_product + product) te draaien. Aankopen/verkopen hebben zelf
    // geen titel — die worden nadien gefilterd op de gevonden product-/
    // bstock-id's, want hun "titel" is altijd afgeleid van die koppeling.
    $allBstock = $mysqli->query(
        'SELECT bp.id, bp.title, bp.url, b.id AS brand_id, b.name AS brand_name
         FROM bstock_product bp
         LEFT JOIN brand b ON b.id = bp.brand_id'
    )->fetch_all(MYSQLI_ASSOC);

    $allProducts = $mysqli->query(
        'SELECT p.id, p.name, b.id AS brand_id, b.name AS brand_name
         FROM product p
         LEFT JOIN brand b ON b.id = p.brand_id'
    )->fetch_all(MYSQLI_ASSOC);

    $matchRow = function (string $text) use ($query): ?string {
        if (mb_stripos($text, $query) !== false) {
            return 'exact';
        }
        if (fuzzy_matches($query, $text)) {
            return 'fuzzy';
        }
        return null;
    };

    $matchedBstockIds = [];
    foreach ($allBstock as $row) {
        $match = $matchRow($row['title'] . ' ' . ($row['brand_name'] ?? ''));
        if ($match !== null) {
            $row['match_type'] = $match;
            $bstockResults[] = $row;
            $matchedBstockIds[(int) $row['id']] = true;
        }
    }

    $matchedProductIds = [];
    foreach ($allProducts as $row) {
        $match = $matchRow($row['name'] . ' ' . ($row['brand_name'] ?? ''));
        if ($match !== null) {
            $row['match_type'] = $match;
            $productResults[] = $row;
            $matchedProductIds[(int) $row['id']] = true;
        }
    }

    // Exacte matches eerst, dan fuzzy; binnen elke groep de volgorde behouden.
    $byMatchType = fn($a, $b) => ($a['match_type'] === $b['match_type']) ? 0 : ($a['match_type'] === 'exact' ? -1 : 1);
    usort($bstockResults, $byMatchType);
    usort($productResults, $byMatchType);

    if (!empty($matchedProductIds) || !empty($matchedBstockIds)) {
        $allPurchases = $mysqli->query(
            'SELECT pu.id, pu.product_id, pu.bstock_product_id, pu.price, pu.invoice_date, pu.invoice_number,
                    p.name AS product_name, s.name AS supplier_name, bp.title AS bstock_title
             FROM purchase pu
             JOIN product p ON p.id = pu.product_id
             JOIN supplier s ON s.id = pu.supplier_id
             LEFT JOIN bstock_product bp ON bp.id = pu.bstock_product_id'
        )->fetch_all(MYSQLI_ASSOC);

        foreach ($allPurchases as $row) {
            if (isset($matchedProductIds[(int) $row['product_id']]) || isset($matchedBstockIds[(int) $row['bstock_product_id']])) {
                $purchaseResults[] = $row;
            }
        }

        $allSales = $mysqli->query(
            'SELECT sa.id, sa.price, sa.invoice_date, sa.invoice_number,
                    pu.product_id, pu.bstock_product_id,
                    p.name AS product_name, bp.title AS bstock_title
             FROM sale sa
             JOIN purchase pu ON pu.id = sa.purchase_id
             JOIN product p ON p.id = pu.product_id
             LEFT JOIN bstock_product bp ON bp.id = pu.bstock_product_id'
        )->fetch_all(MYSQLI_ASSOC);

        foreach ($allSales as $row) {
            if (isset($matchedProductIds[(int) $row['product_id']]) || isset($matchedBstockIds[(int) $row['bstock_product_id']])) {
                $saleResults[] = $row;
            }
        }
    }

    $mysqli->close();
}

?>
<!DOCTYPE html>
<html lang="nl">
<head>
    <meta charset="UTF-8">
    <title>Zoeken - Bax B-Stock overzicht</title>
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
        input[type="text"] {
            font-size: 0.95rem;
            padding: 0.4rem;
            width: 300px;
            max-width: 100%;
            box-sizing: border-box;
        }
        .fuzzy-badge {
            display: inline-block;
            font-size: 0.75rem;
            color: #8a6300;
            background: #fff3cd;
            border-radius: 3px;
            padding: 0.05rem 0.35rem;
            margin-left: 0.4rem;
        }
    </style>
</head>
<body>
    <?= render_vat_toggle() ?>
    <p><a href="index.php">&larr; Terug naar overzicht</a></p>
    <h1>Zoeken</h1>

    <form method="get" action="search.php">
        <input type="text" name="q" placeholder="Zoek op titel of merk..." value="<?= htmlspecialchars($query) ?>" autofocus>
        <button type="submit">Zoeken</button>
    </form>

    <?php if ($query === ''): ?>
        <p>Voer een zoekterm in.</p>
    <?php else: ?>
        <p class="meta">Zoekt op titel en merk. Resultaten met een <span class="fuzzy-badge">gelijkaardig</span>-label zijn geen exacte match maar wel dicht genoeg (typfouten e.d.).</p>

        <h2>Bstock-listings (<?= count($bstockResults) ?>)</h2>
        <table>
            <thead>
                <tr>
                    <th>Titel</th>
                    <th>Merk</th>
                </tr>
            </thead>
            <tbody>
                <?php if (empty($bstockResults)): ?>
                    <tr><td colspan="2">Geen bstock-listings gevonden.</td></tr>
                <?php else: foreach ($bstockResults as $row): ?>
                    <tr>
                        <td>
                            <a href="bstock_product.php?id=<?= (int) $row['id'] ?>"><?= htmlspecialchars($row['title']) ?></a>
                            &nbsp;<a href="<?= htmlspecialchars($row['url']) ?>" target="_blank" rel="noopener">&#8599;</a>
                            <?php if ($row['match_type'] === 'fuzzy'): ?><span class="fuzzy-badge">gelijkaardig</span><?php endif; ?>
                        </td>
                        <td>
                            <?php if ($row['brand_id']): ?>
                                <a href="brand.php?id=<?= (int) $row['brand_id'] ?>"><?= htmlspecialchars($row['brand_name']) ?></a>
                            <?php else: ?>
                                -
                            <?php endif; ?>
                        </td>
                    </tr>
                <?php endforeach; endif; ?>
            </tbody>
        </table>

        <h2>Producten (<?= count($productResults) ?>)</h2>
        <table>
            <thead>
                <tr>
                    <th>Naam</th>
                    <th>Merk</th>
                </tr>
            </thead>
            <tbody>
                <?php if (empty($productResults)): ?>
                    <tr><td colspan="2">Geen producten gevonden.</td></tr>
                <?php else: foreach ($productResults as $row): ?>
                    <tr>
                        <td>
                            <a href="product.php?id=<?= (int) $row['id'] ?>"><?= htmlspecialchars($row['name']) ?></a>
                            <?php if ($row['match_type'] === 'fuzzy'): ?><span class="fuzzy-badge">gelijkaardig</span><?php endif; ?>
                        </td>
                        <td>
                            <?php if ($row['brand_id']): ?>
                                <a href="brand.php?id=<?= (int) $row['brand_id'] ?>"><?= htmlspecialchars($row['brand_name']) ?></a>
                            <?php else: ?>
                                -
                            <?php endif; ?>
                        </td>
                    </tr>
                <?php endforeach; endif; ?>
            </tbody>
        </table>

        <h2>Aankopen (<?= count($purchaseResults) ?>)</h2>
        <table>
            <thead>
                <tr>
                    <th>Product</th>
                    <th>Leverancier</th>
                    <th>Bstock-listing</th>
                    <th class="num">Prijs</th>
                    <th>Factuurdatum</th>
                    <th>Factuurnummer</th>
                </tr>
            </thead>
            <tbody>
                <?php if (empty($purchaseResults)): ?>
                    <tr><td colspan="6">Geen aankopen gevonden.</td></tr>
                <?php else: foreach ($purchaseResults as $row): ?>
                    <tr>
                        <td><a href="product.php?id=<?= (int) $row['product_id'] ?>"><?= htmlspecialchars($row['product_name']) ?></a></td>
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
                    </tr>
                <?php endforeach; endif; ?>
            </tbody>
        </table>

        <h2>Verkopen (<?= count($saleResults) ?>)</h2>
        <table>
            <thead>
                <tr>
                    <th>Product</th>
                    <th>Bstock-listing</th>
                    <th class="num">Prijs</th>
                    <th>Factuurdatum</th>
                    <th>Factuurnummer</th>
                </tr>
            </thead>
            <tbody>
                <?php if (empty($saleResults)): ?>
                    <tr><td colspan="5">Geen verkopen gevonden.</td></tr>
                <?php else: foreach ($saleResults as $row): ?>
                    <tr>
                        <td><a href="product.php?id=<?= (int) $row['product_id'] ?>"><?= htmlspecialchars($row['product_name']) ?></a></td>
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
                    </tr>
                <?php endforeach; endif; ?>
            </tbody>
        </table>

    <?php endif; ?>
</body>
</html>
