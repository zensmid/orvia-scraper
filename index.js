require("dotenv").config();
const cron = require("node-cron");
const { runScraper } = require("./scrape");

console.log("🤖 Orvia Scraper iniciado");
console.log("📅 Cron: lunes a viernes a las 9am, 2pm y 7pm (hora México)");

// Lunes a viernes, 9am / 2pm / 7pm hora México (UTC-6 = 15:00, 20:00, 01:00 UTC)
cron.schedule("0 15,20 * * 1-5", async () => {
  console.log("⏰ Cron activado — iniciando scrape...");
  try {
    const result = await runScraper();
    console.log(`✅ Completado: ${result.totalSaved} leads nuevos`);
  } catch (err) {
    console.error("❌ Error en cron:", err.message);
  }
});

// También corre una vez al arrancar para verificar que funciona
setTimeout(async () => {
  console.log("🔍 Corrida inicial de prueba...");
  try {
    const result = await runScraper();
    console.log(`✅ Prueba OK: ${result.totalSaved} leads nuevos`);
  } catch (err) {
    console.error("❌ Error inicial:", err.message);
  }
}, 5000);
