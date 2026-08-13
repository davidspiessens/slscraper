<?php

declare(strict_types=1);

require __DIR__ . '/helpers.php';

// Volgorde van de scripts zoals ze in run.sh voorkomen; onbekende scripts
// (bv. handmatig gedraaid, of nieuw toegevoegd aan run.sh maar nog niet
// hier) komen erna, alfabetisch.
const RUN_SCRIPT_ORDER = [
    'bax.js', 'archive_products.js', 'aedsecondhand.js', 'xlrpro.js', 'archive_soldout_xlrpro.js',
    'soundsale.js', 'progear.js', 'cuesale.js', 'salesall.js', 'kinxsound.js', 'coolblue.js',
    'thomann.js', 'musicstore.js', 'brands.js', 'link_brands.js', 'link_products.js',
];

const RUNS_LIMIT = 30;

$mysqli = get_db_connection();

$runsSql = "
    SELECT run_id, MIN(created) AS started, MAX(created) AS ended
    FROM log
    WHERE run_id IS NOT NULL
    GROUP BY run_id
    ORDER BY started DESC
    LIMIT " . RUNS_LIMIT;

$runs = $mysqli->query($runsSql)->fetch_all(MYSQLI_ASSOC);
$runIds = array_column($runs, 'run_id');

$details = [];
if (!empty($runIds)) {
    $inList = implode(',', array_map(fn($id) => "'" . $mysqli->real_escape_string($id) . "'", $runIds));
    $detailSql = "
        SELECT l.run_id, l.script, l.supplier_id, l.status, l.message, l.created, sup.name AS supplier_name
        FROM log l
        LEFT JOIN supplier sup ON sup.id = l.supplier_id
        WHERE l.run_id IN ($inList)
        ORDER BY l.created ASC
    ";
    $details = $mysqli->query($detailSql)->fetch_all(MYSQLI_ASSOC);
}

$mysqli->close();

/** Combineert alle statusrijen van één (run, script)-cel tot één eindstatus + representatief bericht. */
function summarize_cell(array $rows): array
{
    $statuses = array_column($rows, 'status');

    if (in_array('error', $statuses, true)) {
        $final = 'error';
    } elseif (in_array('success', $statuses, true)) {
        // Gelukt, maar met een waarschuwing onderweg (bv. vroegtijdig einde
        // van de paginering) -> apart gemarkeerd, verdient een blik.
        $final = in_array('warning', $statuses, true) ? 'warning' : 'success';
    } elseif (in_array('start', $statuses, true)) {
        // Enkel een start-bericht, nooit gevolgd door succes of fout: het
        // proces is ergens onderweg gestopt zonder dat te loggen (bv. een
        // harde crash/kill).
        $final = 'incomplete';
    } else {
        $final = 'unknown';
    }

    // Toon bij voorkeur het meest informatieve bericht: fout > waarschuwing > succes.
    $message = null;
    foreach (['error', 'warning', 'success'] as $priority) {
        foreach ($rows as $row) {
            if ($row['status'] === $priority) {
                $message = $row['message'];
            }
        }
    }
    if ($message === null) {
        $message = end($rows)['message'] ?? '';
    }

    return ['status' => $final, 'message' => (string) $message];
}

// Groepeer per run_id en per (script, supplier_id)-kolom.
$columns = [];   // key => label
$grouped = [];   // [run_id][key] => rows[]

foreach ($details as $row) {
    $key = $row['script'] . '|' . ($row['supplier_id'] ?? '');

    if (!isset($columns[$key])) {
        $label = $row['script'];
        if ($row['supplier_name'] !== null) {
            $label .= ' — ' . $row['supplier_name'];
        } elseif ($row['supplier_id'] !== null) {
            $label .= ' (' . $row['supplier_id'] . ')';
        }
        $columns[$key] = $label;
    }

    $grouped[$row['run_id']][$key][] = $row;
}

uksort($columns, function (string $a, string $b): int {
    [$scriptA, $supA] = explode('|', $a);
    [$scriptB, $supB] = explode('|', $b);
    $orderA = array_search($scriptA, RUN_SCRIPT_ORDER);
    $orderB = array_search($scriptB, RUN_SCRIPT_ORDER);
    $orderA = $orderA === false ? 999 : $orderA;
    $orderB = $orderB === false ? 999 : $orderB;
    if ($orderA !== $orderB) {
        return $orderA <=> $orderB;
    }
    if ($scriptA !== $scriptB) {
        return $scriptA <=> $scriptB;
    }
    return ((int) $supA) <=> ((int) $supB);
});

$matrix = []; // [run_id][key] => ['status' => ..., 'message' => ...]
foreach ($grouped as $runId => $cells) {
    foreach ($cells as $key => $rows) {
        $matrix[$runId][$key] = summarize_cell($rows);
    }
}

?>
<!DOCTYPE html>
<html lang="nl">
<head>
    <meta charset="UTF-8">
    <title>Scraper runs - overzicht</title>
    <style>
        body {
            font-family: Arial, Helvetica, sans-serif;
            margin: 2rem;
            color: #222;
        }
        h1 {
            font-size: 1.4rem;
        }
        table {
            border-collapse: collapse;
            margin-top: 0.5rem;
        }
        th, td {
            border: 1px solid #ccc;
            padding: 0.4rem 0.6rem;
            text-align: left;
            font-size: 0.85rem;
            white-space: nowrap;
        }
        th {
            background: #f2f2f2;
        }
        tr:hover td {
            background: #eaf2ff !important;
        }
        .num {
            text-align: right;
        }
        a {
            color: #0a4d92;
        }
        .meta {
            margin: 0.2rem 0;
        }
        .matrix-wrap {
            overflow-x: auto;
            max-width: 100%;
        }
        .cell {
            text-align: center;
            font-weight: bold;
            cursor: default;
        }
        .col-header {
            writing-mode: vertical-rl;
            transform: rotate(180deg);
            white-space: nowrap;
            vertical-align: bottom;
            max-width: none;
        }
    </style>
</head>
<body>
    <p><a href="index.php">&larr; Terug naar overzicht</a></p>
    <h1>Scraper runs - overzicht</h1>
    <p class="meta">Laatste <?= RUNS_LIMIT ?> runs. Elke rij is één uitvoering van <code>run.sh</code>; elke kolom een script (leverancier tussen haakjes bij scripts die met een supplier_id draaien). Beweeg over een cel voor het bijhorende logbericht, klik "Details" voor het volledige logverloop.</p>

    <?php if (empty($runs)): ?>
        <p>Nog geen runs geregistreerd. Runs krijgen pas een run_id nadat run.sh met de RUN_ID-export is bijgewerkt en gedraaid.</p>
    <?php else: ?>
        <div class="matrix-wrap">
        <table>
            <thead>
                <tr>
                    <th>Gestart</th>
                    <th>Duur</th>
                    <th>Details</th>
                    <?php foreach ($columns as $label): ?>
                        <th class="col-header"><?= htmlspecialchars($label) ?></th>
                    <?php endforeach; ?>
                </tr>
            </thead>
            <tbody>
                <?php foreach ($runs as $run): ?>
                    <?php
                    $started = strtotime($run['started']);
                    $ended = strtotime($run['ended']);
                    $durationMin = max(0, round(($ended - $started) / 60));
                    $runId = $run['run_id'];
                    ?>
                    <tr>
                        <td><?= htmlspecialchars(date('d/m/Y H:i', $started)) ?></td>
                        <td class="num"><?= $durationMin ?> min</td>
                        <td><a href="run.php?id=<?= urlencode($runId) ?>">Details</a></td>
                        <?php foreach ($columns as $key => $label): ?>
                            <?php $cell = $matrix[$runId][$key] ?? null; ?>
                            <?php if ($cell === null): ?>
                                <td class="cell" style="background-color: #fff;" title="Niet uitgevoerd in deze run">-</td>
                            <?php else: ?>
                                <td class="cell" style="background-color: <?= log_status_color($cell['status']) ?>;" title="<?= htmlspecialchars($cell['message']) ?>">
                                    <?= log_status_symbol($cell['status']) ?>
                                </td>
                            <?php endif; ?>
                        <?php endforeach; ?>
                    </tr>
                <?php endforeach; ?>
            </tbody>
        </table>
        </div>

        <p class="meta" style="margin-top: 1rem;">
            <?= log_status_symbol('success') ?> Geslaagd &nbsp;
            <?= log_status_symbol('warning') ?> Geslaagd met waarschuwing &nbsp;
            <?= log_status_symbol('error') ?> Fout &nbsp;
            <?= log_status_symbol('incomplete') ?> Onvolledig (geen eindstatus gelogd) &nbsp;
            - Niet uitgevoerd in deze run
        </p>
    <?php endif; ?>
</body>
</html>
