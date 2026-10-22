#!/bin/bash

# Minder frequente scrapers (traag of groot). Frequente scrapers staan in run.sh.
NODE="/home/david/.nvm/versions/node/v24.19.0/bin/node"
DIR="/home/david/slscraper"

# Eén run_id voor deze hele run_infrequent.sh-uitvoering, gedeeld door alle scripts
# hieronder (via env var geërfd door elk node-proces). Zo kunnen alle
# logberichten van één cron-run achteraf gegroepeerd worden per script.
export RUN_ID=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)
echo "Run ID: $RUN_ID"

$NODE $DIR/10kused.js && $NODE $DIR/archive_products.js 21
$NODE $DIR/brands.js
$NODE $DIR/link_brands.js
$NODE $DIR/link_products.js
