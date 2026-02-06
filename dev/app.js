/* global fetch */

const el = (tag, props = {}, children = null) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "class") node.className = v;
    else node.setAttribute(k, String(v));
  }
  if (Array.isArray(children)) for (const c of children) node.appendChild(c);
  return node;
};

const $preferred = document.getElementById("preferred");
const $filter = document.getElementById("filter");
const $reload = document.getElementById("reload");
const $status = document.getElementById("status");
const $stats = document.getElementById("stats");
const $tbody = document.getElementById("tbody");

let lastData = null;

function setStatus(text) {
  $status.textContent = text;
}

function toHay(r) {
  const mods = Array.isArray(r.mods) ? r.mods.join(" ") : "";
  return [r.name, r.baseType, r.category, r.rarity, r.priceText, r.note, mods].filter(Boolean).join(" • ").toLowerCase();
}

function applyFilter() {
  const q = ($filter.value || "").trim().toLowerCase();
  const rows = Array.from($tbody.querySelectorAll("tr"));
  for (const tr of rows) {
    const hay = (tr.getAttribute("data-hay") || "").toLowerCase();
    tr.style.display = !q || hay.includes(q) ? "" : "none";
  }
}

function renderStats(stats) {
  $stats.innerHTML = "";

  const totalsCard = el("section", { class: "card" }, [
    el("div", { class: "cardTitle", text: "Income totals" }),
    el("div", { class: "muted", text: `${stats.trades} sold` }),
    el("div", { text: stats.totalText || "—" }),
  ]);
  $stats.appendChild(totalsCard);

  const bestWorstCard = el("section", { class: "card" }, [
    el("div", { class: "cardTitle", text: `Best / worst day (${stats.preferredCurrency})` }),
    el("div", { html: stats.bestWorstHtml }),
  ]);
  $stats.appendChild(bestWorstCard);

  const tables = [
    ["Income per item category", stats.byCategory],
    ["Income per base type", stats.byBaseType],
    ["Income per rarity", stats.byRarity],
    ["Income per day", stats.byDay],
    ["Income per week", stats.byWeek],
  ];

  for (const [title, rows] of tables) {
    const card = el("section", { class: "card" }, [el("div", { class: "cardTitle", text: title })]);
    const table = el("table", { class: "table small" });
    const thead = el("thead");
    const tbody = el("tbody");
    thead.appendChild(el("tr", {}, [el("th", { text: "Label" }), el("th", { text: "Sold" }), el("th", { text: "Income" })]));
    table.appendChild(thead);
    for (const r of rows || []) {
      tbody.appendChild(el("tr", {}, [el("td", { text: r.label }), el("td", { text: r.countText }), el("td", { text: r.incomeText || "—" })]));
    }
    if (!rows?.length) tbody.appendChild(el("tr", {}, [el("td", { class: "muted", text: "No data", colspan: "3" })]));
    table.appendChild(tbody);
    card.appendChild(table);
    $stats.appendChild(card);
  }
}

function renderRows(rows) {
  $tbody.innerHTML = "";

  for (const r of rows) {
    const timeCell = el("td", {}, [
      el("div", { text: r.timeAgo || "" }),
      el("div", { class: "muted", text: r.timeLocal || r.timeIso || "" }),
    ]);

    const sub = [r.rarity, r.category, r.baseType].filter(Boolean).join(" • ");
    const itemCell = el("td", {}, [
      el("div", { text: r.name || "(unknown)" }),
      sub ? el("div", { class: "muted", text: sub }) : el("span"),
    ]);

    const ilvlCell = el("td", { text: r.ilvl != null ? String(r.ilvl) : "" });
    const priceCell = el("td", { text: r.priceText || "" });
    const noteCell = el("td", { text: r.note || "" });

    const modsCell = el("td", { class: "mods" });
    if (Array.isArray(r.mods) && r.mods.length) {
      for (const m of r.mods.slice(0, 16)) modsCell.appendChild(el("span", { class: "mod", text: m }));
      if (r.mods.length > 16) modsCell.appendChild(el("span", { class: "muted", text: `+${r.mods.length - 16} more…` }));
    }

    const itemTextCell = el("td");
    if (r.itemText) {
      const d = el("details");
      d.appendChild(el("summary", { text: "Show" }));
      d.appendChild(el("pre", { text: r.itemText }));
      itemTextCell.appendChild(d);
    } else {
      itemTextCell.appendChild(el("span", { class: "muted", text: "—" }));
    }

    const tr = el("tr");
    tr.setAttribute("data-hay", toHay(r));
    tr.appendChild(timeCell);
    tr.appendChild(itemCell);
    tr.appendChild(ilvlCell);
    tr.appendChild(priceCell);
    tr.appendChild(noteCell);
    tr.appendChild(modsCell);
    tr.appendChild(itemTextCell);
    $tbody.appendChild(tr);
  }

  applyFilter();
}

function renderPreferredOptions(available, selected) {
  $preferred.innerHTML = "";
  for (const c of available) {
    const opt = el("option", { value: c, text: c });
    if (c === selected) opt.selected = true;
    $preferred.appendChild(opt);
  }
}

async function load(preferred) {
  setStatus("Loading fixture…");
  const qs = new URLSearchParams();
  if (preferred) qs.set("preferred", preferred);
  const res = await fetch(`/data.json?${qs.toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = await res.json();
  lastData = data;

  renderPreferredOptions(data.availableCurrencies || [], data.preferredCurrency);
  renderStats(data.stats);
  renderRows(data.rows);
  setStatus(`Loaded ${data.rows?.length || 0} sold`);
}

$filter.addEventListener("input", () => applyFilter());
$preferred.addEventListener("change", () => load($preferred.value));
$reload.addEventListener("click", () => load($preferred.value));

load(null).catch((err) => setStatus(`Error: ${String(err?.message || err)}`));
