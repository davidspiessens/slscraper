# baxscraper

Scraper voor B-stock producten van [bax-shop.be](https://www.bax-shop.be), gebouwd met Node.js en Playwright. Resultaten worden weggeschreven naar een MySQL-database.

## SSH-tunnel voor database

```bash
ssh -f after-darkbe@ssh.after-dark.be -L 3307:ID480648_scraper.db.webhosting.be:3306 -N
```

## Env
Kopieer `.env.example` naar `.env` en vul de databasegegevens in.
