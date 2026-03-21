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

// Giros a buscar
const GIROS = [
  "accesorios para celular",
  "tienda de electrónica",
  "mayorista de ropa",
  "tienda de juguetes",
  "artículos para el hogar",
  "ferretería",
  "papelería",
  "cosméticos y belleza",
  "calzado mayoreo",
  "bisutería y accesorios",
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
];

async function scrapeGoogleMaps(giro, ciudad) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "es-MX",
  });

  const page = await context.newPage();
  const leads = [];

  try {
    const query = encodeURIComponent(`${giro} en ${ciudad}`);
    await page.goto(`https://www.google.com/maps/search/${query}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Esperar a que carguen resultados
    await page.waitForTimeout(4000);
    await page.waitForSelector('[role="feed"]', { timeout: 20000 }).catch(() => {});

    // Scroll para cargar más resultados
    const feed = await page.$('[role="feed"]');
    if (feed) {
      for (let i = 0; i < 3; i++) {
        await feed.evaluate((el) => (el.scrollTop += 1000));
        await page.waitForTimeout(1500);
      }
    }

    // Obtener todos los negocios en la lista
    const items = await page.$$('[role="feed"] > div');

    for (const item of items.slice(0, 20)) {
      try {
        // Click para ver detalle
        await item.click();
        await page.waitForTimeout(2000);

        const nombre = await page.$eval('h1[class*="fontHeadlineLarge"]', (el) => el.textContent?.trim()).catch(() => null);
        const telefono = await page.$eval('[data-item-id*="phone"] [class*="fontBodyMedium"]', (el) => el.textContent?.trim()).catch(() => null);
        const sitio = await page.$eval('[data-item-id*="authority"] [class*="fontBodyMedium"]', (el) => el.textContent?.trim()).catch(() => null);
        const direccion = await page.$eval('[data-item-id="address"] [class*="fontBodyMedium"]', (el) => el.textContent?.trim()).catch(() => null);

        if (nombre && (telefono || sitio)) {
          // Extraer email del sitio web si es posible (básico)
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
  // Cada vez elige un giro y ciudad al azar para no repetir siempre lo mismo
  const giro = GIROS[Math.floor(Math.random() * GIROS.length)];
  const ciudad = CIUDADES[Math.floor(Math.random() * CIUDADES.length)];

  console.log(`[${new Date().toISOString()}] Scraping: "${giro}" en "${ciudad}"`);

  const leads = await scrapeGoogleMaps(giro, ciudad);
  console.log(`Encontrados: ${leads.length} negocios`);

  let saved = 0;
  for (const lead of leads) {
    const ok = await saveLead(lead);
    if (ok) saved++;
  }

  console.log(`Guardados: ${saved} leads nuevos en DB`);

  if (saved > 0) {
    await sendTelegram(`📍 <b>Scraper Orvia</b>\n\nGiro: ${giro}\nCiudad: ${ciudad}\n\n✅ ${saved} leads nuevos guardados en tu dashboard.\n<a href="https://www.orviamx.com/dashboard/admin/leads">Ver leads →</a>`);
  }

  return { giro, ciudad, found: leads.length, saved };
}

module.exports = { runScraper };
