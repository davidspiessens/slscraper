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
    $brandStmt = $mysqli->prepare('SELECT name, first_word FROM brand WHERE id = ?');
    $brandStmt->bind_param('i', $bstockProduct['brand_id']);
    $brandStmt->execute();
    $brandRow = $brandStmt->get_result()->fetch_assoc();
    $brandStmt->close();

    // Langste eerst, zodat "D&B Audiotechnik" geprobeerd wordt vóór het
    // kortere "D&B" (zie clean_product_name in helpers.php).
    $brandPrefixes = $brandRow ? array_unique([$brandRow['name'], $brandRow['first_word']]) : [];
    usort($brandPrefixes, fn($a, $b) => strlen($b) - strlen($a));

    $name = clean_product_name($bstockProduct['title'], $brandPrefixes);

    if ($name !== '') {
        // Genormaliseerd vergelijken (haakjes/koppeltekens genegeerd) i.p.v. een
        // exacte match, anders ontstaat een dubbel product zodra de opgekuiste
        // b-stock titel net iets anders is dan de bestaande naam (bv. "PLX1000"
        // vs. het bestaande "PLX-1000", of haakjes die wél bij de naam horen
        // zoals "VM-50 actieve DJ-monitor (per stuk)").
        $candidatesStmt = $mysqli->prepare('SELECT id, name FROM product WHERE brand_id = ?');
        $candidatesStmt->bind_param('i', $bstockProduct['brand_id']);
        $candidatesStmt->execute();
        $candidates = $candidatesStmt->get_result()->fetch_all(MYSQLI_ASSOC);
        $candidatesStmt->close();

        $normalizedName = normalize_for_matching($name);
        $existing = null;
        foreach ($candidates as $candidate) {
            if (normalize_for_matching($candidate['name']) === $normalizedName) {
                $existing = $candidate;
                break;
            }
        }

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
