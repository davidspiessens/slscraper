<?php

declare(strict_types=1);

require __DIR__ . '/helpers.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    die('Methode niet toegestaan.');
}

$bstockProductId = filter_input(INPUT_POST, 'id', FILTER_VALIDATE_INT);

if (!$bstockProductId) {
    http_response_code(400);
    die('Ongeldig of ontbrekend bstock-product-id.');
}

$mysqli = get_db_connection();

$stmt = $mysqli->prepare('SELECT brand_id, title, product_id FROM bstock_product WHERE id = ?');
$stmt->bind_param('i', $bstockProductId);
$stmt->execute();
$bstockProduct = $stmt->get_result()->fetch_assoc();
$stmt->close();

if (!$bstockProduct) {
    $mysqli->close();
    http_response_code(404);
    die('Bstock-product niet gevonden.');
}

if ($bstockProduct['brand_id'] && !$bstockProduct['product_id']) {
    $name = clean_product_name($bstockProduct['title']);

    if ($name !== '') {
        $findStmt = $mysqli->prepare('SELECT id FROM product WHERE brand_id = ? AND name = ?');
        $findStmt->bind_param('is', $bstockProduct['brand_id'], $name);
        $findStmt->execute();
        $existing = $findStmt->get_result()->fetch_assoc();
        $findStmt->close();

        if ($existing) {
            $productId = (int) $existing['id'];
        } else {
            $insertStmt = $mysqli->prepare('INSERT INTO product (brand_id, name) VALUES (?, ?)');
            $insertStmt->bind_param('is', $bstockProduct['brand_id'], $name);
            $insertStmt->execute();
            $productId = (int) $mysqli->insert_id;
            $insertStmt->close();
        }

        $linkStmt = $mysqli->prepare('UPDATE bstock_product SET product_id = ? WHERE id = ?');
        $linkStmt->bind_param('ii', $productId, $bstockProductId);
        $linkStmt->execute();
        $linkStmt->close();
    }
}

$mysqli->close();

$redirect = $_POST['redirect'] ?? 'index.php';
if (!is_string($redirect) || !preg_match('#^/?(index|brand|bstock_product|product)\.php(\?[^\s]*)?$#', $redirect)) {
    $redirect = 'index.php';
}

header('Location: ' . $redirect);
exit;
