const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const enhancer = require("../poe-trade-history-enhancer.user.js");

function loadFixture() {
  const p = path.join(__dirname, "..", "raw-response.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

test("fixture shape", () => {
  const payload = loadFixture();
  assert.ok(payload && typeof payload === "object");
  assert.ok(Array.isArray(payload.result));
  assert.ok(payload.result.length > 0);
});

test("decodeItemText decodes PoE item text", () => {
  const payload = loadFixture();
  const textB64 = payload.result[0]?.item?.extended?.text;
  assert.equal(typeof textB64, "string");
  const decoded = enhancer.decodeItemText(textB64);
  assert.equal(typeof decoded, "string");
  assert.match(decoded, /^Item Class:\s+/m);
});

test("normalizeRow produces stable core fields", () => {
  const payload = loadFixture();
  const row = payload.result[0];
  const n = enhancer.normalizeRow(row);
  assert.ok(n);
  assert.equal(n.itemId, row.item_id);
  assert.equal(n.timeIso, row.time);
  assert.ok(Number.isFinite(n.timeMs));
  assert.equal(typeof n.name, "string");
  assert.ok(n.name.length > 0);

  if (row.price?.amount != null && row.price?.currency) {
    assert.equal(n.priceAmount, row.price.amount);
    assert.equal(n.priceCurrency, String(row.price.currency).toLowerCase());
    assert.equal(n.priceText, `${enhancer.formatAmount(row.price.amount)} ${String(row.price.currency).toLowerCase()}`);
  }
});

test("computeIncomeStats totals match raw-response.json", () => {
  const payload = loadFixture();
  const normalized = payload.result
    .map(enhancer.normalizeRow)
    .filter(Boolean)
    .filter((r) => r.priceAmount != null && r.priceCurrency);

  const expectedTotals = new Map();
  for (const r of normalized) {
    const k = enhancer.normalizeCurrency(r.priceCurrency);
    expectedTotals.set(k, (expectedTotals.get(k) || 0) + r.priceAmount);
  }

  const stats = enhancer.computeIncomeStats(normalized, { preferredCurrency: "chaos" });
  assert.equal(stats.trades, normalized.length);
  assert.equal(stats.totalText, enhancer.formatCurrencyMap(expectedTotals));
});

test("computeIncomeStats converts chaos/divine when divineChaosPrice is set", () => {
  const now = Date.now();
  const rows = [
    { timeMs: now, priceAmount: 100, priceCurrency: "chaos" },
    { timeMs: now, priceAmount: 1, priceCurrency: "divine" },
  ];

  const stats = enhancer.computeIncomeStats(rows, { preferredCurrency: "chaos", divineChaosPrice: 150 });
  assert.equal(stats.totalText, "100 chaos + 1 divine");
  assert.equal(stats.totalPreferredText, "250 chaos");
  assert.equal(stats.byDay.length, 1);
  assert.equal(stats.byDay[0].incomeText, "250 chaos");
});

test("computeIncomeStats does not convert when divineChaosPrice is missing", () => {
  const now = Date.now();
  const rows = [
    { timeMs: now, priceAmount: 100, priceCurrency: "chaos" },
    { timeMs: now, priceAmount: 1, priceCurrency: "divine" },
  ];

  const stats = enhancer.computeIncomeStats(rows, { preferredCurrency: "chaos" });
  assert.equal(stats.totalText, "100 chaos + 1 divine");
  assert.equal(stats.totalPreferredText, null);
  assert.equal(stats.byDay.length, 1);
  assert.equal(stats.byDay[0].incomeText, "100 chaos + 1 divine");
});
