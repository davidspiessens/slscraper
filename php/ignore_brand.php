<?php

declare(strict_types=1);

require __DIR__ . '/helpers.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    die('Methode niet toegestaan.');
}

$brandId = filter_input(INPUT_POST, 'id', FILTER_VALIDATE_INT);

if (!$brandId) {
    http_response_code(400);
    die('Ongeldig of ontbrekend merk-id.');
}

$mysqli = get_db_connection();

$stmt = $mysqli->prepare('UPDATE brand SET ignored = 1 WHERE id = ?');
$stmt->bind_param('i', $brandId);
$stmt->execute();
$stmt->close();
$mysqli->close();

$redirect = $_POST['redirect'] ?? 'index.php';
if (!is_string($redirect) || !preg_match('#^/?(index|brand|bstock_product|product)\.php(\?[^\s]*)?$#', $redirect)) {
    $redirect = 'index.php';
}

header('Location: ' . $redirect);
exit;
