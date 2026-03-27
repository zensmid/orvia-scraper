const { chromium } = require("playwright");
const { neon } = require("@neondatabase/serverless");

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  }).catch(() => {});
}

const sql = neon(process.env.DATABASE_URL);

// Giros a buscar — PEDIDO GRUPAL: compradores de fundas y micas para iPhone
const GIROS = [
  "accesorios para celular",
  "tienda de celulares usados",
  "reparación de celulares",
  "venta de fundas para celular",
  "tienda de celulares",
  "electrónica y accesorios",
  "distribuidor de accesorios para celular",
  "mayoreo de accesorios celular",
  "tienda de gadgets",
  "celulares y accesorios",
];

// Ciudades objetivo
const CIUDADES = [
  "Ciudad de México",
  "Mérida Yucatán",
  "Guadalajara",
  "Monterrey",
  "Puebla",
  "Cancún",
  "Tijuana",
  "León Guanajuato",
  "Querétaro",
  "San Luis Potosí",
  "Culiacán",
  "Hermosillo",
  "Chihuahua",
  "Veracruz",
  "Oaxaca",
];

// Cadenas y franquicias que NO van a importar con nosotros
const BLACKLIST = [
  "mobo", "iShop", "istore", "apple store", "samsung", "telcel", "at&t", "telmex",
  "office depot", "officemax", "staples", "walmart", "liverpool", "suburbia",
  "sears", "chedraui", "soriana", "oxxo", "seven eleven", "7-eleven",
  "la casa de las carcasas", "casio", "huawei", "xiaomi store", "oppo store",
  "mercado libre", "amazon", "best buy", "radioshack", "mixup",
  "cel·plus", "icentro", "ismart", "ifone", "itech", "iplace",
  "claro", "nextel", "virgin mobile", "unefon", "bait",
  "cinepolis", "cinemex", "starbucks", "mcdonalds", "subway",
  "grupo elektra", "elektra", "famsa", "coppel",
];

function esBlacklisted(nombre) {
  if (!nombre) return true;
  const n = nombre.toLowerCase();
  return BLACKLIST.some(b => n.includes(b.toLowerCase()));
}

async function scrapeGoogleMaps(giro, ciudad) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "es-MX",
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { "Accept-Language": "es-MX,es;q=0.9" },
  });

  const page = await context.newPage();

  // Ocultar webdriver para evitar detección
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, "languages", { get: () => ["es-MX", "es"] });
    window.chrome = { runtime: {} };
  });
  const leads = [];

  try {
    const query = encodeURIComponent(`${giro} en ${ciudad}`);
    await page.goto(`https://www.google.com/maps/search/${query}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Esperar a que carguen resultados
    await page.waitForTimeout(6000);
    await page.waitForSelector('[role="feed"]', { timeout: 30000 }).catch(() => {});

    // Scroll agresivo para cargar más resultados
    const feed = await page.$('[role="feed"]');
    if (feed) {
      for (let i = 0; i < 10; i++) {
        await feed.evaluate((el) => (el.scrollTop += 1000));
        await page.waitForTimeout(1500);
      }
    }

    // Obtener todos los negocios en la lista
    const items = await page.$$('[role="feed"] > div');
    console.log(`  → Encontrados ${items.length} items en feed`);

    for (const item of items.slice(0, 40)) {
      try {
        // Click para ver detalle
        await item.click();
        await page.waitForTimeout(3000);

        // Esperar panel de detalle y obtener nombre del negocio
        await page.waitForSelector('h1.DUwDvf, h1[class*="DUwDvf"], h1[class*="fontHeadline"]', { timeout: 3000 }).catch(() => {});
        const nombre = await page.$eval(
          'h1.DUwDvf, h1[class*="DUwDvf"], h1[class*="fontHeadline"]',
          (el) => el.textContent?.trim()
        ).catch(() => null);
        // Teléfono: buscar por aria-label o data-item-id
        const telefono = await page.$eval('[data-item-id*="phone"] .fontBodyMedium', (el) => el.textContent?.trim())
          .catch(() => page.$eval('button[data-item-id*="phone"]', (el) => el.textContent?.trim())
          .catch(() => null));
        const sitio = await page.$eval('[data-item-id*="authority"] .fontBodyMedium', (el) => el.textContent?.trim())
          .catch(() => null);
        const direccion = await page.$eval('[data-item-id="address"] .fontBodyMedium', (el) => el.textContent?.trim())
          .catch(() => page.$eval('button[data-item-id="address"]', (el) => el.textContent?.trim())
          .catch(() => null));

        // Filtrar cadenas y negocios sin datos útiles
        if (nombre && !esBlacklisted(nombre) && (telefono || sitio)) {
          let email = null;
          if (sitio) {
            email = extractEmailFromDomain(sitio);
          }

          leads.push({
            negocio: nombre,
            telefono: telefono ? limpiarTelefono(telefono) : null,
            email,
            ciudad: extraerCiudad(direccion, ciudad),
            giro,
            fuente: "google_maps",
            canal: telefono ? "whatsapp" : "email",
          });
          console.log(`    ✅ ${nombre} | ${telefono || sitio}`);
        } else if (nombre && esBlacklisted(nombre)) {
          console.log(`    ⛔ Filtrado: ${nombre}`);
        }
      } catch (_) {
        // continuar con el siguiente
      }
    }
  } catch (err) {
    console.error(`Error scraping ${giro} en ${ciudad}:`, err.message);
  } finally {
    await browser.close();
  }

  return leads;
}

function limpiarTelefono(tel) {
  return tel.replace(/\s+/g, "").replace(/[^+\d]/g, "");
}

function extraerCiudad(direccion, ciudadDefault) {
  if (!direccion) return ciudadDefault.split(" ")[0];
  const partes = direccion.split(",");
  return partes[partes.length - 2]?.trim() || ciudadDefault.split(" ")[0];
}

function extractEmailFromDomain(domain) {
  // Intento básico de construir email probable
  const clean = domain.replace(/https?:\/\//, "").replace(/\/$/, "").split("/")[0];
  return `contacto@${clean}`;
}

async function saveLead(lead) {
  try {
    await sql`
      INSERT INTO leads (nombre, negocio, telefono, email, ciudad, giro, fuente, canal)
      VALUES (
        ${lead.nombre || ""},
        ${lead.negocio || ""},
        ${lead.telefono || ""},
        ${lead.email || ""},
        ${lead.ciudad || ""},
        ${lead.giro || ""},
        ${lead.fuente || "google_maps"},
        ${lead.canal || "whatsapp"}
      )
      ON CONFLICT DO NOTHING
    `;
    return true;
  } catch (_) {
    return false;
  }
}

async function runScraper() {
  // Elige 3 combos distintos por ejecución
  const combos = [];
  const usedGiros = new Set();
  const usedCiudades = new Set();

  while (combos.length < 3) {
    const giro = GIROS[Math.floor(Math.random() * GIROS.length)];
    const ciudad = CIUDADES[Math.floor(Math.random() * CIUDADES.length)];
    const key = `${giro}|${ciudad}`;
    if (!usedGiros.has(giro) || !usedCiudades.has(ciudad)) {
      combos.push({ giro, ciudad });
      usedGiros.add(giro);
      usedCiudades.add(ciudad);
    }
  }

  let totalSaved = 0;
  const resumen = [];

  for (const { giro, ciudad } of combos) {
    console.log(`[${new Date().toISOString()}] Scraping: "${giro}" en "${ciudad}"`);
    const leads = await scrapeGoogleMaps(giro, ciudad);
    console.log(`Encontrados: ${leads.length} negocios válidos`);

    let saved = 0;
    for (const lead of leads) {
      const ok = await saveLead(lead);
      if (ok) saved++;
    }

    console.log(`Guardados: ${saved} leads nuevos`);
    totalSaved += saved;
    resumen.push(`• ${giro} / ${ciudad}: ${saved} leads`);

    // Pausa entre combos para no gatillar rate limit
    await new Promise(r => setTimeout(r, 5000));
  }

  if (totalSaved > 0) {
    await sendTelegram(
      `📍 <b>Scraper Orvia — Pedido Grupal iPhone</b>\n\n${resumen.join("\n")}\n\n✅ <b>${totalSaved} leads nuevos</b> guardados.\n🎯 Campaña: fundas y micas iPhone 11–17\n<a href="https://www.orviamx.com/dashboard/admin/leads">Ver leads →</a>`
    );
  }

  return { totalSaved, combos: resumen };
}

module.exports = { runScraper };
