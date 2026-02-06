#!/usr/bin/env node

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const enhancer = require("../poe-trade-history-enhancer.user.js");

const ROOT = path.join(__dirname, "..");
const DEV_DIR = path.join(ROOT, "dev");
const FIXTURE_PATH = path.join(ROOT, "local-fixtures", "raw-response.json");

function readText(p) {
  return fs.readFileSync(p, "utf8");
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, data) {
  send(res, 200, { "content-type": "application/json; charset=utf-8" }, JSON.stringify(data, null, 2));
}

function safeReadStatic(relPath) {
  const abs = path.join(DEV_DIR, relPath);
  if (!abs.startsWith(DEV_DIR + path.sep)) return null;
  if (!fs.existsSync(abs)) return null;
  return abs;
}

function loadFixture() {
  const raw = JSON.parse(readText(FIXTURE_PATH));
  const normalized = Array.isArray(raw?.result)
    ? raw.result
        .map(enhancer.normalizeRow)
        .filter(Boolean)
        .filter((r) => r.priceAmount != null && r.priceCurrency)
    : [];
  normalized.sort((a, b) => (b.timeMs || 0) - (a.timeMs || 0));
  return { raw, normalized };
}

const fixture = loadFixture();

function getAvailableCurrencies(rows) {
  const set = new Set();
  for (const r of rows) if (r?.priceCurrency) set.add(String(r.priceCurrency));
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

const availableCurrencies = getAvailableCurrencies(fixture.normalized);

const port = Number(process.env.PORT) || 3000;

const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url || "/", "http://localhost");
    const pathname = u.pathname || "/";

    if (pathname === "/" || pathname === "/index.html") {
      const htmlPath = safeReadStatic("index.html");
      if (!htmlPath) return send(res, 404, { "content-type": "text/plain; charset=utf-8" }, "Not found");
      return send(res, 200, { "content-type": "text/html; charset=utf-8" }, readText(htmlPath));
    }

    if (pathname === "/app.js") {
      const jsPath = safeReadStatic("app.js");
      if (!jsPath) return send(res, 404, { "content-type": "text/plain; charset=utf-8" }, "Not found");
      return send(res, 200, { "content-type": "text/javascript; charset=utf-8" }, readText(jsPath));
    }

    if (pathname === "/style.css") {
      const cssPath = safeReadStatic("style.css");
      if (!cssPath) return send(res, 404, { "content-type": "text/plain; charset=utf-8" }, "Not found");
      return send(res, 200, { "content-type": "text/css; charset=utf-8" }, readText(cssPath));
    }

    if (pathname === "/data.json") {
      const preferred = enhancer.normalizeCurrency(u.searchParams.get("preferred") || "") || "chaos";
      const stats = enhancer.computeIncomeStats(fixture.normalized, { preferredCurrency: preferred });
      return sendJson(res, {
        preferredCurrency: stats.preferredCurrency,
        availableCurrencies,
        stats,
        rows: fixture.normalized,
      });
    }

    return send(res, 404, { "content-type": "text/plain; charset=utf-8" }, "Not found");
  } catch (err) {
    return send(res, 500, { "content-type": "text/plain; charset=utf-8" }, String(err?.stack || err));
  }
});

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Browse: http://localhost:${port}`);
});
