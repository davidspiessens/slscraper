<?php

declare(strict_types=1);

require __DIR__ . '/helpers.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    die('Methode niet toegestaan.');
}

$brandId = filter_input(INPUT_POST, 'id', FILTER_VALIDATE_INT);
$name = trim((string) ($_POST['name'] ?? ''));
$weight = filter_input(INPUT_POST, 'weight', FILTER_VALIDATE_INT);
$ignored = isset($_POST['ignored']) ? 1 : 0;

if (!$brandId || $name === '' || $weight === null || $weight === false) {
    http_response_code(400);
    die('Ongeldig merk-id, lege naam of ongeldig gewicht.');
}

$mysqli = get_db_connection();

try {
    $stmt = $mysqli->prepare('UPDATE brand SET name = ?, weight = ?, ignored = ? WHERE id = ?');
    $stmt->bind_param('siii', $name, $weight, $ignored, $brandId);
    $stmt->execute();
    $stmt->close();
} catch (mysqli_sql_exception $e) {
    http_response_code(409);
    die('Kon merk niet bijwerken: er bestaat al een merk met deze naam.');
}

$mysqli->close();

header('Location: manage_brands.php');
exit;
