<?php

declare(strict_types=1);

require __DIR__ . '/helpers.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    die('Methode niet toegestaan.');
}

$id = filter_input(INPUT_POST, 'id', FILTER_VALIDATE_INT);
$purchaseId = filter_input(INPUT_POST, 'purchase_id', FILTER_VALIDATE_INT);
$price = filter_input(INPUT_POST, 'price', FILTER_VALIDATE_FLOAT);
$invoiceDate = (string) ($_POST['invoice_date'] ?? '');
$invoiceNumber = trim((string) ($_POST['invoice_number'] ?? ''));

$errors = [];
if (!$id) {
    $errors[] = 'Ongeldig of ontbrekend verkoop-id.';
}
if (!$purchaseId) {
    $errors[] = 'Kies een geldige aankoop.';
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

$checkStmt = $mysqli->prepare('SELECT id FROM sale WHERE id = ?');
$checkStmt->bind_param('i', $id);
$checkStmt->execute();
if (!$checkStmt->get_result()->fetch_assoc()) {
    $checkStmt->close();
    $mysqli->close();
    http_response_code(404);
    die('Verkoop niet gevonden.');
}
$checkStmt->close();

$purchaseStmt = $mysqli->prepare('SELECT id FROM purchase WHERE id = ?');
$purchaseStmt->bind_param('i', $purchaseId);
$purchaseStmt->execute();
if (!$purchaseStmt->get_result()->fetch_assoc()) {
    $purchaseStmt->close();
    $mysqli->close();
    http_response_code(400);
    die('Ongeldige aankoop.');
}
$purchaseStmt->close();

$stmt = $mysqli->prepare(
    'UPDATE sale SET purchase_id = ?, price = ?, invoice_date = ?, invoice_number = ? WHERE id = ?'
);
$stmt->bind_param('idssi', $purchaseId, $price, $invoiceDate, $invoiceNumber, $id);
$stmt->execute();
$stmt->close();
$mysqli->close();

header('Location: sales.php');
exit;
