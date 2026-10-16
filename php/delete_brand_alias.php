<?php

declare(strict_types=1);

require __DIR__ . '/helpers.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    die('Methode niet toegestaan.');
}

$aliasId = filter_input(INPUT_POST, 'id', FILTER_VALIDATE_INT);
$brandId = filter_input(INPUT_POST, 'brand_id', FILTER_VALIDATE_INT);

if (!$aliasId || !$brandId) {
    http_response_code(400);
    die('Ongeldig alias- of merk-id.');
}

$mysqli = get_db_connection();

$stmt = $mysqli->prepare('DELETE FROM brand_alias WHERE id = ? AND brand_id = ?');
$stmt->bind_param('ii', $aliasId, $brandId);
$stmt->execute();
$stmt->close();
$mysqli->close();

header('Location: brand.php?id=' . $brandId);
exit;
