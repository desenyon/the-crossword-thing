import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import QRCode from "qrcode";
import { tctRouter } from "./tctApiRouter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");

export function buildApp() {
  const app = express();
  app.disable("x-powered-by");

  app.use("/api/tct", express.json({ limit: "48kb" }), tctRouter);

  app.get("/healthz", (_req, res) => {
    res.type("text/plain").send("ok");
  });

  app.get("/api/qr", async (req, res) => {
    const text = typeof req.query.text === "string" ? req.query.text : "";
    if (text.length > 2048) {
      res.status(400).type("text/plain").send("text too long");
      return;
    }
    try {
      const svg = await QRCode.toString(text || " ", {
        type: "svg",
        margin: 1,
        width: 220,
        errorCorrectionLevel: "M",
        color: { dark: "#0a0c12ff", light: "#ffffffff" },
      });
      res.type("image/svg+xml").set("Cache-Control", "no-store").send(svg);
    } catch {
      res.status(500).type("text/plain").send("qr failed");
    }
  });

  app.use(
    express.static(PUBLIC, {
      extensions: ["html"],
      etag: true,
      maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
      setHeaders(res, filePath) {
        if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-store");
        }
      },
    }),
  );

  app.get("/", (_req, res) => {
    res.sendFile(path.join(PUBLIC, "index.html"));
  });

  app.use((_req, res) => {
    res.status(404).type("text/plain").send("not found");
  });

  return app;
}
