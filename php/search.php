<?php

declare(strict_types=1);

require __DIR__ . '/helpers.php';

$query = trim((string) ($_GET['q'] ?? ''));

$bstockRows = [];
$productRows = [];
$purchaseRows = [];
$saleRows = [];
$bstockTotal = 0;
$productTotal = 0;

if ($query !== '') {
    $mysqli = get_db_connection();

    // Alle rijen inladen en in PHP filteren (exact + fuzzy) i.p.v. losse
    // SQL LIKE-queries per tabel: bij deze schaal (enkele duizenden rijen)
    // is dat snel genoeg, en zo hoeft de fuzzy-logica maar op één plek
    // (bstock_product + product) te draaien. Aankopen/verkopen hebben zelf
    // geen titel — die worden nadien gefilterd op de gevonden product-/
    // bstock-id's, want hun "titel" is altijd afgeleid van die koppeling.
    $allBstock = $mysqli->query(
        'SELECT bp.id, bp.title, b.name AS brand_name FROM bstock_product bp LEFT JOIN brand b ON b.id = bp.brand_id'
    )->fetch_all(MYSQLI_ASSOC);

    $allProducts = $mysqli->query(
        'SELECT p.id, p.name, b.name AS brand_name FROM product p LEFT JOIN brand b ON b.id = p.brand_id'
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

    // Gesorteerd houden: exacte matches eerst, dan fuzzy, en binnen elke
    // groep de oorspronkelijke volgorde behouden. matchTypeById bepaalt
    // straks de "gelijkaardig"-badge en de uiteindelijke rijvolgorde.
    $matchTypeById = [];
    foreach ($allBstock as $row) {
        $match = $matchRow($row['title'] . ' ' . ($row['brand_name'] ?? ''));
        if ($match !== null) {
            $matchTypeById[(int) $row['id']] = $match;
        }
    }
    $bstockIds = array_keys($matchTypeById);
    usort($bstockIds, fn($a, $b) => $matchTypeById[$a] === $matchTypeById[$b] ? 0 : ($matchTypeById[$a] === 'exact' ? -1 : 1));
    $bstockTotal = count($bstockIds);

    $productMatchTypeById = [];
    foreach ($allProducts as $row) {
        $match = $matchRow($row['name'] . ' ' . ($row['brand_name'] ?? ''));
        if ($match !== null) {
            $productMatchTypeById[(int) $row['id']] = $match;
        }
    }
    $productIds = array_keys($productMatchTypeById);
    usort($productIds, fn($a, $b) => $productMatchTypeById[$a] === $productMatchTypeById[$b] ? 0 : ($productMatchTypeById[$a] === 'exact' ? -1 : 1));
    $productTotal = count($productIds);

    // Dezelfde "laatste prijs" / "hoogste-laagste prijs"-subqueries als
    // index.php/brand.php/product.php, zodat de bstock-tabel hier exact
    // dezelfde kolommen kan tonen via render_product_row().
    $latestPriceJoin = "
        JOIN (
            SELECT bpp.bstock_product_id, bpp.priceOriginal, bpp.priceNow, bpp.discount_label, bpp.created
            FROM bstock_product_price bpp
            INNER JOIN (
                SELECT bstock_product_id, MAX(id) AS max_id
                FROM bstock_product_price
                GROUP BY bstock_product_id
            ) m ON m.max_id = bpp.id
        ) lp ON lp.bstock_product_id = bp.id
    ";
    $priceRangeJoin = "
        JOIN (
            SELECT bstock_product_id, MAX(priceNow) AS highest_price, MIN(priceNow) AS lowest_price
            FROM bstock_product_price
            GROUP BY bstock_product_id
        ) pr ON pr.bstock_product_id = bp.id
    ";

    if (!empty($bstockIds)) {
        $placeholders = implode(',', array_fill(0, count($bstockIds), '?'));
        $types = str_repeat('i', count($bstockIds));

        $bstockSql = "
            SELECT bp.id, bp.title, bp.url, bp.created AS product_created, bp.product_id, bp.ignored, bp.archived,
                   b.id AS brand_id, b.name AS brand_name, b.weight, b.ignored AS brand_ignored,
                   sup.id AS supplier_id, sup.name AS supplier_name,
                   lp.priceOriginal, lp.priceNow, lp.discount_label, lp.created AS price_created,
                   (lp.priceOriginal - lp.priceNow) AS price_diff,
                   pr.highest_price, pr.lowest_price
            FROM bstock_product bp
            LEFT JOIN brand b ON b.id = bp.brand_id
            LEFT JOIN supplier sup ON sup.id = bp.supplier_id
            $latestPriceJoin
            $priceRangeJoin
            WHERE bp.id IN ($placeholders)
        ";
        $stmt = $mysqli->prepare($bstockSql);
        $stmt->bind_param($types, ...$bstockIds);
        $stmt->execute();
        $byId = [];
        foreach ($stmt->get_result()->fetch_all(MYSQLI_ASSOC) as $row) {
            $byId[(int) $row['id']] = $row;
        }
        $stmt->close();
        // Enkel rijen met minstens één prijs komen hierboven mee terug (INNER
        // JOIN) — sla ontbrekende id's over i.p.v. te crashen.
        foreach ($bstockIds as $id) {
            if (isset($byId[$id])) {
                $bstockRows[] = $byId[$id];
            }
        }
    }

    if (!empty($productIds)) {
        $placeholders = implode(',', array_fill(0, count($productIds), '?'));
        $types = str_repeat('i', count($productIds));

        $productSql = "
            SELECT p.id, p.name, p.ean, p.archived, p.created,
                   b.id AS brand_id, b.name AS brand_name
            FROM product p
            LEFT JOIN brand b ON b.id = p.brand_id
            WHERE p.id IN ($placeholders)
        ";
        $stmt = $mysqli->prepare($productSql);
        $stmt->bind_param($types, ...$productIds);
        $stmt->execute();
        $byId = [];
        foreach ($stmt->get_result()->fetch_all(MYSQLI_ASSOC) as $row) {
            $byId[(int) $row['id']] = $row;
        }
        $stmt->close();
        foreach ($productIds as $id) {
            if (isset($byId[$id])) {
                $productRows[] = $byId[$id];
            }
        }
    }

    if (!empty($productIds) || !empty($bstockIds)) {
        $productPlaceholders = !empty($productIds) ? implode(',', array_fill(0, count($productIds), '?')) : 'NULL';
        $bstockPlaceholders = !empty($bstockIds) ? implode(',', array_fill(0, count($bstockIds), '?')) : 'NULL';
        $params = array_merge($productIds, $bstockIds);
        $types = str_repeat('i', count($params));

        // Zelfde kolommen als purchases.php, gefilterd op de gevonden product-/bstock-id's.
        $purchaseSql = "
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
            WHERE pu.product_id IN ($productPlaceholders) OR pu.bstock_product_id IN ($bstockPlaceholders)
            ORDER BY pu.invoice_date DESC, pu.id DESC
        ";
        if (empty($params)) {
            $purchaseRows = [];
        } else {
            $stmt = $mysqli->prepare($purchaseSql);
            $stmt->bind_param($types, ...$params);
            $stmt->execute();
            $purchaseRows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
            $stmt->close();
        }

        // Zelfde kolommen als sales.php, gefilterd op de gevonden product-/bstock-id's.
        $saleSql = "
            SELECT sa.id, sa.price AS sale_price, sa.invoice_date AS sale_invoice_date, sa.invoice_number AS sale_invoice_number,
                   pu.id AS purchase_id, pu.price AS purchase_price,
                   p.id AS product_id, p.name AS product_name,
                   b.id AS brand_id, b.name AS brand_name,
                   s.id AS supplier_id, s.name AS supplier_name,
                   (sa.price - pu.price) AS profit
            FROM sale sa
            JOIN purchase pu ON pu.id = sa.purchase_id
            JOIN product p ON p.id = pu.product_id
            LEFT JOIN brand b ON b.id = p.brand_id
            JOIN supplier s ON s.id = pu.supplier_id
            WHERE pu.product_id IN ($productPlaceholders) OR pu.bstock_product_id IN ($bstockPlaceholders)
            ORDER BY sa.invoice_date DESC, sa.id DESC
        ";
        if (empty($params)) {
            $saleRows = [];
        } else {
            $stmt = $mysqli->prepare($saleSql);
            $stmt->bind_param($types, ...$params);
            $stmt->execute();
            $saleRows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
            $stmt->close();
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

        <h2>Bstock-listings (<?= $bstockTotal ?>)</h2>
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
                <?php if (empty($bstockRows)): ?>
                    <tr><td colspan="13">Geen bstock-listings gevonden.</td></tr>
                <?php else: foreach ($bstockRows as $row): ?>
                    <?php
                    $badge = $matchTypeById[(int) $row['id']] === 'fuzzy'
                        ? '<span class="fuzzy-badge">gelijkaardig</span>'
                        : null;
                    render_product_row($row, true, $badge);
                    ?>
                <?php endforeach; endif; ?>
            </tbody>
        </table>

        <h2>Producten (<?= $productTotal ?>)</h2>
        <table>
            <thead>
                <tr>
                    <th>Naam</th>
                    <th>Merk</th>
                    <th>EAN</th>
                    <th>Gearchiveerd</th>
                    <th>Aangemaakt</th>
                    <th>Actie</th>
                </tr>
            </thead>
            <tbody>
                <?php if (empty($productRows)): ?>
                    <tr><td colspan="6">Geen producten gevonden.</td></tr>
                <?php else: foreach ($productRows as $row): ?>
                    <tr>
                        <td>
                            <a href="product.php?id=<?= (int) $row['id'] ?>"><?= htmlspecialchars($row['name']) ?></a>
                            <?php if ($productMatchTypeById[(int) $row['id']] === 'fuzzy'): ?><span class="fuzzy-badge">gelijkaardig</span><?php endif; ?>
                        </td>
                        <td>
                            <?php if ($row['brand_id']): ?>
                                <a href="brand.php?id=<?= (int) $row['brand_id'] ?>"><?= htmlspecialchars($row['brand_name']) ?></a>
                            <?php else: ?>
                                -
                            <?php endif; ?>
                        </td>
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

        <h2>Aankopen (<?= count($purchaseRows) ?>)</h2>
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
                <?php if (empty($purchaseRows)): ?>
                    <tr><td colspan="9">Geen aankopen gevonden.</td></tr>
                <?php else: foreach ($purchaseRows as $row): ?>
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

        <h2>Verkopen (<?= count($saleRows) ?>)</h2>
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
                <?php if (empty($saleRows)): ?>
                    <tr><td colspan="9">Geen verkopen gevonden.</td></tr>
                <?php else: foreach ($saleRows as $row): ?>
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

    <?php endif; ?>
</body>
</html>
