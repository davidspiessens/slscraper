<?php

declare(strict_types=1);

require __DIR__ . '/helpers.php';

$mysqli = get_db_connection();

$brands = $mysqli->query('SELECT id, name, weight, ignored FROM brand ORDER BY name ASC')->fetch_all(MYSQLI_ASSOC);

$mysqli->close();

?>
<!DOCTYPE html>
<html lang="nl">
<head>
    <meta charset="UTF-8">
    <title>Merken beheren - Bax B-Stock overzicht</title>
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
        }
        th {
            background: #f2f2f2;
        }
        tr:nth-child(even) {
            background: #fafafa;
        }
        a {
            color: #0a4d92;
        }
        input[type="text"] {
            width: 100%;
            box-sizing: border-box;
        }
        input[type="number"] {
            width: 6rem;
        }
    </style>
</head>
<body>
    <p><a href="index.php">&larr; Terug naar overzicht</a></p>
    <h1>Merken beheren</h1>

    <table>
        <thead>
            <tr>
                <th>Naam</th>
                <th>Gewicht</th>
                <th>Genegeerd</th>
                <th>Actie</th>
            </tr>
        </thead>
        <tbody>
            <?php if (empty($brands)): ?>
                <tr><td colspan="4">Geen merken gevonden.</td></tr>
            <?php else: foreach ($brands as $brand): ?>
                <?php $formId = 'brand-form-' . (int) $brand['id']; ?>
                <tr>
                    <td>
                        <form id="<?= $formId ?>" method="post" action="update_brand.php"></form>
                        <input type="text" name="name" form="<?= $formId ?>" value="<?= htmlspecialchars($brand['name']) ?>" required>
                    </td>
                    <td><input type="number" name="weight" form="<?= $formId ?>" value="<?= (int) $brand['weight'] ?>" required></td>
                    <td><input type="checkbox" name="ignored" form="<?= $formId ?>" <?= $brand['ignored'] ? 'checked' : '' ?>></td>
                    <td>
                        <input type="hidden" name="id" form="<?= $formId ?>" value="<?= (int) $brand['id'] ?>">
                        <button type="submit" form="<?= $formId ?>">Opslaan</button>
                    </td>
                </tr>
            <?php endforeach; endif; ?>
        </tbody>
    </table>
</body>
</html>
