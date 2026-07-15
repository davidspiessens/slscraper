<?php

declare(strict_types=1);

require __DIR__ . '/helpers.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    die('Methode niet toegestaan.');
}

$brandId = filter_input(INPUT_POST, 'id', FILTER_VALIDATE_INT);
$name = trim((string) ($_POST['name'] ?? ''));

if (!$brandId || $name === '') {
    http_response_code(400);
    die('Ongeldig merk-id of lege naam.');
}

$mysqli = get_db_connection();

try {
    $stmt = $mysqli->prepare('UPDATE brand SET name = ? WHERE id = ?');
    $stmt->bind_param('si', $name, $brandId);
    $stmt->execute();
    $stmt->close();
} catch (mysqli_sql_exception $e) {
    http_response_code(409);
    die('Kon naam niet bijwerken: er bestaat al een merk met deze naam.');
}

$mysqli->close();

header('Location: brand.php?id=' . $brandId);
exit;
