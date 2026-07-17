<?php

declare(strict_types=1);

require __DIR__ . '/helpers.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    die('Methode niet toegestaan.');
}

$brandId = filter_input(INPUT_POST, 'id', FILTER_VALIDATE_INT);
$weight = filter_input(INPUT_POST, 'weight', FILTER_VALIDATE_INT);

if (!$brandId || $weight === null || $weight === false) {
    http_response_code(400);
    die('Ongeldig merk-id of gewicht.');
}

$mysqli = get_db_connection();

$stmt = $mysqli->prepare('UPDATE brand SET weight = ? WHERE id = ?');
$stmt->bind_param('ii', $weight, $brandId);
$stmt->execute();
$stmt->close();
$mysqli->close();

header('Location: brand.php?id=' . $brandId);
exit;
