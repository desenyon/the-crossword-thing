import http from "http";
import net from "net";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { buildApp } from "./app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "..", "public");

const PREFERRED_PORT = Number.parseInt(process.env.PORT || "3847", 10);
const PORT_FALLBACK_SPAN = 24;

function pickFreeTcpPort(startPort, endPortInclusive) {
  return new Promise((resolve) => {
    const tryPort = (port) => {
      if (port > endPortInclusive) {
        resolve(null);
        return;
      }
      const probe = net.createServer();
      probe.once("error", (err) => {
        if (err.code === "EADDRINUSE") {
          tryPort(port + 1);
        } else {
          resolve(null);
        }
      });
      probe.listen(port, "0.0.0.0", () => {
        probe.close(() => {
          resolve(port);
        });
      });
    };
    tryPort(startPort);
  });
}

function listLanIps() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const addrs of Object.values(nets)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family === "IPv4" && !a.internal) {
        out.push(a.address);
      }
    }
  }
  return out;
}

async function main() {
  if (!fs.existsSync(PUBLIC)) {
    console.error("Missing public/ folder. Run from project root.");
    process.exit(1);
  }

  const maxPort = PREFERRED_PORT + PORT_FALLBACK_SPAN;
  const chosen = await pickFreeTcpPort(PREFERRED_PORT, maxPort);
  if (chosen == null) {
    console.error("");
    console.error("  TheCrosswordThing could not find a free TCP port.");
    console.error(`  Tried ${PREFERRED_PORT} through ${maxPort}.`);
    console.error("  Pick another range: PORT=4000 npm start");
    console.error("");
    process.exit(1);
  }
  if (chosen !== PREFERRED_PORT) {
    console.warn(`Using port ${chosen} (${PREFERRED_PORT} is already in use).`);
  }

  const app = buildApp();
  const server = http.createServer(app);

  const onBindError = (err) => {
    console.error("");
    console.error("  Could not bind after port scan:", err.message);
    console.error("  Try again, or use another port: PORT=4000 npm start");
    console.error("");
    process.exit(1);
  };
  server.once("error", onBindError);

  server.listen(chosen, "0.0.0.0", () => {
    server.off("error", onBindError);
    server.on("error", (err) => {
      console.error("HTTP server error:", err.message);
    });

    const ips = listLanIps();
    const base = `http://127.0.0.1:${chosen}`;
    console.log("");
    console.log("  TheCrosswordThing server");
    console.log(`  Local:   ${base}`);
    for (const ip of ips) {
      console.log(`  Network: http://${ip}:${chosen}`);
    }
    console.log("");
    console.log("  Open the Network URL on phones (same WiFi).");
    console.log("  For internet-wide play, deploy to Vercel and add Upstash Redis.");
    console.log("  Press Ctrl+C to stop.");
    console.log("");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
