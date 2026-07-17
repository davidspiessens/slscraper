<?php

declare(strict_types=1);

require __DIR__ . '/helpers.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    die('Methode niet toegestaan.');
}

$productId = filter_input(INPUT_POST, 'id', FILTER_VALIDATE_INT);
$name = trim((string) ($_POST['name'] ?? ''));

if (!$productId || $name === '') {
    http_response_code(400);
    die('Ongeldig product-id of lege naam.');
}

$mysqli = get_db_connection();

try {
    $stmt = $mysqli->prepare('UPDATE product SET name = ? WHERE id = ?');
    $stmt->bind_param('si', $name, $productId);
    $stmt->execute();
    $stmt->close();
} catch (mysqli_sql_exception $e) {
    http_response_code(409);
    die('Kon naam niet bijwerken: er bestaat al een product met deze naam.');
}

$mysqli->close();

header('Location: product.php?id=' . $productId);
exit;
