<?php

declare(strict_types=1);

require __DIR__ . '/helpers.php';

$mysqli = get_db_connection();

$editId = filter_input(INPUT_GET, 'id', FILTER_VALIDATE_INT) ?: null;
$isEdit = $editId !== null;

$purchase = null;
if ($isEdit) {
    $stmt = $mysqli->prepare('SELECT * FROM purchase WHERE id = ?');
    $stmt->bind_param('i', $editId);
    $stmt->execute();
    $purchase = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if (!$purchase) {
        http_response_code(404);
        die('Aankoop niet gevonden.');
    }
}

$prefillBstockProductId = $isEdit
    ? $purchase['bstock_product_id']
    : (filter_input(INPUT_GET, 'bstock_product_id', FILTER_VALIDATE_INT) ?: null);
$prefillProductId = $isEdit
    ? $purchase['product_id']
    : (filter_input(INPUT_GET, 'product_id', FILTER_VALIDATE_INT) ?: null);
$prefillSupplierId = $isEdit ? $purchase['supplier_id'] : null;
$prefillPrice = $isEdit ? $purchase['price'] : '';
$prefillInvoiceDate = $isEdit ? $purchase['invoice_date'] : date('Y-m-d');
$prefillInvoiceNumber = $isEdit ? $purchase['invoice_number'] : '';

// Enkel in add-modus via een quick-add-link (?bstock_product_id=) tonen we de
// listing als vaste (niet-bewerkbare) link; in edit-modus blijft het veld een
// gewoon getalveld zodat de koppeling aangepast/verwijderd kan worden.
$bstockProduct = null;
if (!$isEdit && $prefillBstockProductId) {
    $stmt = $mysqli->prepare('SELECT id, title, product_id, supplier_id FROM bstock_product WHERE id = ?');
    $stmt->bind_param('i', $prefillBstockProductId);
    $stmt->execute();
    $bstockProduct = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if ($bstockProduct) {
        $prefillProductId = $prefillProductId ?? $bstockProduct['product_id'];
        $prefillSupplierId = $bstockProduct['supplier_id'];
    }
}

$products = $mysqli->query(
    "SELECT p.id, p.name, b.name AS brand_name
     FROM product p
     LEFT JOIN brand b ON b.id = p.brand_id
     WHERE p.ignored = 0 AND (b.id IS NULL OR b.ignored = 0)
     ORDER BY b.name ASC, p.name ASC"
)->fetch_all(MYSQLI_ASSOC);

$suppliers = $mysqli->query('SELECT id, name FROM supplier ORDER BY name ASC')->fetch_all(MYSQLI_ASSOC);

$mysqli->close();

?>
<!DOCTYPE html>
<html lang="nl">
<head>
    <meta charset="UTF-8">
    <title><?= $isEdit ? 'Aankoop bewerken' : 'Aankoop registreren' ?> - Bax B-Stock overzicht</title>
    <style>
        body {
            font-family: Arial, Helvetica, sans-serif;
            margin: 2rem;
            color: #222;
        }
        h1 {
            font-size: 1.3rem;
        }
        a {
            color: #0a4d92;
        }
        .meta {
            margin: 0.2rem 0;
        }
        .hint {
            color: #666;
            font-weight: normal;
        }
        label {
            font-weight: bold;
            font-size: 0.9rem;
        }
        select, input[type="number"], input[type="date"], input[type="text"] {
            font-size: 0.9rem;
            padding: 0.3rem;
            width: 100%;
            max-width: 400px;
            box-sizing: border-box;
        }
        p.field {
            margin: 1rem 0;
        }
    </style>
</head>
<body>
    <?= render_vat_toggle() ?>
    <p><a href="purchases.php">&larr; Terug naar aankopen</a></p>
    <h1><?= $isEdit ? 'Aankoop bewerken' : 'Aankoop registreren' ?></h1>

    <form method="post" action="<?= $isEdit ? 'update_purchase.php' : 'create_purchase.php' ?>">
        <?php if ($isEdit): ?>
            <input type="hidden" name="id" value="<?= (int) $editId ?>">
        <?php endif; ?>
        <?php if ($bstockProduct): ?>
            <input type="hidden" name="bstock_product_id" value="<?= (int) $bstockProduct['id'] ?>">
            <p class="field">
                <label>Bstock-listing</label><br>
                <a href="bstock_product.php?id=<?= (int) $bstockProduct['id'] ?>"><?= htmlspecialchars($bstockProduct['title']) ?></a>
            </p>
        <?php else: ?>
            <p class="field">
                <label for="bstock_product_id">Bstock-listing-id (optioneel)</label><br>
                <input type="number" id="bstock_product_id" name="bstock_product_id" min="1" value="<?= $prefillBstockProductId ? (int) $prefillBstockProductId : '' ?>">
            </p>
        <?php endif; ?>

        <p class="field">
            <label for="product_id">Product</label><br>
            <select id="product_id" name="product_id" required>
                <option value="">-- kies een product --</option>
                <?php $currentBrand = null; foreach ($products as $p): ?>
                    <?php if ($p['brand_name'] !== $currentBrand): ?>
                        <?php if ($currentBrand !== null): ?></optgroup><?php endif; ?>
                        <optgroup label="<?= htmlspecialchars($p['brand_name'] ?? 'Onbekend merk') ?>">
                        <?php $currentBrand = $p['brand_name']; ?>
                    <?php endif; ?>
                    <option value="<?= (int) $p['id'] ?>" <?= (int) $prefillProductId === (int) $p['id'] ? 'selected' : '' ?>><?= htmlspecialchars($p['name']) ?></option>
                <?php endforeach; ?>
                <?php if ($currentBrand !== null): ?></optgroup><?php endif; ?>
            </select>
        </p>

        <p class="field">
            <label for="supplier_id">Leverancier</label><br>
            <select id="supplier_id" name="supplier_id" required>
                <option value="">-- kies een leverancier --</option>
                <?php foreach ($suppliers as $s): ?>
                    <option value="<?= (int) $s['id'] ?>" <?= (int) $prefillSupplierId === (int) $s['id'] ? 'selected' : '' ?>><?= htmlspecialchars($s['name']) ?></option>
                <?php endforeach; ?>
            </select>
        </p>

        <p class="field">
            <label for="price">Prijs (excl. BTW)</label><br>
            <input type="number" id="price" name="price" step="0.01" min="0" value="<?= htmlspecialchars((string) $prefillPrice) ?>" required>
            <br><small class="hint">Vul de prijs excl. BTW in, net zoals bij de bstock-prijzen.</small>
        </p>

        <p class="field">
            <label for="invoice_date">Factuurdatum</label><br>
            <input type="date" id="invoice_date" name="invoice_date" value="<?= htmlspecialchars($prefillInvoiceDate) ?>" required>
        </p>

        <p class="field">
            <label for="invoice_number">Factuurnummer</label><br>
            <input type="text" id="invoice_number" name="invoice_number" value="<?= htmlspecialchars($prefillInvoiceNumber) ?>" required>
        </p>

        <button type="submit"><?= $isEdit ? 'Aankoop bijwerken' : 'Aankoop registreren' ?></button>
    </form>
</body>
</html>
