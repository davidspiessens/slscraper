#!/bin/bash

NODE="/home/david/.nvm/versions/node/v24.19.0/bin/node"
DIR="/home/david/slscraper"

# Eén run_id voor deze hele run.sh-uitvoering, gedeeld door alle scripts
# hieronder (via env var geërfd door elk node-proces). Zo kunnen alle
# logberichten van één cron-run achteraf gegroepeerd worden per script.
export RUN_ID=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)
echo "Run ID: $RUN_ID"

$NODE $DIR/bax.js b-stock && $NODE $DIR/archive_products.js 1
$NODE $DIR/brands.js
$NODE $DIR/link_brands.js
$NODE $DIR/link_products.js
$NODE $DIR/aedsecondhand.js && $NODE $DIR/archive_products.js 5
$NODE $DIR/brands.js
$NODE $DIR/link_brands.js
$NODE $DIR/link_products.js
$NODE $DIR/xlrpro.js && $NODE $DIR/archive_soldout_xlrpro.js 4
$NODE $DIR/brands.js
$NODE $DIR/link_brands.js
$NODE $DIR/link_products.js
$NODE $DIR/soundsale.js && $NODE $DIR/archive_products.js 6
$NODE $DIR/brands.js
$NODE $DIR/link_brands.js
$NODE $DIR/link_products.js
$NODE $DIR/progear.js && $NODE $DIR/archive_products.js 3
$NODE $DIR/brands.js
$NODE $DIR/link_brands.js
$NODE $DIR/link_products.js
$NODE $DIR/cuesale.js && $NODE $DIR/archive_products.js 11
$NODE $DIR/link_brands.js
$NODE $DIR/link_products.js
$NODE $DIR/salesall.js && $NODE $DIR/archive_products.js 10
$NODE $DIR/brands.js
$NODE $DIR/link_brands.js
$NODE $DIR/link_products.js
$NODE $DIR/kinxsound.js && $NODE $DIR/archive_products.js 12
$NODE $DIR/brands.js
$NODE $DIR/link_brands.js
$NODE $DIR/link_products.js
$NODE $DIR/coolblue.js && $NODE $DIR/archive_products.js 13
$NODE $DIR/brands.js
$NODE $DIR/link_brands.js
$NODE $DIR/link_products.js
$NODE $DIR/thomann.js && $NODE $DIR/archive_products.js 14
$NODE $DIR/brands.js
$NODE $DIR/link_brands.js
$NODE $DIR/link_products.js
# $NODE $DIR/musicstore.js && $NODE $DIR/archive_products.js 15
# $NODE $DIR/brands.js
# $NODE $DIR/link_brands.js
# $NODE $DIR/link_products.js
