<?php

declare(strict_types=1);

require __DIR__ . '/helpers.php';

$runId = filter_input(INPUT_GET, 'id', FILTER_DEFAULT);

if (!$runId) {
    http_response_code(400);
    die('Ongeldig of ontbrekend run-id.');
}

$mysqli = get_db_connection();

$stmt = $mysqli->prepare("
    SELECT l.script, l.supplier_id, l.status, l.message, l.created, sup.name AS supplier_name
    FROM log l
    LEFT JOIN supplier sup ON sup.id = l.supplier_id
    WHERE l.run_id = ?
    ORDER BY l.created ASC, l.id ASC
");
$stmt->bind_param('s', $runId);
$stmt->execute();
$rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
$stmt->close();
$mysqli->close();

if (empty($rows)) {
    http_response_code(404);
    die('Geen logberichten gevonden voor dit run-id.');
}

$started = $rows[0]['created'];
$ended = end($rows)['created'];

?>
<!DOCTYPE html>
<html lang="nl">
<head>
    <meta charset="UTF-8">
    <title>Run <?= htmlspecialchars($runId) ?> - Scraper runs</title>
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
            width: 100%;
            margin-top: 0.5rem;
        }
        th, td {
            border: 1px solid #ccc;
            padding: 0.4rem 0.6rem;
            text-align: left;
            font-size: 0.9rem;
            vertical-align: top;
        }
        th {
            background: #f2f2f2;
        }
        tr:hover {
            background: #eaf2ff !important;
        }
        a {
            color: #0a4d92;
        }
        .meta {
            margin: 0.2rem 0;
        }
        .status-badge {
            display: inline-block;
            padding: 0.1rem 0.5rem;
            border-radius: 3px;
            font-weight: bold;
        }
    </style>
</head>
<body>
    <p><a href="runs.php">&larr; Terug naar runs-overzicht</a></p>
    <h1>Run <code><?= htmlspecialchars($runId) ?></code></h1>
    <p class="meta">
        Gestart: <?= htmlspecialchars($started) ?> &nbsp;|&nbsp;
        Laatste bericht: <?= htmlspecialchars($ended) ?>
    </p>

    <table>
        <thead>
            <tr>
                <th>Tijd</th>
                <th>Script</th>
                <th>Leverancier</th>
                <th>Status</th>
                <th>Bericht</th>
            </tr>
        </thead>
        <tbody>
            <?php foreach ($rows as $row): ?>
                <tr>
                    <td><?= htmlspecialchars($row['created']) ?></td>
                    <td><?= htmlspecialchars($row['script'] ?? '-') ?></td>
                    <td><?= htmlspecialchars($row['supplier_name'] ?? ($row['supplier_id'] !== null ? (string) $row['supplier_id'] : '-')) ?></td>
                    <td>
                        <span class="status-badge" style="background-color: <?= log_status_color((string) $row['status']) ?>;">
                            <?= htmlspecialchars((string) $row['status']) ?>
                        </span>
                    </td>
                    <td><?= htmlspecialchars($row['message'] ?? '') ?></td>
                </tr>
            <?php endforeach; ?>
        </tbody>
    </table>
</body>
</html>
