<?php

declare(strict_types=1);

require __DIR__ . '/helpers.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    die('Methode niet toegestaan.');
}

$productId = filter_input(INPUT_POST, 'product_id', FILTER_VALIDATE_INT);
$supplierId = filter_input(INPUT_POST, 'supplier_id', FILTER_VALIDATE_INT);
$bstockProductId = filter_input(INPUT_POST, 'bstock_product_id', FILTER_VALIDATE_INT) ?: null;
$price = filter_input(INPUT_POST, 'price', FILTER_VALIDATE_FLOAT);
$invoiceDate = (string) ($_POST['invoice_date'] ?? '');
$invoiceNumber = trim((string) ($_POST['invoice_number'] ?? ''));

$errors = [];
if (!$productId) {
    $errors[] = 'Kies een geldig product.';
}
if (!$supplierId) {
    $errors[] = 'Kies een geldige leverancier.';
}
if ($price === false || $price === null || $price < 0) {
    $errors[] = 'Vul een geldige prijs in.';
}
if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $invoiceDate)) {
    $errors[] = 'Vul een geldige factuurdatum in.';
}
if ($invoiceNumber === '') {
    $errors[] = 'Vul een factuurnummer in.';
}

if (!empty($errors)) {
    http_response_code(400);
    die(implode(' ', $errors));
}

$mysqli = get_db_connection();

if ($bstockProductId) {
    $checkStmt = $mysqli->prepare('SELECT id FROM bstock_product WHERE id = ?');
    $checkStmt->bind_param('i', $bstockProductId);
    $checkStmt->execute();
    if (!$checkStmt->get_result()->fetch_assoc()) {
        $bstockProductId = null;
    }
    $checkStmt->close();
}

$stmt = $mysqli->prepare(
    'INSERT INTO purchase (bstock_product_id, product_id, supplier_id, price, invoice_date, invoice_number)
     VALUES (?, ?, ?, ?, ?, ?)'
);
$stmt->bind_param('iiidss', $bstockProductId, $productId, $supplierId, $price, $invoiceDate, $invoiceNumber);
$stmt->execute();
$stmt->close();
$mysqli->close();

header('Location: purchases.php');
exit;
