<?php

declare(strict_types=1);

require __DIR__ . '/helpers.php';

$mysqli = get_db_connection();

$editId = filter_input(INPUT_GET, 'id', FILTER_VALIDATE_INT) ?: null;
$isEdit = $editId !== null;

$sale = null;
if ($isEdit) {
    $stmt = $mysqli->prepare('SELECT * FROM sale WHERE id = ?');
    $stmt->bind_param('i', $editId);
    $stmt->execute();
    $sale = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if (!$sale) {
        http_response_code(404);
        die('Verkoop niet gevonden.');
    }
}

$prefillPurchaseId = $isEdit
    ? $sale['purchase_id']
    : (filter_input(INPUT_GET, 'purchase_id', FILTER_VALIDATE_INT) ?: null);
$prefillPrice = $isEdit ? $sale['price'] : '';
$prefillInvoiceDate = $isEdit ? $sale['invoice_date'] : date('Y-m-d');
$prefillInvoiceNumber = $isEdit ? $sale['invoice_number'] : '';

$purchasesStmt = $mysqli->prepare(
    "SELECT pu.id, pu.invoice_date, pu.invoice_number, pu.price,
            p.name AS product_name, b.name AS brand_name, s.name AS supplier_name
     FROM purchase pu
     JOIN product p ON p.id = pu.product_id
     LEFT JOIN brand b ON b.id = p.brand_id
     JOIN supplier s ON s.id = pu.supplier_id
     LEFT JOIN sale sa ON sa.purchase_id = pu.id
     WHERE sa.id IS NULL OR pu.id = ?
     ORDER BY pu.invoice_date DESC, pu.id DESC"
);
$purchasesStmt->bind_param('i', $prefillPurchaseId);
$purchasesStmt->execute();
$purchases = $purchasesStmt->get_result()->fetch_all(MYSQLI_ASSOC);
$purchasesStmt->close();

$mysqli->close();

?>
<!DOCTYPE html>
<html lang="nl">
<head>
    <meta charset="UTF-8">
    <title><?= $isEdit ? 'Verkoop bewerken' : 'Verkoop registreren' ?> - Bax B-Stock overzicht</title>
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
    <p><a href="sales.php">&larr; Terug naar verkopen</a></p>
    <h1><?= $isEdit ? 'Verkoop bewerken' : 'Verkoop registreren' ?></h1>

    <?php if (empty($purchases)): ?>
        <p>Geen openstaande aankopen gevonden om te verkopen.</p>
    <?php else: ?>
        <form method="post" action="<?= $isEdit ? 'update_sale.php' : 'create_sale.php' ?>">
            <?php if ($isEdit): ?>
                <input type="hidden" name="id" value="<?= (int) $editId ?>">
            <?php endif; ?>
            <p class="field">
                <label for="purchase_id">Aankoop</label><br>
                <select id="purchase_id" name="purchase_id" required>
                    <option value="">-- kies een aankoop --</option>
                    <?php foreach ($purchases as $p): ?>
                        <option value="<?= (int) $p['id'] ?>" <?= (int) $prefillPurchaseId === (int) $p['id'] ? 'selected' : '' ?>>
                            <?= htmlspecialchars($p['invoice_date']) ?> - <?= htmlspecialchars(trim(($p['brand_name'] ?? '') . ' ' . $p['product_name'])) ?> (aankoop: € <?= htmlspecialchars(number_format((float) $p['price'], 2, ',', '.')) ?> bij <?= htmlspecialchars($p['supplier_name']) ?>)
                        </option>
                    <?php endforeach; ?>
                </select>
            </p>

            <p class="field">
                <label for="price">Verkoopprijs (excl. BTW)</label><br>
                <input type="number" id="price" name="price" step="0.01" min="0" value="<?= htmlspecialchars((string) $prefillPrice) ?>" required>
                <br><small class="hint">Vul de verkoopprijs excl. BTW in.</small>
            </p>

            <p class="field">
                <label for="invoice_date">Factuurdatum</label><br>
                <input type="date" id="invoice_date" name="invoice_date" value="<?= htmlspecialchars($prefillInvoiceDate) ?>" required>
            </p>

            <p class="field">
                <label for="invoice_number">Factuurnummer</label><br>
                <input type="text" id="invoice_number" name="invoice_number" value="<?= htmlspecialchars($prefillInvoiceNumber) ?>" required>
            </p>

            <button type="submit"><?= $isEdit ? 'Verkoop bijwerken' : 'Verkoop registreren' ?></button>
        </form>
    <?php endif; ?>
</body>
</html>
