// ==UserScript==
// @name         PoE Trade History Enhancer
// @namespace    https://github.com/claespettersson/poe-trade-history-enhancer
// @version      1.1.0
// @updateURL    https://github.com/C-Pettersson/poe-trade-histsory-enhancer/raw/refs/heads/main/poe-trade-history-enhancer.user.js
// @downloadURL  https://github.com/C-Pettersson/poe-trade-histsory-enhancer/raw/refs/heads/main/poe-trade-history-enhancer.user.js
// @description  Enhances https://www.pathofexile.com/trade/history with a sortable/filterable table, "new" highlighting, and copy-item-text.
// @author       Vauxite
// @match        https://www.pathofexile.com/trade/history*
// @run-at       document-start
// @grant        GM_addStyle
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
  "use strict";

  const IS_NODE =
    typeof module === "object" &&
    typeof module?.exports === "object" &&
    (typeof window === "undefined" || typeof document === "undefined");

  // Allow `require("./poe-trade-history-enhancer.user.js")` in Node for local tests.
  // In Node we export the pure/data functions and skip all DOM + GM_* integration.
  if (IS_NODE) {
    module.exports = {
      normalizeRow,
      computeIncomeStats,
      rarityLabel,
      itemCategoryLabel,
      humanizeCategoryToken,
      normalizeCurrency,
      formatAmount,
      decodeItemText,
      formatLocalTime,
      formatTimeAgo,
      localDayKey,
      localWeekStartKey,
      formatCurrencyMap,
    };
    return;
  }

  const STORAGE_KEY = "pthEnhancer.settings.v1";
  const STORAGE_SEEN_KEY = "pthEnhancer.seenItemIds.v1";
  const STORAGE_ARCHIVE_PREFIX = "pthEnhancer.tradeArchive.v1.";

  /** @type {{onlyNew: boolean, hideOriginal: boolean, preferredCurrency: string, divineChaosPrice: (number|null)}} */
  const settings = loadSettings();

  /** @type {Set<string>} */
  const seenItemIds = loadSeenSet();

  /** @type {null | { league: string, rows: Array<ReturnType<typeof normalizeRow>>, gapInfo: ReturnType<typeof detectGap> }} */
  let lastPayload = null;

  const ui = createUi();
  installNetworkSniffer();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  function boot() {
    document.body.appendChild(ui.root);
    ui.updateSettings(settings);
    ui.setStatus("Waiting for data…");
    ui.onRefresh(() => refresh());
    ui.onSettingsChange((next) => {
      Object.assign(settings, next);
      saveSettings(settings);
      applyHideOriginal();
      if (lastPayload) renderFromPayload(lastPayload);
    });
    ui.onMarkAllSeen(() => {
      if (!lastPayload) return;
      for (const row of lastPayload.rows) {
        const id = row?.itemId;
        if (typeof id === "string" && id) seenItemIds.add(id);
      }
      persistSeenSet(seenItemIds);
      renderFromPayload(lastPayload);
    });

    applyHideOriginal();

    // If the page already loaded without calling the API (or our sniffer missed it), do a first fetch.
    refresh();
  }

  async function refresh() {
    try {
      const league = detectLeagueFromDom() ?? lastPayload?.league ?? null;
      if (!league) {
        ui.setStatus("Select a league (or wait for the page to load data) …");
        return;
      }
      ui.setStatus(`Loading history for "${league}"…`);
      const payload = await fetchHistory(league);
      handleHistoryPayload(league, payload);
    } catch (err) {
      ui.setStatus(`Error: ${stringifyError(err)}`);
    }
  }

  function handleHistoryPayload(league, payload) {
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.result)) {
      ui.setStatus("Unexpected API response (missing result[]).");
      return;
    }

    const persisted = persistHistoryBatch(league, payload.result);
    lastPayload = { league, rows: persisted.rows, gapInfo: persisted.gapInfo };
    renderFromPayload(lastPayload);
  }

  function renderFromPayload(payload) {
    const { league, rows, gapInfo } = payload;

    const now = Date.now();
    let newCount = 0;

    const normalized = [];
    for (const row of rows) {
      // Trade history is sold items only; require a concrete price.
      if (row.priceAmount == null || !row.priceCurrency) continue;
      const isNew = !seenItemIds.has(row.itemId);
      if (isNew) newCount += 1;
      if (settings.onlyNew && !isNew) continue;
      normalized.push(row);
    }

    ui.setHeader({
      league,
      count: normalized.length,
      newCount,
      archivedCount: rows.length,
      lastUpdated: now,
    });

    ui.renderStats(
      computeIncomeStats(normalized, {
        preferredCurrency: settings.preferredCurrency,
        divineChaosPrice: settings.divineChaosPrice,
      }),
    );

    ui.renderTable(normalized, {
      isNew: (itemId) => !seenItemIds.has(itemId),
      onCopyItemText: (itemText) => {
        GM_setClipboard(itemText, { type: "text", mimetype: "text/plain" });
        ui.toast("Copied item text");
      },
      onMarkSeen: (itemId) => {
        seenItemIds.add(itemId);
        persistSeenSet(seenItemIds);
        if (lastPayload) renderFromPayload(lastPayload);
      },
    });

    const gapLabel = gapInfo?.detected
      ? ` • gap detected (${gapInfo.fromTimeLocal} -> ${gapInfo.toTimeLocal})`
      : "";
    ui.setStatus(`Ready • archived ${rows.length}${gapLabel}`);
  }

  function applyHideOriginal() {
    const hide = !!settings.hideOriginal;
    document.documentElement.dataset.pthHideOriginal = hide ? "1" : "0";
  }

  function installNetworkSniffer() {
    // Sniff fetch
    const originalFetch = window.fetch;
    window.fetch = async function (input, init) {
      const res = await originalFetch.call(this, input, init);
      trySniffResponse(input, res);
      return res;
    };

    // Sniff XHR (in case PoE uses it)
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__pthUrl = url;
      return originalOpen.apply(this, arguments);
    };
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      this.addEventListener(
        "load",
        () => {
          try {
            const url = this.__pthUrl;
            if (!isHistoryApiUrl(url)) return;
            const text = this.responseType && this.responseType !== "text" ? null : this.responseText;
            if (!text) return;
            const json = JSON.parse(text);
            const league = extractLeagueFromHistoryUrl(url);
            if (!league) return;
            handleHistoryPayload(league, json);
          } catch {
            // ignore
          }
        },
        { once: true },
      );
      return originalSend.apply(this, arguments);
    };
  }

  async function trySniffResponse(input, res) {
    try {
      const url = typeof input === "string" ? input : input?.url;
      if (!isHistoryApiUrl(url)) return;
      // Clone so the page can still read it.
      const clone = res.clone();
      const json = await clone.json();
      const league = extractLeagueFromHistoryUrl(url);
      if (!league) return;
      handleHistoryPayload(league, json);
    } catch {
      // ignore
    }
  }

  function isHistoryApiUrl(url) {
    return typeof url === "string" && url.includes("/api/trade/history/");
  }

  function extractLeagueFromHistoryUrl(url) {
    if (typeof url !== "string") return null;
    const idx = url.indexOf("/api/trade/history/");
    if (idx < 0) return null;
    const leaguePart = url.slice(idx + "/api/trade/history/".length);
    if (!leaguePart) return null;
    try {
      return decodeURIComponent(leaguePart);
    } catch {
      return leaguePart;
    }
  }

  async function fetchHistory(league) {
    const url = `/api/trade/history/${encodeURIComponent(league)}`;
    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  }

  function detectLeagueFromDom() {
    // Heuristic: find a <select> that looks like a league selector.
    const selects = Array.from(document.querySelectorAll("select"));
    for (const sel of selects) {
      const id = (sel.id || "").toLowerCase();
      const name = (sel.getAttribute("name") || "").toLowerCase();
      const cls = (sel.className || "").toString().toLowerCase();
      const looksLikeLeague = [id, name, cls].some((s) => s.includes("league"));
      if (!looksLikeLeague) continue;
      const opt = sel.selectedOptions?.[0];
      const value = (opt?.value || "").trim();
      if (value) return value;
      const text = (opt?.textContent || "").trim();
      if (text) return text;
    }

    // Backup: any option that is selected inside a league-ish container.
    const maybe = document.querySelector(
      "[id*='league' i] select option:checked, [class*='league' i] select option:checked, [name*='league' i] option:checked",
    );
    const value = (maybe?.value || "").trim();
    if (value) return value;
    const text = (maybe?.textContent || "").trim();
    return text || null;
  }

  function normalizeRow(row) {
    const itemId = row?.item_id;
    const timeIso = row?.time;
    if (!itemId || !timeIso) return null;
    const timeMs = Date.parse(timeIso);
    if (!Number.isFinite(timeMs)) return null;

    const item = row?.item ?? null;

    const typeLine = (item?.typeLine || "").trim();
    const baseType = (item?.baseType || "").trim();
    const extendedTextB64 = item?.extended?.text;
    const itemText = typeof extendedTextB64 === "string" ? decodeItemText(extendedTextB64) : null;

    const rarity = rarityLabel(item?.frameType);
    const category = itemCategoryLabel(item, itemText);
    const ilvl = typeof item?.ilvl === "number" ? item.ilvl : null;

    const rawPriceAmount = row?.price?.amount;
    const rawPriceCurrency = row?.price?.currency;
    const priceAmount = typeof rawPriceAmount === "number" && Number.isFinite(rawPriceAmount) ? rawPriceAmount : null;
    const priceCurrency = typeof rawPriceCurrency === "string" ? normalizeCurrency(rawPriceCurrency) : null;
    const priceText = priceAmount != null && priceCurrency ? `${formatAmount(priceAmount)} ${priceCurrency}` : "";

    const note = typeof item?.note === "string" ? item.note : "";
    const fracturedMods = (Array.isArray(item?.fracturedMods) ? item.fracturedMods : []).filter(
      (m) => typeof m === "string" && m.trim().length > 0,
    );
    const mods = [
      ...(Array.isArray(item?.implicitMods) ? item.implicitMods : []),
      ...(Array.isArray(item?.explicitMods) ? item.explicitMods : []),
      ...(Array.isArray(item?.utilityMods) ? item.utilityMods : []),
      ...fracturedMods,
      ...(Array.isArray(item?.craftedMods) ? item.craftedMods : []),
      ...(Array.isArray(item?.enchantMods) ? item.enchantMods : []),
    ].filter((m) => typeof m === "string" && m.trim().length > 0);

    return {
      itemId,
      timeIso,
      timeMs,
      timeLocal: formatLocalTime(timeIso),
      timeAgo: formatTimeAgo(timeIso),
      name: typeLine || baseType || "(unknown)",
      baseType: baseType || "",
      rarity,
      category,
      ilvl,
      priceText,
      priceAmount,
      priceCurrency,
      note,
      fracturedMods,
      mods,
      itemText,
      icon: typeof item?.icon === "string" ? item.icon : null,
    };
  }

  function rarityLabel(frameType) {
    // https://www.poewiki.net/wiki/Item_class#Frame_types (rough mapping, but fine for labeling)
    switch (frameType) {
      case 0:
        return "Normal";
      case 1:
        return "Magic";
      case 2:
        return "Rare";
      case 3:
        return "Unique";
      case 4:
        return "Gem";
      case 5:
        return "Currency";
      case 6:
        return "Divination";
      case 7:
        return "Quest";
      default:
        return "";
    }
  }

  function rarityColor(rarity) {
    const key = String(rarity || "").trim().toLowerCase();
    switch (key) {
      case "unique":
        return "rgb(175, 96, 37)";
      case "rare":
        return "rgb(255, 255, 119)";
      case "magic":
        return "rgb(136, 136, 255)";
      case "normal":
        return "rgb(200, 200, 200)";
      case "gem":
        return "rgb(27, 162, 155)";
      case "currency":
        return "rgb(170, 158, 130)";
      case "quest":
        return "rgb(74, 230, 58)";
      default:
        return "";
    }
  }

  function itemCategoryLabel(item, itemText) {
    const direct = item?.extended?.category;
    if (typeof direct === "string" && direct.trim()) return humanizeCategoryToken(direct);

    const cat = item?.category;
    if (cat && typeof cat === "object") {
      for (const [k, v] of Object.entries(cat)) {
        if (!k) continue;
        if (Array.isArray(v) && v.length) {
          const sub = typeof v[0] === "string" ? v[0] : "";
          return sub ? `${humanizeCategoryToken(k)}: ${humanizeCategoryToken(sub)}` : humanizeCategoryToken(k);
        }
        return humanizeCategoryToken(k);
      }
    }

    if (typeof itemText === "string" && itemText) {
      const m = itemText.match(/^Item Class:\s*(.+)\s*$/m);
      if (m && m[1]) return m[1].trim();
    }

    return "";
  }

  function humanizeCategoryToken(token) {
    return String(token || "")
      .trim()
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .split(" ")
      .filter(Boolean)
      .map((w) => w.slice(0, 1).toUpperCase() + w.slice(1))
      .join(" ");
  }

  function normalizeCurrency(currency) {
    return String(currency || "")
      .trim()
      .toLowerCase();
  }

  function formatAmount(amount) {
    if (!Number.isFinite(amount)) return "";
    if (Number.isInteger(amount)) return String(amount);
    return String(Number(amount.toFixed(2)));
  }

  function decodeItemText(b64) {
    try {
      // PoE uses base64 of the in-game copy text.
      const decoded =
        typeof atob === "function" ? atob(b64) : Buffer.from(String(b64), "base64").toString("utf8");
      // Normalize newlines for clipboard.
      return decoded.replace(/\r\n/g, "\n");
    } catch {
      return null;
    }
  }

  function formatLocalTime(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return iso;
    return new Date(t).toLocaleString();
  }

  function formatTimeAgo(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const deltaMs = Date.now() - t;
    const deltaSec = Math.floor(deltaMs / 1000);
    if (deltaSec < 0) return "in the future";
    if (deltaSec < 60) return `${deltaSec}s ago`;
    const deltaMin = Math.floor(deltaSec / 60);
    if (deltaMin < 60) return `${deltaMin}m ago`;
    const deltaHr = Math.floor(deltaMin / 60);
    if (deltaHr < 48) return `${deltaHr}h ago`;
    const deltaDay = Math.floor(deltaHr / 24);
    return `${deltaDay}d ago`;
  }

  function clampInt(n, min, max) {
    const x = Number(n);
    if (!Number.isFinite(x)) return min;
    return Math.max(min, Math.min(max, Math.floor(x)));
  }

  function stringifyError(err) {
    if (err instanceof Error) return err.message || String(err);
    return String(err);
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultSettings();
      const parsed = JSON.parse(raw);
      return {
        onlyNew: !!parsed.onlyNew,
        hideOriginal: !!parsed.hideOriginal,
        preferredCurrency: typeof parsed.preferredCurrency === "string" ? normalizeCurrency(parsed.preferredCurrency) || "chaos" : "chaos",
        divineChaosPrice: toPositiveNumberOrNull(parsed.divineChaosPrice),
      };
    } catch {
      return defaultSettings();
    }
  }

  function defaultSettings() {
    return { onlyNew: false, hideOriginal: false, preferredCurrency: "chaos", divineChaosPrice: null };
  }

  function saveSettings(next) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }

  function loadSeenSet() {
    try {
      const raw = localStorage.getItem(STORAGE_SEEN_KEY);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.filter((x) => typeof x === "string"));
    } catch {
      return new Set();
    }
  }

  function persistSeenSet(set) {
    // Keep it bounded so localStorage doesn't grow forever.
    const arr = Array.from(set);
    const bounded = arr.slice(Math.max(0, arr.length - 2000));
    localStorage.setItem(STORAGE_SEEN_KEY, JSON.stringify(bounded));
  }

  function leagueStorageKey(league) {
    return `${STORAGE_ARCHIVE_PREFIX}${encodeURIComponent(String(league || "").trim().toLowerCase())}`;
  }

  function makeTradeKey(league, normalizedRow) {
    const norm = normalizedRow;
    if (!norm || norm.priceAmount == null || !norm.priceCurrency) return null;
    return `${encodeURIComponent(String(league || "").trim().toLowerCase())}|${norm.itemId}|${norm.timeIso}|${norm.priceAmount}|${norm.priceCurrency}`;
  }

  function normalizeAndKeyBatch(league, rawRows) {
    const rows = [];
    const keySet = new Set();

    for (const row of rawRows) {
      const norm = normalizeRow(row);
      if (!norm) continue;
      if (norm.priceAmount == null || !norm.priceCurrency) continue;
      const tradeKey = makeTradeKey(league, norm);
      if (!tradeKey || keySet.has(tradeKey)) continue;
      keySet.add(tradeKey);
      rows.push({ ...norm, tradeKey });
    }

    rows.sort((a, b) => b.timeMs - a.timeMs);
    return { rows, keySet };
  }

  function readArchive(league) {
    try {
      const raw = localStorage.getItem(leagueStorageKey(league));
      if (!raw) return { rows: [], meta: {} };
      const parsed = JSON.parse(raw);
      const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
      const meta = parsed && typeof parsed.meta === "object" && parsed.meta ? parsed.meta : {};
      return { rows: sanitizeArchiveRows(rows), meta };
    } catch {
      return { rows: [], meta: {} };
    }
  }

  function sanitizeArchiveRows(rows) {
    const out = [];
    const keys = new Set();

    for (const r of rows) {
      if (!r || typeof r !== "object") continue;
      if (typeof r.tradeKey !== "string" || !r.tradeKey) continue;
      if (keys.has(r.tradeKey)) continue;
      if (typeof r.itemId !== "string" || !r.itemId) continue;
      if (typeof r.timeIso !== "string" || !r.timeIso) continue;
      if (!Number.isFinite(r.timeMs)) continue;
      if (typeof r.priceCurrency !== "string" || !r.priceCurrency) continue;
      if (typeof r.priceAmount !== "number" || !Number.isFinite(r.priceAmount)) continue;
      keys.add(r.tradeKey);
      out.push(r);
    }

    out.sort((a, b) => b.timeMs - a.timeMs);
    return out;
  }

  function detectGap(lastMeta, currentRows, currentKeySet) {
    const prevNewestMs = Number.isFinite(lastMeta?.lastFetchNewestMs) ? lastMeta.lastFetchNewestMs : null;
    const prevKeys = Array.isArray(lastMeta?.lastFetchKeys)
      ? new Set(lastMeta.lastFetchKeys.filter((x) => typeof x === "string"))
      : new Set();

    if (!currentRows.length || !Number.isFinite(prevNewestMs)) {
      return { detected: false, fromTimeLocal: "", toTimeLocal: "" };
    }

    const currentOldestMs = currentRows[currentRows.length - 1].timeMs;
    if (!Number.isFinite(currentOldestMs) || currentOldestMs <= prevNewestMs) {
      return { detected: false, fromTimeLocal: "", toTimeLocal: "" };
    }

    const hasKeyOverlap = prevKeys.size
      ? Array.from(currentKeySet).some((k) => prevKeys.has(k))
      : false;
    if (hasKeyOverlap) return { detected: false, fromTimeLocal: "", toTimeLocal: "" };

    return {
      detected: true,
      fromTimeLocal: new Date(prevNewestMs).toLocaleString(),
      toTimeLocal: new Date(currentOldestMs).toLocaleString(),
    };
  }

  function persistHistoryBatch(league, rawRows) {
    const current = normalizeAndKeyBatch(league, rawRows);
    const archive = readArchive(league);
    const gapInfo = detectGap(archive.meta, current.rows, current.keySet);

    /** @type {Map<string, any>} */
    const merged = new Map();
    for (const r of archive.rows) merged.set(r.tradeKey, r);
    for (const r of current.rows) merged.set(r.tradeKey, r);

    const mergedRows = Array.from(merged.values()).sort((a, b) => b.timeMs - a.timeMs);
    const newestMs = current.rows.length ? current.rows[0].timeMs : null;
    const oldestMs = current.rows.length ? current.rows[current.rows.length - 1].timeMs : null;

    const nextMeta = {
      lastFetchAtMs: Date.now(),
      lastFetchNewestMs: newestMs,
      lastFetchOldestMs: oldestMs,
      lastFetchKeys: Array.from(current.keySet),
      gapCount: (Number.isFinite(archive.meta?.gapCount) ? archive.meta.gapCount : 0) + (gapInfo.detected ? 1 : 0),
      lastGapAtMs: gapInfo.detected ? Date.now() : archive.meta?.lastGapAtMs ?? null,
      lastGapFromMs: gapInfo.detected ? newestMs : archive.meta?.lastGapFromMs ?? null,
      lastGapToMs: gapInfo.detected ? oldestMs : archive.meta?.lastGapToMs ?? null,
    };

    writeArchive(league, mergedRows, nextMeta);
    return { rows: mergedRows, gapInfo };
  }

  function writeArchive(league, rows, meta) {
    const key = leagueStorageKey(league);
    let payloadRows = Array.isArray(rows) ? rows.slice() : [];

    while (payloadRows.length >= 0) {
      try {
        const payload = { rows: payloadRows, meta };
        localStorage.setItem(key, JSON.stringify(payload));
        return;
      } catch {
        if (payloadRows.length === 0) return;
        const nextLength = Math.floor(payloadRows.length * 0.9);
        payloadRows = payloadRows.slice(0, Math.max(0, nextLength));
      }
    }
  }

  function createUi() {
    GM_addStyle(`
      .pth-root{position:sticky;top:0;left:0;right:0;z-index:9999;display:block !important;float:none !important;clear:both !important;width:100% !important;min-width:100% !important;max-width:none !important;flex:none !important;background:#0b0f14;border-bottom:1px solid #1d2a36;color:#e6eef7;font:12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
      .pth-root *{box-sizing:border-box}
      .pth-wrap{display:block;width:100%;max-width:1400px;margin:0 auto;padding:10px 12px}
      .pth-row{display:flex !important;gap:10px;align-items:center;flex-wrap:wrap}
      .pth-title{font-size:13px;font-weight:600;margin-right:auto}
      .pth-muted{opacity:.75}
      .pth-btn{background:#16212b;color:#e6eef7;border:1px solid #223444;border-radius:6px;padding:6px 8px;cursor:pointer}
      .pth-btn:hover{background:#1a2732}
      .pth-btn:active{transform:translateY(1px)}
      .pth-input{background:#0f1720;color:#e6eef7;border:1px solid #223444;border-radius:6px;padding:6px 8px}
      .pth-table{width:100%;border-collapse:collapse;margin-top:10px}
      .pth-table th,.pth-table td{border-top:1px solid #1d2a36;padding:6px 8px;vertical-align:top}
      .pth-table th{position:sticky;top:52px;background:#0b0f14;z-index:1;text-align:left;font-weight:600}
      .pth-badge{display:inline-block;border:1px solid #223444;border-radius:999px;padding:2px 8px;background:#0f1720}
      .pth-new{background:rgba(60,120,255,.12)}
      .pth-icon{width:26px;height:26px;object-fit:contain}
      .pth-mods{max-width:720px}
      .pth-mod{display:inline-block;margin:0 6px 4px 0;padding:2px 6px;border-radius:6px;background:#101a24;border:1px solid #1d2a36}
      .pth-mod-fractured{color:#a29162;border-color:rgba(162,145,98,.7);background:rgba(162,145,98,.08)}
      .pth-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;margin-top:10px}
      .pth-card{border:1px solid #1d2a36;background:#0f1720;border-radius:10px;padding:8px}
      .pth-card-title{font-weight:600;margin-bottom:6px}
      .pth-mini{width:100%;border-collapse:collapse}
      .pth-mini th,.pth-mini td{border-top:1px solid #1d2a36;padding:4px 6px;vertical-align:top}
      .pth-mini th{text-align:left;font-weight:600;opacity:.9}
      .pth-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:14px;background:#101a24;color:#e6eef7;border:1px solid #223444;border-radius:10px;padding:8px 12px;z-index:10000;opacity:0;pointer-events:none;transition:opacity .15s ease}
      .pth-toast.pth-show{opacity:1}
      html[data-pth-hide-original="1"] body > *:not(.pth-root){display:none !important}
    `);

    const root = el("div", { class: "pth-root" });
    const wrap = el("div", { class: "pth-wrap" });
    root.appendChild(wrap);

    const title = el("div", { class: "pth-title", text: "PoE Trade History Enhancer" });
    const header = el("div", { class: "pth-muted", text: "" });
    const status = el("div", { class: "pth-muted", text: "" });

    const refreshBtn = el("button", { class: "pth-btn", text: "Refresh" });
    const markAllSeenBtn = el("button", { class: "pth-btn", text: "Mark all seen" });

    const onlyNewToggle = el("input", { type: "checkbox" });
    const onlyNewLabel = el("label", { class: "pth-badge" }, [onlyNewToggle, el("span", { text: " Only new" })]);

    const hideOriginalToggle = el("input", { type: "checkbox" });
    const hideOriginalLabel = el("label", { class: "pth-badge" }, [hideOriginalToggle, el("span", { text: " Hide original page" })]);

    const preferredCurrencyInput = el("input", { class: "pth-input", value: "chaos", placeholder: "chaos" });
    preferredCurrencyInput.style.width = "90px";
    const preferredCurrencyLabel = el("label", { class: "pth-badge" }, [
      el("span", { text: " Best/worst in " }),
      preferredCurrencyInput,
    ]);

    const divineChaosPriceInput = el("input", { class: "pth-input", value: "", placeholder: "153" });
    divineChaosPriceInput.style.width = "70px";
    const divineChaosPriceLabel = el("label", { class: "pth-badge" }, [
      el("span", { text: " 1 div = " }),
      divineChaosPriceInput,
      el("span", { text: " chaos" }),
    ]);

    const filterInput = el("input", { class: "pth-input", placeholder: "Filter (name/mod/note)…" });
    filterInput.style.flex = "1 1 260px";

    const topRow = el("div", { class: "pth-row" }, [
      title,
      header,
      refreshBtn,
      markAllSeenBtn,
      onlyNewLabel,
      hideOriginalLabel,
      preferredCurrencyLabel,
      divineChaosPriceLabel,
    ]);

    const secondRow = el("div", { class: "pth-row" }, [filterInput, status]);
    wrap.appendChild(topRow);
    wrap.appendChild(secondRow);

    const statsWrap = el("div", { class: "pth-stats" });
    wrap.appendChild(statsWrap);

    const tableWrap = el("div");
    wrap.appendChild(tableWrap);

    const toastEl = el("div", { class: "pth-toast", text: "" });
    document.documentElement.appendChild(toastEl);

    /** @type {null | ((next: any) => void)} */
    let onSettingsChange = null;
    /** @type {null | (() => void)} */
    let onRefresh = null;
    /** @type {null | (() => void)} */
    let onMarkAllSeen = null;

    refreshBtn.addEventListener("click", () => onRefresh?.());
    markAllSeenBtn.addEventListener("click", () => onMarkAllSeen?.());
    onlyNewToggle.addEventListener("change", () => {
      onSettingsChange?.({ onlyNew: onlyNewToggle.checked });
    });
    hideOriginalToggle.addEventListener("change", () => {
      onSettingsChange?.({ hideOriginal: hideOriginalToggle.checked });
    });
    preferredCurrencyInput.addEventListener("change", () => {
      onSettingsChange?.({ preferredCurrency: normalizeCurrency(preferredCurrencyInput.value) || "chaos" });
    });
    divineChaosPriceInput.addEventListener("change", () => {
      const v = toPositiveNumberOrNull(divineChaosPriceInput.value);
      divineChaosPriceInput.value = v == null ? "" : String(v);
      onSettingsChange?.({ divineChaosPrice: v });
    });

    filterInput.addEventListener("input", () => {
      const q = (filterInput.value || "").trim().toLowerCase();
      const rows = Array.from(tableWrap.querySelectorAll("tbody tr"));
      for (const tr of rows) {
        const hay = (tr.getAttribute("data-hay") || "").toLowerCase();
        tr.style.display = !q || hay.includes(q) ? "" : "none";
      }
    });

    return {
      root,
      setHeader({ league, count, newCount, archivedCount, lastUpdated }) {
        const dt = new Date(lastUpdated).toLocaleTimeString();
        const newPart = newCount ? ` • ${newCount} new` : "";
        const archivePart = Number.isFinite(archivedCount) ? ` • Archived: ${archivedCount}` : "";
        header.textContent = `League: ${league} • Showing: ${count}${newPart}${archivePart} • Updated: ${dt}`;
      },
      setStatus(text) {
        status.textContent = text;
      },
      updateSettings(next) {
        onlyNewToggle.checked = !!next.onlyNew;
        hideOriginalToggle.checked = !!next.hideOriginal;
        preferredCurrencyInput.value = next.preferredCurrency || "chaos";
        divineChaosPriceInput.value = next.divineChaosPrice == null ? "" : String(next.divineChaosPrice);
      },
      onSettingsChange(fn) {
        onSettingsChange = fn;
      },
      onRefresh(fn) {
        onRefresh = fn;
      },
      onMarkAllSeen(fn) {
        onMarkAllSeen = fn;
      },
      toast(message) {
        toastEl.textContent = message;
        toastEl.classList.add("pth-show");
        setTimeout(() => toastEl.classList.remove("pth-show"), 900);
      },
      /**
       * @param {ReturnType<typeof computeIncomeStats>} stats
       */
        renderStats(stats) {
          statsWrap.innerHTML = "";

        const totalsCard = el("div", { class: "pth-card" });
        totalsCard.appendChild(el("div", { class: "pth-card-title", text: "Income totals" }));
        totalsCard.appendChild(
          el("div", { class: "pth-muted", text: `${stats.trades} sold` }),
        );
        if (stats.totalPreferredText) {
          totalsCard.appendChild(el("div", { text: stats.totalPreferredText }));
          if (stats.totalText) totalsCard.appendChild(el("div", { class: "pth-muted", text: stats.totalText }));
        } else {
          totalsCard.appendChild(el("div", { text: stats.totalText || "—" }));
        }
        statsWrap.appendChild(totalsCard);

        const bestWorstCard = el("div", { class: "pth-card" });
        bestWorstCard.appendChild(el("div", { class: "pth-card-title", text: `Best / worst day (${stats.preferredCurrency})` }));
        bestWorstCard.appendChild(el("div", { html: stats.bestWorstHtml }));
          statsWrap.appendChild(bestWorstCard);

          statsWrap.appendChild(
            renderStatsTableCard("Income per item category", ["Category", "Sold", "Income"], stats.byCategory),
          );
          statsWrap.appendChild(renderStatsTableCard("Income per base type", ["Base type", "Sold", "Income"], stats.byBaseType));
          statsWrap.appendChild(renderStatsTableCard("Income per rarity", ["Rarity", "Sold", "Income"], stats.byRarity));
          statsWrap.appendChild(renderStatsTableCard("Income per day", ["Day", "Sold", "Income"], stats.byDay));
          statsWrap.appendChild(renderStatsTableCard("Income per week", ["Week", "Sold", "Income"], stats.byWeek));
        },
      /**
       * @param {Array<any>} rows
       * @param {{isNew: (itemId: string) => boolean, onCopyItemText: (text: string) => void, onMarkSeen: (itemId: string) => void}} handlers
       */
      renderTable(rows, handlers) {
        tableWrap.innerHTML = "";

        const table = el("table", { class: "pth-table" });
        const thead = el("thead");
        const tbody = el("tbody");
        table.appendChild(thead);
        table.appendChild(tbody);

        thead.appendChild(
          el("tr", {}, [
            el("th", { text: "Time" }),
            el("th", { text: "Item" }),
            el("th", { text: "iLvl" }),
            el("th", { text: "Price" }),
            el("th", { text: "Note" }),
            el("th", { text: "Mods" }),
            el("th", { text: "Actions" }),
          ]),
        );

          for (const r of rows) {
            const isNew = handlers.isNew(r.itemId);
            const hay = [r.name, r.baseType, r.rarity, r.category, r.note, r.priceText, ...(r.mods || [])].join(" • ");

          const tr = el("tr", { class: isNew ? "pth-new" : "", attr: { "data-hay": hay } });

          const timeCell = el("td", {}, [
            el("div", { text: r.timeAgo || "" }),
            el("div", { class: "pth-muted", text: r.timeLocal || r.timeIso }),
          ]);

          const itemCell = el("td");
          const itemRow = el("div", { class: "pth-row" });
            if (r.icon) itemRow.appendChild(el("img", { class: "pth-icon", src: r.icon, alt: "" }));
            const itemText = el("div");
            const itemName = el("div", { text: r.name });
            const nameColor = rarityColor(r.rarity);
            if (nameColor) itemName.style.color = nameColor;
            itemText.appendChild(itemName);
            const sub = [r.rarity, r.category, r.baseType].filter(Boolean).join(" • ");
            if (sub) itemText.appendChild(el("div", { class: "pth-muted", text: sub }));
            itemRow.appendChild(itemText);
            itemCell.appendChild(itemRow);

          const ilvlCell = el("td", { text: r.ilvl != null ? String(r.ilvl) : "" });
          const priceCell = el("td", { text: r.priceText || "" });
          const noteCell = el("td", { text: r.note || "" });

          const modsCell = el("td", { class: "pth-mods" });
          if (Array.isArray(r.mods) && r.mods.length) {
            const fracturedSet = new Set(Array.isArray(r.fracturedMods) ? r.fracturedMods : []);
            for (const m of r.mods.slice(0, 16)) {
              const modClass = fracturedSet.has(m) ? "pth-mod pth-mod-fractured" : "pth-mod";
              modsCell.appendChild(el("span", { class: modClass, text: m }));
            }
            if (r.mods.length > 16) modsCell.appendChild(el("span", { class: "pth-muted", text: `+${r.mods.length - 16} more…` }));
          }

          const actionsCell = el("td");
          const seenBtn = el("button", { class: "pth-btn", text: isNew ? "Mark seen" : "Seen" });
          seenBtn.disabled = !isNew;
          seenBtn.addEventListener("click", () => handlers.onMarkSeen(r.itemId));

          const copyBtn = el("button", { class: "pth-btn", text: r.itemText ? "Copy item text" : "No item text" });
          copyBtn.disabled = !r.itemText;
          copyBtn.addEventListener("click", () => {
            if (!r.itemText) return;
            handlers.onCopyItemText(r.itemText);
          });

          const actionRow = el("div", { class: "pth-row" }, [seenBtn, copyBtn]);
          actionsCell.appendChild(actionRow);

          tr.appendChild(timeCell);
          tr.appendChild(itemCell);
          tr.appendChild(ilvlCell);
          tr.appendChild(priceCell);
          tr.appendChild(noteCell);
          tr.appendChild(modsCell);
          tr.appendChild(actionsCell);

          tbody.appendChild(tr);
        }

        tableWrap.appendChild(table);
      },
    };
  }

  function renderStatsTableCard(title, headerCells, rows) {
    const card = el("div", { class: "pth-card" });
    card.appendChild(el("div", { class: "pth-card-title", text: title }));

    const table = el("table", { class: "pth-mini" });
    const thead = el("thead");
    const tbody = el("tbody");
    table.appendChild(thead);
    table.appendChild(tbody);
    thead.appendChild(el("tr", {}, headerCells.map((h) => el("th", { text: h }))));

    for (const r of rows) {
      const countText = r.countText != null ? String(r.countText) : String(r.count);
      tbody.appendChild(el("tr", {}, [el("td", { text: r.label }), el("td", { text: countText }), el("td", { text: r.incomeText || "—" })]));
    }

    if (!rows.length) tbody.appendChild(el("tr", {}, [el("td", { class: "pth-muted", text: "No data", attr: { colspan: "3" } })]));

    card.appendChild(table);
    return card;
  }

    function computeIncomeStats(rows, { preferredCurrency, divineChaosPrice } = {}) {
      const preferred = normalizeCurrency(preferredCurrency) || "chaos";
      const divineChaos = toPositiveNumberOrNull(divineChaosPrice);

      /** @type {Map<string, number>} */
      const totalByCurrency = new Map();
      /** @type {Map<string, {count: number, byCurrency: Map<string, number>}>} */
      const byCategory = new Map();
      /** @type {Map<string, {count: number, byCurrency: Map<string, number>}>} */
      const byBaseType = new Map();
      /** @type {Map<string, {count: number, byCurrency: Map<string, number>}>} */
      const byRarity = new Map();
      /** @type {Map<string, {count: number, byCurrency: Map<string, number>}>} */
      const byDay = new Map();
      /** @type {Map<string, {count: number, byCurrency: Map<string, number>}>} */
      const byWeek = new Map();

      const soldRows = Array.isArray(rows)
        ? rows.filter((r) => {
            const t = r?.timeMs;
            if (!Number.isFinite(t)) return false;
            const amountOk = typeof r?.priceAmount === "number" && Number.isFinite(r.priceAmount);
            const currencyOk = !!normalizeCurrency(r?.priceCurrency || "");
            return amountOk && currencyOk;
          })
        : [];

      for (const r of soldRows) {
        const t = r.timeMs;

        const dayKey = localDayKey(t);
        const weekKey = `Week of ${localWeekStartKey(t)}`;
        const categoryKey = (r?.category || "").trim() || "Other";
        const baseTypeKey = (() => {
          const k = (r?.baseType || "").trim() || (r?.name || "").trim() || "Other";
          return k === "(unknown)" ? "Other" : k;
        })();
        const rarityKey = (r?.rarity || "").trim() || "Other";

        bumpCountOnly(byDay, dayKey);
        bumpCountOnly(byWeek, weekKey);
        bumpCountOnly(byCategory, categoryKey);
        bumpCountOnly(byBaseType, baseTypeKey);
        bumpCountOnly(byRarity, rarityKey);

        bumpBucket(totalByCurrency, r.priceCurrency, r.priceAmount);
        bumpGroupBucket(byDay, dayKey, r.priceCurrency, r.priceAmount);
        bumpGroupBucket(byWeek, weekKey, r.priceCurrency, r.priceAmount);
        bumpGroupBucket(byCategory, categoryKey, r.priceCurrency, r.priceAmount);
        bumpGroupBucket(byBaseType, baseTypeKey, r.priceCurrency, r.priceAmount);
        bumpGroupBucket(byRarity, rarityKey, r.priceCurrency, r.priceAmount);
      }

      const byDayRows = toStatRows(byDay, {
        sort: "keyDesc",
        preferredCurrency: preferred,
        divineChaosPrice: divineChaos,
        limit: 14,
      });
      const byWeekRows = toStatRows(byWeek, {
        sort: "keyDesc",
        preferredCurrency: preferred,
        divineChaosPrice: divineChaos,
        limit: 12,
      });
      const byCategoryRows = toStatRows(byCategory, {
        preferredCurrency: preferred,
        divineChaosPrice: divineChaos,
        limit: 12,
      });
      const byBaseTypeRows = toStatRows(byBaseType, {
        preferredCurrency: preferred,
        divineChaosPrice: divineChaos,
        limit: 12,
      });
      const byRarityRows = toStatRows(byRarity, {
        preferredCurrency: preferred,
        divineChaosPrice: divineChaos,
        limit: 12,
      });

    const bestWorst = computeBestWorstDay(byDay, preferred, divineChaos);

    const totalPreferredAmount = tryConvertChaosDivineOnly(totalByCurrency, preferred, divineChaos);

    return {
      preferredCurrency: preferred,
      divineChaosPrice: divineChaos,
      trades: soldRows.length,
      totalText: formatCurrencyMap(totalByCurrency),
      totalPreferredText:
        totalPreferredAmount == null ? null : `${formatAmount(totalPreferredAmount)} ${preferred}`,
      bestWorstHtml: bestWorst.html,
        byDay: byDayRows,
        byWeek: byWeekRows,
        byCategory: byCategoryRows,
        byBaseType: byBaseTypeRows,
        byRarity: byRarityRows,
      };
    }

  function bumpCountOnly(groupMap, key) {
    let g = groupMap.get(key);
    if (!g) {
      g = { count: 0, byCurrency: new Map() };
      groupMap.set(key, g);
    }
    g.count += 1;
  }

  function bumpGroupBucket(groupMap, key, currency, amount) {
    const g = groupMap.get(key);
    if (!g) return;
    bumpBucket(g.byCurrency, currency, amount);
  }

  function bumpBucket(currencyMap, currency, amount) {
    const k = normalizeCurrency(currency);
    if (!k) return;
    const prev = currencyMap.get(k) || 0;
    currencyMap.set(k, prev + amount);
  }

  function toStatRows(
    groupMap,
    { sort = "preferredThenCount", preferredCurrency = "chaos", divineChaosPrice = null, limit = 999 } = {},
  ) {
    const rows = [];
    for (const [label, g] of groupMap.entries()) {
      const totalCount = typeof g.count === "number" ? g.count : 0;

      rows.push({
        label,
        count: totalCount,
        countText: String(totalCount),
        preferredAmount: preferredAmountForGroup(g.byCurrency, preferredCurrency, divineChaosPrice),
        incomeText: formatCurrencyMapForPreferred(g.byCurrency, preferredCurrency, divineChaosPrice),
      });
    }

    if (sort === "keyDesc") {
      rows.sort((a, b) => String(b.label).localeCompare(String(a.label)));
    } else {
      rows.sort((a, b) => {
        if (b.preferredAmount !== a.preferredAmount) return b.preferredAmount - a.preferredAmount;
        if (b.count !== a.count) return b.count - a.count;
        return String(a.label).localeCompare(String(b.label));
      });
    }

    return rows.slice(0, limit);
  }

  function computeBestWorstDay(byDay, preferredCurrency, divineChaosPrice) {
    let best = null;
    let worst = null;

    for (const [dayKey, g] of byDay.entries()) {
      const pref = preferredAmountForGroup(g.byCurrency, preferredCurrency, divineChaosPrice);
      const row = {
        dayKey,
        count: g.count,
        preferredAmount: pref,
        incomeText: formatCurrencyMapForPreferred(g.byCurrency, preferredCurrency, divineChaosPrice),
      };
      if (!best || row.preferredAmount > best.preferredAmount) best = row;
      if (!worst || row.preferredAmount < worst.preferredAmount) worst = row;
    }

    const bestText = best
      ? `${best.dayKey}: ${formatAmount(best.preferredAmount)} ${preferredCurrency} • ${best.count} sold • ${best.incomeText || "—"}`
      : "—";
    const worstText = worst
      ? `${worst.dayKey}: ${formatAmount(worst.preferredAmount)} ${preferredCurrency} • ${worst.count} sold • ${worst.incomeText || "—"}`
      : "—";

    const html = [
      `<div><span class="pth-muted">Best:</span> ${escapeHtml(bestText)}</div>`,
      `<div><span class="pth-muted">Worst:</span> ${escapeHtml(worstText)}</div>`,
      `<div class="pth-muted" style="margin-top:6px">Tip: set “1 div = … chaos” to enable chaos/divine conversion for these comparisons.</div>`,
    ].join("");

    return { best, worst, html };
  }

  function localDayKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function localWeekStartKey(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    const dow = d.getDay(); // 0..6 (Sun..Sat)
    const daysSinceMonday = (dow + 6) % 7;
    d.setDate(d.getDate() - daysSinceMonday);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function formatCurrencyMap(currencyMap) {
    const entries = Array.from(currencyMap.entries()).filter(([, v]) => Number.isFinite(v) && v !== 0);
    if (!entries.length) return "";
    entries.sort((a, b) => b[1] - a[1]);
    return entries.map(([c, v]) => `${formatAmount(v)} ${c}`).join(" + ");
  }

  function toPositiveNumberOrNull(value) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    if (typeof value === "string") {
      const s = value.trim();
      if (!s) return null;
      const n = Number(s);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    return null;
  }

  function tryConvertChaosDivineOnly(currencyMap, preferredCurrency, divineChaosPrice) {
    const price = toPositiveNumberOrNull(divineChaosPrice);
    const preferred = normalizeCurrency(preferredCurrency);
    if (!price) return null;
    if (preferred !== "chaos" && preferred !== "divine") return null;

    const entries = Array.from(currencyMap.entries()).filter(([, v]) => Number.isFinite(v) && v !== 0);
    if (!entries.length) return 0;
    for (const [k] of entries) {
      const c = normalizeCurrency(k);
      if (c !== "chaos" && c !== "divine") return null;
    }

    const chaos = currencyMap.get("chaos") || 0;
    const divine = currencyMap.get("divine") || 0;
    if (preferred === "chaos") return chaos + divine * price;
    return divine + chaos / price;
  }

  function preferredAmountForGroup(currencyMap, preferredCurrency, divineChaosPrice) {
    const preferred = normalizeCurrency(preferredCurrency);
    const converted = tryConvertChaosDivineOnly(currencyMap, preferred, divineChaosPrice);
    if (converted != null) return converted;
    return currencyMap.get(preferred) || 0;
  }

  function formatCurrencyMapForPreferred(currencyMap, preferredCurrency, divineChaosPrice) {
    const preferred = normalizeCurrency(preferredCurrency);
    const converted = tryConvertChaosDivineOnly(currencyMap, preferred, divineChaosPrice);
    if (converted == null) return formatCurrencyMap(currencyMap);
    return `${formatAmount(converted)} ${preferred}`;
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function el(tag, props = {}, children = null) {
    const node = document.createElement(tag);
    if (props.class) node.className = props.class;
    if (props.text != null) node.textContent = props.text;
    if (props.html != null) node.innerHTML = props.html;
    if (props.type) node.setAttribute("type", props.type);
    if (props.placeholder) node.setAttribute("placeholder", props.placeholder);
    if (props.min != null) node.setAttribute("min", String(props.min));
    if (props.max != null) node.setAttribute("max", String(props.max));
    if (props.value != null) node.value = String(props.value);
    if (props.src) node.setAttribute("src", props.src);
    if (props.alt != null) node.setAttribute("alt", props.alt);
    if (props.attr) {
      for (const [k, v] of Object.entries(props.attr)) node.setAttribute(k, String(v));
    }
    if (Array.isArray(children)) {
      for (const c of children) node.appendChild(c);
    }
    return node;
  }
})();
