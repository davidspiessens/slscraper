<?php

declare(strict_types=1);

require __DIR__ . '/helpers.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    die('Methode niet toegestaan.');
}

$brandId = filter_input(INPUT_POST, 'brand_id', FILTER_VALIDATE_INT);
$alias = trim((string) ($_POST['alias'] ?? ''));

if (!$brandId || $alias === '') {
    http_response_code(400);
    die('Ongeldig merk-id of lege alias.');
}

$mysqli = get_db_connection();

try {
    $stmt = $mysqli->prepare('INSERT INTO brand_alias (alias, brand_id) VALUES (?, ?)');
    $stmt->bind_param('si', $alias, $brandId);
    $stmt->execute();
    $stmt->close();
} catch (mysqli_sql_exception $e) {
    http_response_code(409);
    die('Kon alias niet toevoegen: deze alias bestaat al (mogelijk bij een ander merk).');
}

$mysqli->close();

header('Location: brand.php?id=' . $brandId);
exit;
