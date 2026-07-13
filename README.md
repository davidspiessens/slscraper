# baxscraper

Scraper voor B-stock producten van [bax-shop.be](https://www.bax-shop.be), gebouwd met Node.js en Playwright. Resultaten worden weggeschreven naar een MySQL-database.

## SSH-tunnel voor database

```bash
ssh -f after-darkbe@ssh.after-dark.be -L 3307:ID480648_scraper.db.webhosting.be:3306 -N
```

## Env
Kopieer `.env.example` naar `.env` en vul de databasegegevens in.

## Gebruik
```bash
node bax.js b-stock && node brands.js && node link_brands.js && node archive_products.js
```

```bash
php -S localhost:8000 -t php
```