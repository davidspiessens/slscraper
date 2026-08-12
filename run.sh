#!/bin/bash

NODE="/home/david/.nvm/versions/node/v24.19.0/bin/node"
DIR="/home/david/slscraper"

$NODE $DIR/bax.js b-stock && $NODE $DIR/archive_products.js 1
$NODE $DIR/aedsecondhand.js && $NODE $DIR/archive_products.js 5
$NODE $DIR/xlrpro.js && $NODE $DIR/archive_soldout_xlrpro.js 4
$NODE $DIR/soundsale.js && $NODE $DIR/archive_products.js 6
$NODE $DIR/progear.js && $NODE $DIR/archive_products.js 3
$NODE $DIR/cuesale.js && $NODE $DIR/archive_products.js 11
$NODE $DIR/salesall.js && $NODE $DIR/archive_products.js 10
$NODE $DIR/kinxsound.js && $NODE $DIR/archive_products.js 12
$NODE $DIR/coolblue.js && $NODE $DIR/archive_products.js 13
$NODE $DIR/thomann.js && $NODE $DIR/archive_products.js 14
$NODE $DIR/brands.js
$NODE $DIR/link_brands.js
$NODE $DIR/link_products.js
