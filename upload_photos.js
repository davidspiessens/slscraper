/**
 * Uploadt productfoto's naar after-dark.be en koppelt ze aan het product
 * met dezelfde SKU.
 *
 * Bestandsnaam: <sku>-<volgorde>.<ext>, bv. "20-1.jpg", "20-2.jpg".
 * <sku>-1 wordt de hoofdfoto, de rest komt in volgorde in de galerij (achter
 * foto's die er al staan). Alt-tekst en titel = "<merk> <model> kopen", met
 * het model uit de taxonomie `model` (zonder herkomst zoals "B-stock").
 *
 * Foto's worden vóór de upload verkleind tot max. 2560px (macOS `sips`);
 * WordPress zou dat anders zelf doen, maar zo gaan er geen bestanden van
 * 5MB over de lijn. Na een geslaagde upload verhuist het origineel naar
 * de map Uploaded.
 *
 * Nodig in .env: WC_URL, WC_KEY, WC_SECRET (WooCommerce REST API) en
 * WP_USER, WP_APP_PASSWORD (applicatiewachtwoord, voor de mediabibliotheek).
 *
 * Uitvoeren:
 *     node upload_photos.js
 *     node upload_photos.js --dry      (toont enkel wat er zou gebeuren)
 */

require("dotenv").config({ quiet: true });
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const DRY = process.argv.includes("--dry");
const PHOTO_DIR = path.join(os.homedir(), "Pictures", "Sales");
const UPLOADED_DIR = path.join(PHOTO_DIR, "Uploaded");
const MAX_SIZE = 2560;
const FILE_REGEX = /^(.+)-(\d+)\.(jpe?g|png|webp)$/i;
const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

const BASE = process.env.WC_URL;
const WC_AUTH = "Basic " + Buffer.from(`${process.env.WC_KEY}:${process.env.WC_SECRET}`).toString("base64");
const WP_AUTH = "Basic " + Buffer.from(`${process.env.WP_USER}:${process.env.WP_APP_PASSWORD}`).toString("base64");

async function api(url, auth, options = {}) {
  const res = await fetch(BASE + url, { ...options, headers: { Authorization: auth, ...(options.headers || {}) } });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`${options.method || "GET"} ${url}: ${res.status} ${body ? body.message || JSON.stringify(body) : ""}`);
  }
  return body;
}

/** Groepeert de foto's per SKU, gesorteerd op volgorde. Andere bestanden worden gemeld en genegeerd. */
function collectPhotos() {
  const bySku = new Map();
  for (const file of fs.readdirSync(PHOTO_DIR)) {
    const full = path.join(PHOTO_DIR, file);
    if (file.startsWith(".") || !fs.statSync(full).isFile()) continue;
    const match = file.match(FILE_REGEX);
    if (!match) {
      console.log(`  ⚠ ${file}: naam is niet <sku>-<volgorde>.jpg/png/webp, overgeslagen.`);
      continue;
    }
    const [, sku, order, ext] = match;
    if (!bySku.has(sku)) bySku.set(sku, []);
    bySku.get(sku).push({ file, full, order: Number(order), mime: MIME[ext.toLowerCase()] });
  }
  for (const photos of bySku.values()) photos.sort((a, b) => a.order - b.order);
  return bySku;
}

/** Verkleinde kopie in een tijdelijke map (origineel blijft onaangeroerd). */
function resizedCopy(photo, tmpDir) {
  const target = path.join(tmpDir, photo.file);
  execFileSync("sips", ["-Z", String(MAX_SIZE), photo.full, "--out", target], { stdio: "ignore" });
  return target;
}

/** "AlphaTheta Euphonia kopen"; zonder model valt het terug op de productnaam. */
async function altText(product) {
  const { model } = await api(`/wp-json/wp/v2/product/${product.id}?context=edit&_fields=model`, WP_AUTH);
  const brand = product.brands && product.brands[0] ? product.brands[0].name.replace(/&amp;/g, "&") : "";
  if (!brand || !model || model.length === 0) return product.name;
  const term = await api(`/wp-json/wp/v2/model/${model[0]}?_fields=name`, WP_AUTH);
  return `${brand} ${term.name} kopen`;
}

async function uploadMedia(filePath, photo, text) {
  const media = await api("/wp-json/wp/v2/media", WP_AUTH, {
    method: "POST",
    headers: {
      "Content-Type": photo.mime,
      "Content-Disposition": `attachment; filename="${photo.file}"`,
    },
    body: fs.readFileSync(filePath),
  });
  await api(`/wp-json/wp/v2/media/${media.id}`, WP_AUTH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: text, alt_text: text }),
  });
  return media.id;
}

async function run() {
  if (!fs.existsSync(PHOTO_DIR)) {
    console.error(`Map ${PHOTO_DIR} bestaat niet.`);
    process.exit(1);
  }
  const bySku = collectPhotos();
  if (bySku.size === 0) {
    console.log("Geen foto's gevonden.");
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "upload-photos-"));
  let uploaded = 0;

  try {
    for (const [sku, photos] of bySku) {
      const [product] = await api(
        `/wp-json/wc/v3/products?sku=${encodeURIComponent(sku)}&status=any&_fields=id,name,status,images,brands`,
        WC_AUTH
      );
      if (!product) {
        console.log(`SKU ${sku}: geen product gevonden, ${photos.length} foto('s) blijven staan.`);
        continue;
      }

      const text = await altText(product);
      const hasMain = photos[0].order === 1;
      console.log(
        `SKU ${sku} → product ${product.id} "${product.name}" (${product.status}), alt "${text}": ` +
          photos.map((p) => p.file).join(", ") +
          (hasMain ? "" : " (geen -1: bestaande hoofdfoto blijft)")
      );
      if (DRY) continue;

      const ids = [];
      for (const photo of photos) {
        ids.push(await uploadMedia(resizedCopy(photo, tmpDir), photo, text));
      }

      // Bestaande foto's behouden: nieuwe -1 vervangt de hoofdfoto (de oude
      // schuift naar de galerij), de andere nieuwe foto's komen achteraan.
      const existing = product.images.map((img) => img.id);
      const newMain = hasMain ? ids.shift() : null;
      const order = newMain ? [newMain, ...existing, ...ids] : [...existing, ...ids];
      await api(`/wp-json/wc/v3/products/${product.id}`, WC_AUTH, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images: [...new Set(order)].map((id) => ({ id })) }),
      });

      fs.mkdirSync(UPLOADED_DIR, { recursive: true });
      for (const photo of photos) {
        fs.renameSync(photo.full, path.join(UPLOADED_DIR, photo.file));
      }
      uploaded += photos.length;
      console.log(`  ✓ ${photos.length} foto('s) gekoppeld en verplaatst naar Uploaded.`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(DRY ? "\nDry run, niets geüpload." : `\n✓ ${uploaded} foto('s) geüpload.`);
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
