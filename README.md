# baxscraper

Scraper voor B-stock producten van [bax-shop.be](https://www.bax-shop.be), gebouwd met Node.js en Playwright. Resultaten worden weggeschreven naar een MySQL-database.

## SSH-tunnel voor database

```bash
ssh -f after-darkbe@ssh.after-dark.be -L 3307:ID480648_scraper.db.webhosting.be:3306 -N
```

## Env
Kopieer `.env.example` naar `.env` en vul de databasegegevens in.

## Gebruik
Makkelijkste manier:
```bash
./run.sh
```

```bash
node bax.js b-stock && node aedsecondhand.js && node xlrpro.js&& node soundsale.js && node progear.js && node cuesale.js && node salesall.js && node brands.js && node link_brands.js && node archive_products.js && node link_products.js && node archive_soldout_xlrpro.js
```

```bash
php -S localhost:8000 -t php
```