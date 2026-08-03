<?php

declare(strict_types=1);

require __DIR__ . '/helpers.php';

$mode = $_GET['mode'] ?? '';
if (!in_array($mode, ['incl', 'excl'], true)) {
    http_response_code(400);
    die('Ongeldige BTW-modus.');
}

setcookie(VAT_COOKIE, $mode, [
    'expires' => time() + 60 * 60 * 24 * 365,
    'path' => '/',
    'samesite' => 'Lax',
]);

$redirect = $_GET['redirect'] ?? 'index.php';
// Enkel relatieve redirects toestaan, geen open redirect naar externe sites
if (preg_match('#^https?://#i', $redirect) || str_starts_with($redirect, '//')) {
    $redirect = 'index.php';
}

header('Location: ' . $redirect);
exit;
