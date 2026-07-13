<?php

declare(strict_types=1);

function get_db_connection(): mysqli
{
    $config = require __DIR__ . '/config.php';

    // "localhost" laat mysqli een unix-socket gebruiken i.p.v. TCP, waardoor
    // een SSH-tunnel op een custom poort genegeerd wordt. Forceer daarom TCP.
    if ($config['host'] === 'localhost') {
        $config['host'] = '127.0.0.1';
    }

    $mysqli = new mysqli(
        $config['host'],
        $config['user'],
        $config['password'],
        $config['database'],
        $config['port']
    );

    if ($mysqli->connect_errno) {
        http_response_code(500);
        die('Databaseconnectie mislukt: ' . htmlspecialchars($mysqli->connect_error));
    }

    $mysqli->set_charset('utf8mb4');

    return $mysqli;
}

function euro(?string $value): string
{
    return $value === null ? '-' : '€ ' . number_format((float) $value, 2, ',', '.');
}

/** Rendert een SVG line-chart van de prijshistoriek (chronologisch, oud -> nieuw). */
function render_price_chart(array $history): string
{
    if (empty($history)) {
        return '<p>Geen prijshistoriek beschikbaar.</p>';
    }

    $width = 800;
    $height = 300;
    $padL = 70;
    $padR = 20;
    $padT = 20;
    $padB = 30;
    $plotW = $width - $padL - $padR;
    $plotH = $height - $padT - $padB;

    $allPrices = array_map(fn($h) => (float) $h['priceNow'], $history);
    $min = min($allPrices);
    $max = max($allPrices);
    if ($min === $max) {
        $min -= 1;
        $max += 1;
    }

    $count = count($history);
    $stepX = $count > 1 ? $plotW / ($count - 1) : 0;

    $toXY = function (float $price, int $index) use ($padL, $padT, $plotW, $plotH, $stepX, $min, $max) {
        $x = $padL + $index * $stepX;
        $y = $padT + $plotH - (($price - $min) / ($max - $min)) * $plotH;
        return [round($x, 1), round($y, 1)];
    };

    $nowPoints = [];
    foreach (array_values($history) as $i => $h) {
        $nowPoints[] = $toXY((float) $h['priceNow'], $i);
    }

    $toStr = fn(array $points): string => implode(' ', array_map(fn($p) => "{$p[0]},{$p[1]}", $points));

    $circles = '';
    foreach ($nowPoints as $p) {
        $circles .= '<circle cx="' . $p[0] . '" cy="' . $p[1] . '" r="3" fill="#0a4d92" />';
    }

    ob_start();
    ?>
    <svg viewBox="0 0 <?= $width ?> <?= $height ?>" xmlns="http://www.w3.org/2000/svg" style="width:100%; height:auto; font-size:11px; font-family:Arial, sans-serif;">
        <line x1="<?= $padL ?>" y1="<?= $padT ?>" x2="<?= $padL ?>" y2="<?= $padT + $plotH ?>" stroke="#ccc" />
        <line x1="<?= $padL ?>" y1="<?= $padT + $plotH ?>" x2="<?= $padL + $plotW ?>" y2="<?= $padT + $plotH ?>" stroke="#ccc" />
        <text x="4" y="<?= $padT + 4 ?>"><?= htmlspecialchars(euro((string) $max)) ?></text>
        <text x="4" y="<?= $padT + $plotH ?>"><?= htmlspecialchars(euro((string) $min)) ?></text>
        <polyline points="<?= $toStr($nowPoints) ?>" fill="none" stroke="#0a4d92" stroke-width="2" />
        <?= $circles ?>
    </svg>
    <?php
    return ob_get_clean();
}

/** Rendert een <tr> met de kolommen die alle producttabellen gemeen hebben. */
function render_product_row(array $row): void
{
    $redirectTarget = htmlspecialchars($_SERVER['REQUEST_URI'] ?? 'index.php');
    $rowStyle = !empty($row['ignored']) ? ' style="background-color: #f8d7da;"' : '';
    ?>
    <tr<?= $rowStyle ?>>
        <td>
            <a href="bstock_product.php?id=<?= (int) $row['id'] ?>"><?= htmlspecialchars($row['title']) ?></a>
            <?php if (!empty($row['product_id'])): ?>
                &nbsp;<a href="product.php?id=<?= (int) $row['product_id'] ?>" title="Bekijk productoverzicht">&#128230;</a>
            <?php endif; ?>
            &nbsp;<a href="<?= htmlspecialchars($row['url']) ?>" target="_blank" rel="noopener" title="Bekijk op bax-shop.be">&#8599;</a>
        </td>
        <td>
            <?php if ($row['brand_id']): ?>
                <a href="brand.php?id=<?= (int) $row['brand_id'] ?>"><?= htmlspecialchars($row['brand_name']) ?></a>
            <?php else: ?>
                -
            <?php endif; ?>
        </td>
        <?php $isLowest = $row['lowest_price'] !== null && (float) $row['priceNow'] === (float) $row['lowest_price']; ?>
        <td class="num"><?= $row['weight'] === null ? '-' : htmlspecialchars((string) $row['weight']) ?></td>
        <td class="num"><?= euro($row['priceOriginal']) ?></td>
        <td class="num"<?= $isLowest ? ' style="background-color: #d4f7d4;"' : '' ?>><?= euro($row['priceNow']) ?></td>
        <td class="num"><?= euro($row['price_diff']) ?></td>
        <td class="num"><?= euro($row['highest_price']) ?></td>
        <td class="num"><?= euro($row['lowest_price']) ?></td>
        <td><?= htmlspecialchars($row['discount_label'] ?? '') ?></td>
        <td><?= htmlspecialchars($row['price_created']) ?></td>
        <td><?= htmlspecialchars($row['product_created']) ?></td>
        <td>
            <form method="post" action="ignore_bstock_product.php" style="margin:0;">
                <input type="hidden" name="id" value="<?= (int) $row['id'] ?>">
                <input type="hidden" name="redirect" value="<?= $redirectTarget ?>">
                <button type="submit" onclick="return confirm('Dit product negeren?');">Negeren</button>
            </form>
        </td>
    </tr>
    <?php
}
