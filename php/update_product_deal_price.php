<?php

declare(strict_types=1);

require __DIR__ . '/helpers.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    die('Methode niet toegestaan.');
}

$productId = filter_input(INPUT_POST, 'id', FILTER_VALIDATE_INT);
$input = str_replace(',', '.', trim((string) ($_POST['deal_price'] ?? '')));

if (!$productId) {
    http_response_code(400);
    die('Ongeldig product-id.');
}

// Leeg veld = geen dealprijs meer. Het bedrag wordt ingegeven zoals de
// prijzen getoond worden (excl. of incl. btw, zie de btw-schakelaar) en
// excl. btw bewaard, net als de prijzen van de listings.
$dealPrice = null;
if ($input !== '') {
    if (!is_numeric($input) || (float) $input <= 0) {
        http_response_code(400);
        die('Ongeldige dealprijs.');
    }
    $dealPrice = round((float) $input / get_vat_multiplier(), 2);
}

$mysqli = get_db_connection();

$stmt = $mysqli->prepare('UPDATE product SET deal_price = ? WHERE id = ?');
$stmt->bind_param('di', $dealPrice, $productId);
$stmt->execute();
$stmt->close();

$mysqli->close();

header('Location: product.php?id=' . $productId);
exit;
