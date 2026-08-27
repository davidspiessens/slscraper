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

const VAT_RATE = 1.21;
const VAT_COOKIE = 'vat_mode';

// Zelfde opkuislogica als create_products.js/link_products.js: bax "(B-Stock) ",
// progear "B-stock: " voorvoegsel, xlrpro " - [SECOND-HAND]"/" [SECOND-HAND]"
// achtervoegsel, tekst tussen haakjes en tekst na een liggend streepje
// omringd door spaties. Andere leveranciers hebben geen markering.
const BSTOCK_PREFIX_REGEX = '/^\(?b-stock\)?:?\s*/i';
const SECOND_HAND_SUFFIX_REGEX = '/\s*-?\s*\[second-hand\]\s*$/i';
const PAREN_REGEX = '/\s*\([^)]*\)/';
const DASH_SUFFIX_REGEX = '/\s+[-–—]\s+.*$/u';
// AED-feed dupliceert soms de merknaam (bv. "L-ACOUSTICS SPEAKER SYSTEM
// L- ACOUSTICS 5 XT" -> "L-ACOUSTICS 5 XT").
const LACOUSTICS_DUPLICATE_REGEX = '/L-ACOUSTICS\s+SPEAKER\s+SYSTEM\s+L-\s?ACOUSTICS/i';
// salesall: "Used | Merk | Model" of "B-Stock | Merk | Model" — enkel het
// modelgedeelte (na de tweede pipe) hoort in product.name, het merk zelf
// komt uit de brand-koppeling.
const PIPE_TITLE_REGEX = '/^(?:used|b-stock)\s*\|\s*[^|]+?\s*\|\s*(.+)$/i';

/** product.name mag geen merknaam bevatten (die komt uit de brand-koppeling,
 * zie brand.php/product.php). Bij salesall's pipe-formaat ("Used | Merk |
 * Model") wordt enkel het modelgedeelte gebruikt; bij andere leveranciers
 * begint de titel doorgaans met de merknaam zelf (bv. "Martin Audio AQ112
 * Subwoofer"), die vooraan wordt afgestript. $brandPrefixes = brand.name en
 * brand.first_word, langste eerst (bv. ["D&B Audiotechnik", "D&B"]) zodat
 * een kortere merknaam geen rommelrest achterlaat (vgl. link_products.js). */
function clean_product_name(string $title, array $brandPrefixes = []): string
{
    if (preg_match(PIPE_TITLE_REGEX, $title, $pipeMatch)) {
        return trim(preg_replace('/\s+/', ' ', $pipeMatch[1]));
    }

    // B-stock-voorvoegsel eerst weg (bax "(B-Stock) Fazley ...") — anders
    // begint de titel niet letterlijk met de merknaam en mist de brand-strip.
    $title = preg_replace(BSTOCK_PREFIX_REGEX, '', $title);

    foreach ($brandPrefixes as $prefix) {
        if ($prefix === null || $prefix === '') {
            continue;
        }
        $regex = '/^' . preg_quote($prefix, '/') . '\s+/i';
        if (preg_match($regex, $title)) {
            $title = preg_replace($regex, '', $title);
            break;
        }
    }

    $name = preg_replace(PAREN_REGEX, '', $title);
    $name = preg_replace(DASH_SUFFIX_REGEX, '', $name);
    $name = preg_replace(SECOND_HAND_SUFFIX_REGEX, '', $name);
    $name = preg_replace(LACOUSTICS_DUPLICATE_REGEX, 'L-ACOUSTICS', $name);
    $name = preg_replace('/\s+/', ' ', $name);
    return trim($name);
}

/** Normaliseert een naam enkel voor vergelijkingsdoeleinden: haakjes (en hun
 * inhoud) en koppeltekens worden genegeerd, zodat bv. "PLX1000" matcht met
 * het bestaande "PLX-1000" en "VM-50 actieve DJ-monitor" met het bestaande
 * "VM-50 actieve DJ-monitor (per stuk)" (waar de haakjes wél bij de officiële
 * naam horen). Zie ook link_products.js/create_products.js. */
function normalize_for_matching(string $name): string
{
    $normalized = mb_strtolower($name);
    $normalized = preg_replace('/\s*\([^)]*\)/', '', $normalized);
    $normalized = str_replace('-', '', $normalized);
    $normalized = preg_replace('/\s+/', ' ', $normalized);
    return trim($normalized);
}

/** Normaliseert een woord voor zoekvergelijking: lowercase, leestekens rond het woord weg. */
function normalize_search_word(string $word): string
{
    return trim(mb_strtolower($word), ".,;:()[]{}!?\"'-");
}

/**
 * Toegestane Levenshtein-afstand voor een woordpaar, op basis van het
 * kortste van de twee woorden. Bewust streng (1 typfout voor de meeste
 * woorden) — anders matchen te veel onverwante korte woorden toevallig
 * binnen de drempel (bv. "Orange" met "Pionner").
 */
function fuzzy_word_threshold(int $shorterLength): int
{
    if ($shorterLength <= 7) {
        return 1;
    }
    if ($shorterLength <= 12) {
        return 2;
    }
    return 3;
}

/**
 * Fuzzy-match: elk woord van $query moet ergens in $text een woord vinden
 * met een Levenshtein-afstand binnen de drempel (schaalt met de lengte van
 * het kortste woord van het paar). Woorden waarvan de lengte te veel
 * verschilt worden niet vergeleken. Woordvolgorde maakt niet uit.
 * levenshtein() ondersteunt max. 255 tekens per string, dus langere woorden
 * worden overgeslagen.
 */
function fuzzy_matches(string $query, string $text): bool
{
    $queryWords = array_values(array_filter(array_map('normalize_search_word', preg_split('/\s+/', $query) ?: [])));
    $textWords = array_values(array_filter(array_map('normalize_search_word', preg_split('/\s+/', $text) ?: [])));

    if (empty($queryWords) || empty($textWords)) {
        return false;
    }

    foreach ($queryWords as $queryWord) {
        $queryLen = mb_strlen($queryWord);
        if ($queryLen > 255 || $queryLen < 3) {
            // Te korte woorden (1-2 tekens) geven te veel toevalstreffers.
            continue;
        }

        $found = false;
        foreach ($textWords as $textWord) {
            $textLen = mb_strlen($textWord);
            if ($textLen > 255 || $textLen < 3) {
                continue;
            }

            $threshold = fuzzy_word_threshold(min($queryLen, $textLen));
            if (abs($queryLen - $textLen) > $threshold) {
                continue;
            }

            if (levenshtein($queryWord, $textWord) <= $threshold) {
                $found = true;
                break;
            }
        }
        if (!$found) {
            return false;
        }
    }

    return true;
}

/** Geeft de huidige BTW-vermenigvuldigingsfactor terug (1.21 bij incl., anders 1.0). Alle prijzen in de DB staan excl. BTW. */
function get_vat_multiplier(): float
{
    return (($_COOKIE[VAT_COOKIE] ?? 'excl') === 'incl') ? VAT_RATE : 1.0;
}

function euro(?string $value): string
{
    if ($value === null) {
        return '-';
    }
    return '€ ' . number_format((float) $value * get_vat_multiplier(), 2, ',', '.');
}

/** Zoals euro(), maar negeert de incl./excl. BTW-toggle: toont altijd excl. BTW. */
function euro_excl(?string $value): string
{
    if ($value === null) {
        return '-';
    }
    return '€ ' . number_format((float) $value, 2, ',', '.');
}

/** Rendert de incl./excl. BTW-toggle. Te plaatsen bovenaan elke pagina. */
function render_vat_toggle(): string
{
    $isIncl = get_vat_multiplier() > 1.0;
    $redirect = urlencode($_SERVER['REQUEST_URI'] ?? 'index.php');
    ob_start();
    ?>
    <p class="meta">
        Prijzen:
        <a href="toggle_vat.php?mode=excl&redirect=<?= $redirect ?>"<?= !$isIncl ? ' style="font-weight:bold;"' : '' ?>>Excl. BTW</a>
        &nbsp;|&nbsp;
        <a href="toggle_vat.php?mode=incl&redirect=<?= $redirect ?>"<?= $isIncl ? ' style="font-weight:bold;"' : '' ?>>Incl. BTW</a>
    </p>
    <?php
    return ob_get_clean();
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

    $historyValues = array_values($history);

    $circles = '';
    foreach ($nowPoints as $i => $p) {
        $tooltip = euro($historyValues[$i]['priceNow']) . ' op ' . date('d/m/Y', strtotime($historyValues[$i]['created']));
        $circles .= '<circle cx="' . $p[0] . '" cy="' . $p[1] . '" r="3" fill="#0a4d92"><title>' . htmlspecialchars($tooltip) . '</title></circle>';
    }

    // Datumlabels op de x-as (max 6, evenredig verspreid over de datapunten)
    $labelCount = min(6, $count);
    $labelIndices = [];
    for ($i = 0; $i < $labelCount; $i++) {
        $labelIndices[] = $labelCount > 1 ? (int) round($i * ($count - 1) / ($labelCount - 1)) : 0;
    }
    $labelIndices = array_values(array_unique($labelIndices));

    $xLabels = '';
    foreach ($labelIndices as $idx) {
        $x = $nowPoints[$idx][0];
        $dateStr = date('d/m', strtotime($historyValues[$idx]['created']));
        $xLabels .= '<text x="' . $x . '" y="' . ($padT + $plotH + 15) . '" text-anchor="middle">' . htmlspecialchars($dateStr) . '</text>';
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
        <?= $xLabels ?>
    </svg>
    <?php
    return ob_get_clean();
}

/** Rendert een SVG line-chart met meerdere prijsreeksen (bv. één per bstock-listing) op een gedeelde tijdsas. */
function render_multi_price_chart(array $series): string
{
    $allPoints = array_merge(...array_column($series, 'points'));
    if (empty($allPoints)) {
        return '<p>Geen prijshistoriek beschikbaar.</p>';
    }

    $width = 800;
    $height = 320;
    $padL = 70;
    $padR = 20;
    $padT = 20;
    $padB = 30;
    $plotW = $width - $padL - $padR;
    $plotH = $height - $padT - $padB;

    $times = array_column($allPoints, 't');
    $prices = array_column($allPoints, 'price');

    $minT = min($times);
    $maxT = max($times);
    if ($minT === $maxT) {
        $minT -= 1;
        $maxT += 1;
    }

    $minP = min($prices);
    $maxP = max($prices);
    if ($minP === $maxP) {
        $minP -= 1;
        $maxP += 1;
    }

    $colors = ['#0a4d92', '#c0392b', '#27ae60', '#8e44ad', '#e67e22', '#16a085', '#d35400', '#2c3e50', '#f39c12', '#7f8c8d'];

    $toXY = function (int $t, float $price) use ($padL, $padT, $plotW, $plotH, $minT, $maxT, $minP, $maxP) {
        $x = $padL + (($t - $minT) / ($maxT - $minT)) * $plotW;
        $y = $padT + $plotH - (($price - $minP) / ($maxP - $minP)) * $plotH;
        return [round($x, 1), round($y, 1)];
    };

    $polylines = '';
    $legend = '';
    foreach (array_values($series) as $i => $s) {
        $color = $colors[$i % count($colors)];
        $points = array_map(fn($p) => $toXY($p['t'], $p['price']), $s['points']);
        $pointsStr = implode(' ', array_map(fn($p) => "{$p[0]},{$p[1]}", $points));

        if (count($points) > 1) {
            $polylines .= '<polyline points="' . htmlspecialchars($pointsStr) . '" fill="none" stroke="' . $color . '" stroke-width="2" />';
        }
        foreach ($points as $j => $p) {
            $tooltip = euro((string) $s['points'][$j]['price']) . ' op ' . date('d/m/Y', $s['points'][$j]['t']);
            $polylines .= '<circle cx="' . $p[0] . '" cy="' . $p[1] . '" r="3" fill="' . $color . '"><title>' . htmlspecialchars($tooltip) . '</title></circle>';
        }

        $legend .= '<span style="display:inline-block; margin-right:1rem;">'
            . '<span style="display:inline-block; width:10px; height:10px; background:' . $color . '; margin-right:0.3rem;"></span>'
            . htmlspecialchars($s['label']) . '</span>';
    }

    // Datumlabels op de x-as (6 evenredig verspreide tijdstippen tussen minT en maxT)
    $tickCount = 6;
    $xLabels = '';
    for ($i = 0; $i < $tickCount; $i++) {
        $t = $tickCount > 1 ? $minT + ($maxT - $minT) * $i / ($tickCount - 1) : $minT;
        $x = round($padL + (($t - $minT) / ($maxT - $minT)) * $plotW, 1);
        $dateStr = date('d/m', (int) $t);
        $xLabels .= '<text x="' . $x . '" y="' . ($padT + $plotH + 15) . '" text-anchor="middle">' . htmlspecialchars($dateStr) . '</text>';
    }

    ob_start();
    ?>
    <div style="margin-bottom: 0.5rem; font-size: 0.85rem;"><?= $legend ?></div>
    <svg viewBox="0 0 <?= $width ?> <?= $height ?>" xmlns="http://www.w3.org/2000/svg" style="width:100%; height:auto; font-size:11px; font-family:Arial, sans-serif;">
        <line x1="<?= $padL ?>" y1="<?= $padT ?>" x2="<?= $padL ?>" y2="<?= $padT + $plotH ?>" stroke="#ccc" />
        <line x1="<?= $padL ?>" y1="<?= $padT + $plotH ?>" x2="<?= $padL + $plotW ?>" y2="<?= $padT + $plotH ?>" stroke="#ccc" />
        <text x="4" y="<?= $padT + 4 ?>"><?= htmlspecialchars(euro((string) $maxP)) ?></text>
        <text x="4" y="<?= $padT + $plotH ?>"><?= htmlspecialchars(euro((string) $minP)) ?></text>
        <?= $polylines ?>
        <?= $xLabels ?>
    </svg>
    <?php
    return ob_get_clean();
}

/** Achtergrondkleur voor een log-status, zie runs.php/run.php. */
function log_status_color(string $status): string
{
    return match ($status) {
        'success' => '#d4f7d4',
        'warning' => '#fff3cd',
        'error' => '#f8d7da',
        'incomplete' => '#eee',
        default => '#fff',
    };
}

/** Kort symbool voor een log-status, zie runs.php/run.php. */
function log_status_symbol(string $status): string
{
    return match ($status) {
        'success' => '&#10003;',   // ✓
        'warning' => '&#9888;',    // ⚠
        'error' => '&#10007;',     // ✗
        'incomplete' => '&hellip;',
        default => '?',
    };
}

/** Rendert een <tr> met de kolommen die alle producttabellen gemeen hebben.
 * $extraBadge (optioneel) wordt na de titel-links getoond, bv. het
 * "gelijkaardig"-label op search.php bij een fuzzy match. */
function render_product_row(array $row, bool $showGenerateAction = false, ?string $extraBadge = null): void
{
    $redirectTarget = htmlspecialchars($_SERVER['REQUEST_URI'] ?? 'index.php');
    // Gearchiveerd (rood, ongewijzigd) en genegeerd (grijs) zijn twee
    // verschillende toestanden — apart te onderscheiden i.p.v. dezelfde
    // kleur. Een product/bstock_product met een genegeerd merk telt ook als
    // genegeerd. Bij allebei tegelijk krijgt archived voorrang.
    if (!empty($row['archived'])) {
        $rowStyle = ' style="background-color: #f8d7da;"';
    } elseif (!empty($row['ignored']) || !empty($row['brand_ignored'])) {
        $rowStyle = ' style="background-color: #e2e3e5;"';
    } else {
        $rowStyle = '';
    }
    $urlHost = preg_replace('/^www\./', '', (string) parse_url($row['url'], PHP_URL_HOST));
    ?>
    <tr<?= $rowStyle ?>>
        <td>
            <a href="bstock_product.php?id=<?= (int) $row['id'] ?>"><?= htmlspecialchars($row['title']) ?></a>
            <?php if (!empty($row['product_id'])): ?>
                &nbsp;<a href="product.php?id=<?= (int) $row['product_id'] ?>" title="Bekijk productoverzicht">&#128230;</a>
            <?php endif; ?>
            &nbsp;<a href="<?= htmlspecialchars($row['url']) ?>" target="_blank" rel="noopener" title="Bekijk op <?= htmlspecialchars($urlHost) ?>">&#8599;</a>
            <?= $extraBadge ?? '' ?>
        </td>
        <td>
            <?php if ($row['brand_id']): ?>
                <a href="brand.php?id=<?= (int) $row['brand_id'] ?>"><?= htmlspecialchars($row['brand_name']) ?></a>
            <?php else: ?>
                -
            <?php endif; ?>
        </td>
        <td>
            <?php if (!empty($row['supplier_id']) && isset($row['supplier_name'])): ?>
                <a href="supplier.php?id=<?= (int) $row['supplier_id'] ?>"><?= htmlspecialchars($row['supplier_name']) ?></a>
            <?php else: ?>
                <?= isset($row['supplier_name']) ? htmlspecialchars($row['supplier_name']) : '-' ?>
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
                <button type="submit" title="Negeren" onclick="return confirm('Dit product negeren?');">&#128683;</button>
            </form>
            <?php if ($showGenerateAction && empty($row['product_id']) && !empty($row['brand_id'])): ?>
                <form method="post" action="generate_product.php" style="margin:0.3rem 0 0 0;">
                    <input type="hidden" name="id" value="<?= (int) $row['id'] ?>">
                    <input type="hidden" name="redirect" value="<?= $redirectTarget ?>">
                    <button type="submit" title="Genereer product">&#128279;</button>
                </form>
            <?php endif; ?>
        </td>
    </tr>
    <?php
}
