/* Grimoire renderer — installed list, browse/search, detail drawer, wago ad. */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  packages: [],
  updates: {},        // key -> update info from providers
  clientInterface: null, // { num, version, label } for the installed client, from the last check
  search: "",
  status: "all",      // all | updates
  provider: "all",
  category: "all",
  sortBy: "name",
  sortDir: 1,
  settings: null,
  tab: "installed",
  checking: false,
  wagoConnected: false,
  categories: [],     // CurseForge category list [{id,name}]
  flavors: [],
  browseResults: [],
  browseShown: 30,
  browseQuery: { query: "", categoryId: undefined, categoryName: undefined },
  browseCursor: null,
  browseHasMore: false,
  browseTotal: 0,
  matching: false,
};

const PROVIDER_LABEL = {
  curseforge: "CurseForge",
  wago: "Wago",
  wowinterface: "WoWInterface",
  tukui: "Tukui",
  multi: "Multiple",
  unknown: "Unmanaged",
};
const PROVIDER_DOT = {
  curseforge: "dot-cf",
  wago: "dot-wago",
  wowinterface: "dot-wowi",
  tukui: "dot-tukui",
  multi: "dot-both",
  unknown: "dot-unk",
};
const PKG_ID_FIELD = {
  curseforge: "curseId",
  wago: "wagoId",
  wowinterface: "wowiId",
  tukui: "tukuiId",
};

// ---------------------------------------------------------------- helpers

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

function setStatus(left, right) {
  if (left !== undefined) $("#status-left").textContent = left;
  if (right !== undefined) $("#status-right").textContent = right;
}

function initials(name) {
  const words = String(name || "?").replace(/[^\w\s]/g, "").split(/\s+/).filter(Boolean);
  return (words.length >= 2 ? words[0][0] + words[1][0] : String(name).slice(0, 2)).toUpperCase();
}

function daysAgo(dateStr) {
  const t = Date.parse(dateStr || "");
  return isNaN(t) ? null : Math.floor((Date.now() - t) / 86400e3);
}

function monthsLabel(days) {
  if (days === null || days === undefined) return "a while";
  if (days < 45) return `${days} days`;
  const months = Math.round(days / 30);
  if (months < 18) return `${months} months`;
  const years = (days / 365).toFixed(1).replace(/\.0$/, "");
  return `${years} years`;
}

function formatDownloads(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "k";
  return String(n);
}

function normName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function updateFor(pkg) {
  const u = state.updates[pkg.key];
  return u && !u.error && !u.needsWagoToken && !u.needsCurseKey ? u : null;
}

function hasUpdate(pkg) {
  const u = updateFor(pkg);
  return !!(u && !u.upToDate);
}

// Provider-health problems: delisted, abandoned, or much fresher elsewhere.
function needsAttention(pkg) {
  const u = state.updates[pkg.key];
  return !!(
    u &&
    (u.removed || u.wasRemovedFrom || u.betterElsewhere || u.staleEverywhere || u.localInterfaceOutOfDate || u.brokenEverywhere)
  );
}

// Which provider will actually serve this addon: explicit pin > install
// source > first available.
function chosenProvider(pkg) {
  const c = (state.settings.providerChoice || {})[pkg.key];
  if (c && (pkg.sources || []).includes(c)) return c;
  if (pkg.installedVia && (pkg.sources || []).includes(pkg.installedVia)) return pkg.installedVia;
  return (pkg.sources || [])[0] || "unknown";
}

function flavorChips(flavors) {
  const wrap = document.createElement("span");
  wrap.className = "flavor-chips";
  for (const f of flavors || []) {
    const chip = document.createElement("span");
    chip.className = "flavor-chip" + (f === "Retail" ? " retail" : "");
    chip.textContent = f;
    wrap.appendChild(chip);
  }
  return wrap;
}

function iconEl(name, logoUrl, extraClass = "") {
  const icon = document.createElement("div");
  icon.className = "addon-icon " + extraClass;
  if (logoUrl) {
    const img = document.createElement("img");
    img.src = logoUrl;
    img.alt = "";
    img.onerror = () => { img.remove(); icon.textContent = initials(name); };
    icon.appendChild(img);
  } else {
    icon.textContent = initials(name);
  }
  return icon;
}

// ---------------------------------------------------------------- installed: filtering

function visiblePackages() {
  const q = state.search.toLowerCase();
  let list = state.packages.filter((p) => {
    if (q && !(
      p.name.toLowerCase().includes(q) ||
      p.author.toLowerCase().includes(q) ||
      p.notes.toLowerCase().includes(q) ||
      p.folders.some((f) => f.toLowerCase().includes(q))
    )) return false;
    if (state.status === "updates" && !hasUpdate(p)) return false;
    if (state.status === "attention" && !needsAttention(p)) return false;
    if (state.provider !== "all") {
      const src = p.sources || [];
      if (state.provider === "multi") { if (src.length < 2) return false; }
      else if (state.provider === "unknown") { if (src.length) return false; }
      else if (!src.includes(state.provider)) return false;
    }
    if (state.category !== "all" && (p.category || "Uncategorized") !== state.category) return false;
    return true;
  });

  const dir = state.sortDir;
  const key = state.sortBy;
  list.sort((a, b) => {
    if (key === "gamever") {
      const diff = ((a.gameVersion || {}).num || 0) - ((b.gameVersion || {}).num || 0);
      return diff * dir || a.name.localeCompare(b.name);
    }
    const av = (key === "provider" ? PROVIDER_LABEL[chosenProvider(a)] : a[key]) || "";
    const bv = (key === "provider" ? PROVIDER_LABEL[chosenProvider(b)] : b[key]) || "";
    return av.localeCompare(bv) * dir || a.name.localeCompare(b.name);
  });
  return list;
}

// ---------------------------------------------------------------- installed: render

function renderCategories() {
  const counts = {};
  for (const p of state.packages) {
    const c = p.category || "Uncategorized";
    counts[c] = (counts[c] || 0) + 1;
  }
  const cats = Object.keys(counts).sort();
  const nav = $("#filter-category");
  nav.innerHTML = "";
  const mk = (label, value, count) => {
    const b = document.createElement("button");
    b.className = "side-item" + (state.category === value ? " active" : "");
    b.dataset.category = value;
    const countEl = document.createElement("span");
    countEl.className = "count";
    countEl.textContent = count ?? "";
    b.append(document.createTextNode(`${label} `), countEl);
    b.addEventListener("click", () => {
      state.category = value;
      render();
    });
    nav.appendChild(b);
  };
  mk("All categories", "all", state.packages.length);
  for (const c of cats) mk(c, c, counts[c]);
}

function renderList() {
  const list = visiblePackages();
  const container = $("#addon-list");
  container.innerHTML = "";

  $("#count-all").textContent = state.packages.length;
  const updateCount = state.packages.filter(hasUpdate).length;
  $("#count-updates").textContent = updateCount || "";
  const attentionCount = state.packages.filter(needsAttention).length;
  $("#count-attention").textContent = attentionCount || "";

  $("#empty-state").classList.toggle("hidden", list.length > 0);
  if (!list.length) {
    $("#empty-text").textContent = state.packages.length
      ? "Nothing matches those filters."
      : "No addons found — check the WoW folder in Settings.";
  }

  for (const pkg of list) {
    const u = updateFor(pkg);
    const raw = state.updates[pkg.key];
    const row = document.createElement("div");
    row.className = "addon-row" + (hasUpdate(pkg) ? " has-update" : "");

    // --- main block
    const main = document.createElement("div");
    main.className = "addon-main";
    const icon = iconEl(pkg.name, u && u.logoUrl);

    const titleblock = document.createElement("div");
    titleblock.className = "addon-titleblock";
    const nameEl = document.createElement("div");
    nameEl.className = "addon-name";
    nameEl.textContent = pkg.name;
    if (pkg.folders.length > 1) {
      const f = document.createElement("span");
      f.className = "folders";
      f.textContent = `${pkg.folders.length} folders`;
      f.title = pkg.folders.join("\n");
      nameEl.appendChild(f);
    }
    const notesEl = document.createElement("div");
    notesEl.className = "addon-notes";
    notesEl.textContent = pkg.notes || (pkg.author ? `by ${pkg.author}` : "");
    titleblock.append(nameEl, notesEl);

    // Surface provider-health warnings right in the row — an addon quietly
    // abandoned on the host you're using is invisible otherwise. Genuine API
    // incompatibility (the game itself will refuse to load it) is the most
    // actionable problem, so it takes priority over softer "unmaintained" signals.
    if (raw && raw.fixedElsewhere) {
      const f = raw.fixedElsewhere;
      const warn = document.createElement("div");
      warn.className = "addon-health hot";
      warn.textContent = `⚠ ${PROVIDER_LABEL[raw.provider]}'s build predates the current retail patch — ${PROVIDER_LABEL[f.provider]} has a compatible ${f.remoteVersion}`;
      titleblock.appendChild(warn);
    } else if (raw && raw.brokenEverywhere) {
      const warn = document.createElement("div");
      warn.className = "addon-health hot";
      warn.textContent = `⚠ no build anywhere yet supports the current retail patch`;
      titleblock.appendChild(warn);
    } else if (raw && raw.localInterfaceOutOfDate) {
      const warn = document.createElement("div");
      warn.className = "addon-health hot";
      warn.textContent = `⚠ built for an older retail patch — won't load unless "Load out of date AddOns" is on`;
      titleblock.appendChild(warn);
    } else {
      const health = raw && (raw.betterElsewhere || raw.staleEverywhere || raw.wasRemovedFrom);
      if (health) {
        const warn = document.createElement("div");
        warn.className = "addon-health";
        if (raw.wasRemovedFrom) {
          warn.classList.add("bad");
          warn.textContent = `⚠ removed from ${PROVIDER_LABEL[raw.wasRemovedFrom]} — now tracking ${PROVIDER_LABEL[raw.provider]}`;
        } else if (raw.betterElsewhere) {
          const b = raw.betterElsewhere;
          warn.classList.add("bad");
          warn.textContent = `⚠ ${PROVIDER_LABEL[raw.provider]} build is ${monthsLabel(raw.buildAgeDays)} old — ${PROVIDER_LABEL[b.provider]} has ${b.remoteVersion} from ${monthsLabel(b.ageDays)} ago`;
        } else {
          warn.textContent = `no new build in ${monthsLabel(raw.buildAgeDays)} — may be unmaintained`;
        }
        titleblock.appendChild(warn);
      }
    }
    main.append(icon, titleblock);

    // --- versions
    const ver = document.createElement("div");
    ver.className = "cell-version";
    ver.textContent = pkg.version || "—";
    ver.title = pkg.version;

    const latest = document.createElement("div");
    latest.className = "cell-latest";
    if (u) {
      latest.textContent = u.remoteVersion || "—";
      latest.title = u.remoteVersion || "";
      latest.classList.add(u.upToDate ? "same" : "newer");
      if (u.remoteOlder) {
        latest.title = `${PROVIDER_LABEL[u.provider] || u.provider} offers ${u.remoteVersion}, older than your installed ${pkg.version} — not offered as an update.`;
      }
    } else if (raw && raw.removed) {
      latest.textContent = "removed ⚠";
      latest.classList.add("warn");
      latest.title = `This addon is no longer listed on ${PROVIDER_LABEL[raw.provider] || raw.provider}. It may have been delisted, renamed, or moved to another host.`;
    } else if (raw && raw.needsCurseKey) {
      latest.textContent = "add CF key";
      latest.title = "This addon updates from CurseForge — add a free API key in Settings (console.curseforge.com) to check it.";
    } else if (raw && raw.needsWagoToken) {
      latest.textContent = "wago connecting…";
      latest.title = "This addon updates from Wago — the ad panel connects automatically, or paste a token in Settings.";
    } else if (raw && raw.error) {
      latest.textContent = "check failed";
      latest.title = raw.error;
    } else {
      latest.textContent = "";
    }

    // --- game version
    const gamever = document.createElement("div");
    gamever.className = "cell-gamever";
    const gv = pkg.gameVersion || {};
    gamever.textContent = gv.label || "—";
    if (raw && raw.localInterfaceOutOfDate) {
      gamever.classList.add("outdated");
      gamever.title = `Built for ${gv.label} — the installed client is on ${(state.clientInterface || {}).label || "a newer patch"}. Will not load unless "Load out of date AddOns" is on.`;
    } else {
      gamever.title = gv.label ? `Built for game version ${gv.label}` : "No Interface version in the addon's files";
    }

    // --- provider badge / chooser
    const prov = document.createElement("div");
    prov.className = "cell-provider";
    const sources = pkg.sources || [];
    if (sources.length > 1) {
      const sel = document.createElement("select");
      sel.className = "provider-select";
      for (const val of sources) {
        const opt = document.createElement("option");
        opt.value = val;
        opt.textContent = PROVIDER_LABEL[val] + (pkg.installedVia === val ? " ✓" : "");
        sel.appendChild(opt);
      }
      sel.value = chosenProvider(pkg);
      sel.title =
        `Available from: ${sources.map((s) => PROVIDER_LABEL[s]).join(", ")}.` +
        (pkg.installedVia ? ` Installed via ${PROVIDER_LABEL[pkg.installedVia]}.` : "") +
        " Pick which provider Grimoire uses for this addon.";
      sel.addEventListener("click", (e) => e.stopPropagation());
      sel.addEventListener("change", (e) => {
        e.stopPropagation();
        onProviderSwitch(pkg, sel.value, sel);
      });
      prov.appendChild(sel);
    } else {
      const shown = pkg.installedVia || pkg.provider;
      const badge = document.createElement("span");
      badge.className = "badge";
      const dot = document.createElement("span");
      dot.className = `dot ${PROVIDER_DOT[shown] || "dot-unk"}`;
      badge.append(dot, document.createTextNode(PROVIDER_LABEL[shown] || shown));
      if (pkg.installedVia) badge.title = `Installed via ${PROVIDER_LABEL[pkg.installedVia]}`;
      prov.appendChild(badge);
    }

    // --- category
    const cat = document.createElement("div");
    cat.className = "cell-category";
    cat.textContent = pkg.category || "";

    // --- action
    const action = document.createElement("div");
    action.className = "cell-action";
    if (u && !u.upToDate) {
      const btn = document.createElement("button");
      btn.className = "btn-update";
      if (u.downloadUrl) {
        btn.textContent = "Update";
        btn.addEventListener("click", (e) => { e.stopPropagation(); installUpdate(pkg, u, btn); });
      } else {
        btn.textContent = "Get ↗";
        btn.title = "This author only allows downloads from the provider's own site — opens the addon page.";
        btn.addEventListener("click", (e) => { e.stopPropagation(); window.grimoire.openExternal(u.pageUrl); });
      }
      action.appendChild(btn);
    } else if (u && u.upToDate) {
      const ok = document.createElement("span");
      ok.className = "uptodate";
      ok.textContent = "✓ current";
      action.appendChild(ok);
    }

    row.append(main, ver, latest, gamever, prov, cat, action);
    row.addEventListener("click", () => openDetailForPackage(pkg));
    container.appendChild(row);
  }
}

// A failure building one row must never blank the whole list — show what can
// be shown and surface the error instead of an empty screen.
function safeRenderList() {
  try {
    renderList();
  } catch (err) {
    console.error("renderList failed", err);
    toast(`Display error: ${err.message || err}`, "error");
    setStatus("Display error — see the addon list for partial results.");
  }
}

function render() {
  $$("#filter-status .side-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.status === state.status));
  $$("#filter-provider .side-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.provider === state.provider));
  $$(".sortable").forEach((b) => {
    const arrow = b.querySelector(".arrow");
    if (arrow) arrow.textContent = b.dataset.sort === state.sortBy ? (state.sortDir > 0 ? "▲" : "▼") : "";
  });
  renderCategories();
  safeRenderList();
}

// ---------------------------------------------------------------- actions

async function scan() {
  setStatus("Scanning AddOns folder…");
  let res;
  try {
    res = await window.grimoire.scanAddons();
  } catch (err) {
    toast(`Scan failed: ${err.message || err}`, "error");
    setStatus("Scan failed.");
    return;
  }
  if (res.error === "noWowPath" || res.error === "badWowPath") {
    state.packages = [];
    if (res.flavors) renderFlavorSwitcher(res.flavors, res.flavor);
    render();
    setStatus("WoW folder not found — set it in Settings.");
    openSettings();
    return;
  }
  if (res.error) {
    toast(`Scan failed: ${res.error}`, "error");
    return;
  }
  if (res.flavors) renderFlavorSwitcher(res.flavors, res.flavor);
  state.packages = res.packages;
  // Removing an addon can retire the category or provider the sidebar filter
  // is pointing at, which would leave the list stuck showing nothing with no
  // way back. Drop filters that no longer match anything.
  const cats = new Set(state.packages.map((p) => p.category || "Uncategorized"));
  if (state.category !== "all" && !cats.has(state.category)) state.category = "all";
  const provs = new Set(state.packages.map((p) => p.provider));
  if (state.provider !== "all" && !provs.has(state.provider)) state.provider = "all";
  render();
  // Install/Installed buttons in Browse reflect what's installed.
  if (state.browseResults.length) renderBrowseResults();
  setStatus(
    `Found ${res.packages.length} addons (${res.scannedFolders} folders) in ${res.tookMs} ms.`,
    state.settings?.wowPath || ""
  );
}

async function checkUpdates() {
  if (state.checking) return;
  state.checking = true;
  $("#btn-check").disabled = true;
  setStatus("Checking providers for updates…");
  try {
    const res = await window.grimoire.checkUpdates(state.packages);
    state.updates = res.perPackage || {};
    state.clientInterface = res.clientInterface || null;
    for (const err of res.errors || []) toast(err, "error");
    // Provider-health summary — easy to miss scrolling a long list.
    const vals = Object.values(state.updates);
    const moved = vals.filter((u) => u.betterElsewhere).length;
    const removed = vals.filter((u) => u.removed || u.wasRemovedFrom).length;
    const stale = vals.filter((u) => u.staleEverywhere).length;
    const incompatible = vals.filter((u) => u.localInterfaceOutOfDate || u.brokenEverywhere).length;
    if (incompatible) {
      toast(
        `${incompatible} addon${incompatible === 1 ? " predates" : "s predate"} the current retail patch (${(state.clientInterface || {}).label || "?"}) and may not load.`,
        "error"
      );
    }
    if (removed) toast(`${removed} addon${removed === 1 ? " is" : "s are"} no longer listed on the provider being used.`, "error");
    if (moved) toast(`${moved} addon${moved === 1 ? " has" : "s have"} a much newer build on another provider — open it to switch.`, "error");
    if (stale) toast(`${stale} addon${stale === 1 ? "" : "s"} had no new build in months — possibly unmaintained.`);

    const n = state.packages.filter(hasUpdate).length;
    setStatus(n ? `${n} update${n === 1 ? "" : "s"} available.` : "Everything checked is up to date.");
    if (n) state.status = "updates";
    render();
    matchProvidersInBackground();
  } catch (err) {
    toast(`Update check failed: ${err.message || err}`, "error");
    setStatus("Update check failed.");
  } finally {
    state.checking = false;
    $("#btn-check").disabled = false;
  }
}

// Quietly discover extra providers for installed addons (Auctionator is on
// CurseForge too, even though its files only mention Wago, etc.).
async function matchProvidersInBackground() {
  if (state.matching) return;
  state.matching = true;
  try {
    const res = await window.grimoire.matchProviders(state.packages);
    const found = Object.keys(res.matched || {});
    if (found.length) {
      state.settings = await window.grimoire.getSettings();
      await scan();
      toast(`Found ${found.length} addon${found.length === 1 ? "" : "s"} on additional providers.`, "ok");
    }
  } catch {
    /* background nicety — never bother the user */
  } finally {
    state.matching = false;
  }
}

async function installUpdate(pkg, u, btn) {
  btn.disabled = true;
  btn.textContent = "Installing…";
  try {
    const res = await window.grimoire.installUpdate({
      key: pkg.key,
      downloadUrl: u.downloadUrl,
      folders: pkg.folders,
      provider: u.provider,
      id: u.id || pkg[PKG_ID_FIELD[u.provider]] || "",
      version: u.remoteVersion,
    });
    toast(`${pkg.name} updated (${res.installedFolders.length} folders). Old version backed up.`, "ok");
    state.updates[pkg.key] = { ...u, upToDate: true };
    await scan();
  } catch (err) {
    toast(`${pkg.name}: ${err.message || err}`, "error");
    btn.disabled = false;
    btn.textContent = "Update";
  }
}

// Provider dropdown changed: pin the choice, and offer an immediate
// reinstall from the new provider so the switch is real, not cosmetic.
async function onProviderSwitch(pkg, provider, sel) {
  state.settings.providerChoice = state.settings.providerChoice || {};
  state.settings.providerChoice[pkg.key] = provider;
  state.settings = await window.grimoire.saveSettings(state.settings);
  delete state.updates[pkg.key];

  const id = pkg[PKG_ID_FIELD[provider]];
  if (pkg.installedVia && provider !== pkg.installedVia && id) {
    const yes = confirm(
      `${pkg.name} is currently installed via ${PROVIDER_LABEL[pkg.installedVia]}.\n\n` +
      `Reinstall it from ${PROVIDER_LABEL[provider]} now? Its ${pkg.folders.length} folder(s) will be replaced ` +
      `with ${PROVIDER_LABEL[provider]}'s version (old files are backed up).`
    );
    if (yes) {
      await reinstallFromProvider(pkg, provider);
      return;
    }
  }
  toast(`${pkg.name} will now update from ${PROVIDER_LABEL[provider]}.`, "ok");
  render();
}

async function reinstallFromProvider(pkg, provider) {
  const id = pkg[PKG_ID_FIELD[provider]];
  setStatus(`Reinstalling ${pkg.name} from ${PROVIDER_LABEL[provider]}…`);
  try {
    const r = await window.grimoire.resolveAddon({ provider, id });
    if (!r || !r.downloadUrl) throw new Error(`no direct download on ${PROVIDER_LABEL[provider]}`);
    const res = await window.grimoire.installUpdate({
      key: pkg.key,
      downloadUrl: r.downloadUrl,
      folders: pkg.folders,
      provider,
      id,
      version: r.remoteVersion,
    });
    toast(`${pkg.name} reinstalled from ${PROVIDER_LABEL[provider]} (${res.installedFolders.length} folders).`, "ok");
    closeDetail();
    await scan();
    setStatus(`${pkg.name} now managed via ${PROVIDER_LABEL[provider]}.`);
  } catch (err) {
    toast(`${pkg.name}: ${err.message || err}`, "error");
    setStatus("Reinstall failed.");
  }
}

async function uninstallPackage(pkg) {
  const yes = confirm(
    `Uninstall ${pkg.name}?\n\nThese folders will be removed from AddOns:\n${pkg.folders.join("\n")}\n\n` +
    `(They are moved to Grimoire's backup folder, not deleted, so this can be undone by hand.)`
  );
  if (!yes) return;
  try {
    const res = await window.grimoire.uninstall({ key: pkg.key, folders: pkg.folders });
    toast(`${pkg.name} uninstalled (${res.removed.length} folders backed up).`, "ok");
    closeDetail();
    await scan();
  } catch (err) {
    toast(`${pkg.name}: ${err.message || err}`, "error");
  }
}

// ---------------------------------------------------------------- detail drawer

function detailKV(k, v) {
  if (!v) return null;
  const el = document.createElement("div");
  el.className = "detail-kv";
  const kEl = document.createElement("div");
  kEl.className = "k";
  kEl.textContent = k;
  const vEl = document.createElement("div");
  vEl.className = "v";
  if (v instanceof Node) vEl.appendChild(v);
  else vEl.textContent = v;
  el.append(kEl, vEl);
  return el;
}

function openDetail({ name, author, summary, logoUrl, kvs, providers, folders, actions }) {
  $("#detail-name").textContent = name;
  $("#detail-author").textContent = author ? `by ${author}` : "";
  $("#detail-summary").textContent = summary || "";
  const iconBox = $("#detail-icon");
  iconBox.innerHTML = "";
  iconBox.appendChild(iconEl(name, logoUrl, "detail-icon").firstChild || document.createTextNode(initials(name)));
  if (!logoUrl) iconBox.textContent = initials(name);

  const grid = $("#detail-grid");
  grid.innerHTML = "";
  for (const [k, v] of kvs) {
    const el = detailKV(k, v);
    if (el) grid.appendChild(el);
  }

  const provBox = $("#detail-providers");
  provBox.innerHTML = "";
  $("#detail-providers-section").classList.toggle("hidden", !providers || !providers.length);
  for (const p of providers || []) provBox.appendChild(p);

  const foldersBox = $("#detail-folders");
  $("#detail-folders-section").classList.toggle("hidden", !folders || !folders.length);
  foldersBox.textContent = (folders || []).join("\n");
  foldersBox.style.whiteSpace = "pre-line";

  const actionsBox = $("#detail-actions");
  actionsBox.innerHTML = "";
  for (const a of actions || []) actionsBox.appendChild(a);

  $("#detail-backdrop").classList.remove("hidden");
}

function closeDetail() {
  $("#detail-backdrop").classList.add("hidden");
}

function linkButton(label, url) {
  const b = document.createElement("button");
  b.className = "btn";
  b.textContent = label;
  b.addEventListener("click", () => window.grimoire.openExternal(url));
  return b;
}

// Per-addon release channel: "Default" follows the global setting, or pin
// this addon to stable/beta/alpha regardless of it.
function channelSelector(pkg) {
  const wrap = document.createElement("div");
  wrap.className = "detail-channel";
  const u = updateFor(pkg);
  const prov = chosenProvider(pkg);
  const pinned = (state.settings.channelChoice || {})[pkg.key] || "";

  // Providers differ: WoWInterface and Tukui have a single release stream, and
  // plenty of CurseForge/Wago authors only ship stable. Offer only what this
  // addon actually publishes on the provider serving it.
  if (prov === "wowinterface" || prov === "tukui") {
    const note = document.createElement("span");
    note.className = "detail-channel-note";
    note.textContent = `${PROVIDER_LABEL[prov]} publishes a single release stream`;
    wrap.appendChild(note);
    return wrap;
  }
  if (!u) {
    const note = document.createElement("span");
    note.className = "detail-channel-note";
    note.textContent = pinned
      ? `pinned to ${pinned} — check for updates to see this addon's channels`
      : "check for updates to see this addon's channels";
    wrap.appendChild(note);
    return wrap;
  }
  const available = u.availableChannels || [];
  const versions = u.channelVersions || {};
  if (available.length <= 1) {
    const note = document.createElement("span");
    note.className = "detail-channel-note";
    note.textContent = `only a ${available[0] || "stable"} build is published`;
    wrap.appendChild(note);
    return wrap;
  }

  const sel = document.createElement("select");
  sel.className = "provider-select";
  const globalLabel = state.settings.releaseChannel || "stable";
  const label = { stable: "Stable", beta: "Beta", alpha: "Alpha" };
  const opts = [["", `Default (${globalLabel})`]];
  for (const c of available) {
    opts.push([c, versions[c] ? `${label[c]} — ${versions[c]}` : label[c]]);
  }
  for (const [val, text] of opts) {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = text;
    sel.appendChild(o);
  }
  // A pin to a channel this addon doesn't publish still shows, so it's not
  // silently lost — it just falls back when resolving.
  if (pinned && !available.includes(pinned)) {
    const o = document.createElement("option");
    o.value = pinned;
    o.textContent = `${label[pinned]} (not published)`;
    sel.appendChild(o);
  }
  sel.value = pinned;
  sel.title = `Available on ${PROVIDER_LABEL[prov]}: ${available.join(", ")}. The newest build in the allowed channels wins.`;
  sel.addEventListener("change", async () => {
    state.settings.channelChoice = state.settings.channelChoice || {};
    if (sel.value) state.settings.channelChoice[pkg.key] = sel.value;
    else delete state.settings.channelChoice[pkg.key];
    state.settings = await window.grimoire.saveSettings(state.settings);
    delete state.updates[pkg.key]; // previous result came from another channel
    toast(
      sel.value
        ? `${pkg.name} pinned to the ${sel.value} channel — re-check for updates.`
        : `${pkg.name} follows the default channel again.`,
      "ok"
    );
    render();
  });
  wrap.appendChild(sel);
  return wrap;
}

function openDetailForPackage(pkg) {
  const u = updateFor(pkg);
  const raw = state.updates[pkg.key];
  const gvLabel = (pkg.gameVersion || {}).label;
  const kvs = [
    ["Installed version", pkg.version || "—"],
    ["Latest version", u ? u.remoteVersion : ""],
    ["Game version", raw && raw.localInterfaceOutOfDate ? `${gvLabel} ⚠ behind current retail` : gvLabel || ""],
    ["Current retail", (state.clientInterface || {}).label || ""],
    ["Category", pkg.category],
    ["Installed via", pkg.installedVia ? PROVIDER_LABEL[pkg.installedVia] : "unknown"],
    ["Downloads", u && u.downloads ? formatDownloads(u.downloads) : ""],
    ["Last build", u && u.fileDate ? `${new Date(u.fileDate).toLocaleDateString()} (${monthsLabel(daysAgo(u.fileDate))} ago)` : ""],
    ["Release channel", channelSelector(pkg)],
  ];

  const provRows = (pkg.sources || []).map((prov) => {
    const row = document.createElement("div");
    row.className = "detail-provider-row";
    const dot = document.createElement("span");
    dot.className = `dot ${PROVIDER_DOT[prov]}`;
    const grow = document.createElement("div");
    grow.className = "grow";
    grow.textContent = PROVIDER_LABEL[prov];
    const sub = document.createElement("div");
    sub.className = "sub";
    const bits = [];
    if (pkg[PKG_ID_FIELD[prov]]) bits.push(`id ${pkg[PKG_ID_FIELD[prov]]}`);
    if (pkg.installedVia === prov) bits.push("installed from here");
    if (chosenProvider(pkg) === prov) bits.push("active");
    sub.textContent = bits.join(" · ");
    grow.appendChild(sub);
    row.append(dot, grow);
    if (pkg[PKG_ID_FIELD[prov]] && pkg.installedVia !== prov) {
      const btn = document.createElement("button");
      btn.className = "btn-update";
      btn.textContent = "Reinstall from here";
      btn.addEventListener("click", () => reinstallFromProvider(pkg, prov));
      row.appendChild(btn);
    }
    return row;
  });

  const actions = [];
  // A working build exists elsewhere — offer the switch before anything else,
  // since this addon otherwise won't load on the current retail patch.
  if (raw && raw.fixedElsewhere) {
    const f = raw.fixedElsewhere;
    const btn = document.createElement("button");
    btn.className = "btn-update";
    btn.textContent = `Switch to ${PROVIDER_LABEL[f.provider]} (${f.remoteVersion}, retail-compatible)`;
    btn.title = `Pins this addon to ${PROVIDER_LABEL[f.provider]} and reinstalls it from there.`;
    btn.addEventListener("click", async () => {
      await setProviderChoice(pkg, f.provider);
      closeDetail();
      reinstallFromProvider(pkg, f.provider);
    });
    actions.push(btn);
  }
  // Offer the one-click move when another provider is clearly maintained.
  if (raw && raw.betterElsewhere) {
    const b = raw.betterElsewhere;
    const btn = document.createElement("button");
    btn.className = "btn-update";
    btn.textContent = `Switch to ${PROVIDER_LABEL[b.provider]} (${b.remoteVersion})`;
    btn.title = `Pins this addon to ${PROVIDER_LABEL[b.provider]} and reinstalls it from there.`;
    btn.addEventListener("click", async () => {
      await setProviderChoice(pkg, b.provider);
      closeDetail();
      reinstallFromProvider(pkg, b.provider);
    });
    actions.push(btn);
  }
  if (u && !u.upToDate && u.downloadUrl) {
    const btn = document.createElement("button");
    btn.className = "btn-update";
    btn.textContent = `Update to ${u.remoteVersion || "latest"}`;
    btn.addEventListener("click", () => { closeDetail(); installUpdate(pkg, u, btn); });
    actions.push(btn);
  }
  const page = (u && u.pageUrl) || pkg.website;
  if (page) actions.push(linkButton("Open addon page ↗", page));
  const del = document.createElement("button");
  del.className = "btn btn-danger";
  del.textContent = "Uninstall";
  del.addEventListener("click", () => uninstallPackage(pkg));
  actions.push(del);

  openDetail({
    name: pkg.name,
    author: pkg.author,
    summary: (u && u.summary) || pkg.notes,
    logoUrl: u && u.logoUrl,
    kvs,
    providers: provRows,
    folders: pkg.folders,
    actions,
  });
}

function openDetailForResult(r, installedPkg) {
  const entries = r.providers || [r];
  const kvs = [
    ["Latest version", r.remoteVersion],
    ["Downloads", r.downloads ? formatDownloads(r.downloads) : ""],
    ["Game versions", (r.flavors || []).join(", ")],
    ["Category", (r.categories || [])[0]],
    ["Installed", installedPkg ? `yes — via ${PROVIDER_LABEL[installedPkg.installedVia] || "unknown"}` : "no"],
  ];
  if (state.clientInterface) {
    kvs.push([
      "Compatibility",
      entries.some((e) => e.outOfDate)
        ? `⚠ some providers predate your client (${state.clientInterface.label})`
        : `matches your client (${state.clientInterface.label})`,
    ]);
  }

  // One row per provider carrying this addon, each installable directly.
  const provRows = entries.map((e) => {
    const row = document.createElement("div");
    row.className = "detail-provider-row";
    const dot = document.createElement("span");
    dot.className = `dot ${PROVIDER_DOT[e.provider]}`;
    const grow = document.createElement("div");
    grow.className = "grow";
    grow.textContent = PROVIDER_LABEL[e.provider];
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = [e.remoteVersion, e.downloads ? formatDownloads(e.downloads) + " downloads" : ""]
      .filter(Boolean).join(" · ");
    grow.appendChild(sub);
    if (e.outOfDate) {
      const warn = document.createElement("div");
      warn.className = "addon-health hot";
      warn.textContent = `⚠ predates your client patch — may not load`;
      grow.appendChild(warn);
    }
    row.append(dot, grow);
    if (!installedPkg) {
      const btn = document.createElement("button");
      btn.className = "btn-update";
      if (e.downloadUrl || e.provider === "wowinterface" || e.provider === "wago") {
        btn.textContent = "Install from here";
        btn.addEventListener("click", () => {
          if (!confirmStaleInstall(r.name, e)) return;
          closeDetail();
          installFromBrowse({ ...r, ...e }, btn);
        });
      } else {
        btn.textContent = "Get ↗";
        btn.addEventListener("click", () => window.grimoire.openExternal(e.pageUrl || r.pageUrl));
      }
      row.appendChild(btn);
    }
    return row;
  });

  const actions = [];
  if (!installedPkg) {
    const btn = document.createElement("button");
    btn.className = "btn-update";
    btn.textContent = entries.length > 1 ? `Install (${PROVIDER_LABEL[r.provider]})` : "Install";
    btn.addEventListener("click", () => {
      if (!confirmStaleInstall(r.name, r)) return;
      closeDetail();
      installFromBrowse(r, btn);
    });
    actions.push(btn);
  }
  if (r.pageUrl) actions.push(linkButton("Open addon page ↗", r.pageUrl));

  openDetail({
    name: r.name,
    author: r.author,
    summary: r.summary,
    logoUrl: r.logoUrl,
    kvs,
    providers: provRows,
    folders: installedPkg ? installedPkg.folders : [],
    actions,
  });
}

// ---------------------------------------------------------------- browse

// ---------------------------------------------------------------- game flavor

// Populate the WoW-version switcher from whatever clients are installed.
// Hidden entirely when there's only one — no choice to present.
function renderFlavorSwitcher(list, current) {
  const sel = $("#flavor-select");
  if (!sel) return;
  state.flavors = list || [];
  sel.innerHTML = "";
  for (const f of state.flavors) {
    const o = document.createElement("option");
    o.value = f.id;
    o.textContent = f.name;
    sel.appendChild(o);
  }
  if (current) sel.value = current;
  sel.classList.toggle("solo", state.flavors.length <= 1);
}

// Switching game version means a different AddOns folder and different
// provider builds, so drop everything version-specific and rescan.
async function switchFlavor(flavorId) {
  state.settings = await window.grimoire.saveSettings({ ...state.settings, flavor: flavorId });
  state.updates = {};
  state.browseResults = [];
  state.browseCursor = null;
  state.status = "all";
  state.category = "all";
  state.provider = "all";
  const name = (state.flavors.find((f) => f.id === flavorId) || {}).name || flavorId;
  toast(`Now managing ${name}.`, "ok");
  await scan();
}

function switchTab(tab) {
  state.tab = tab;
  $("#tab-installed").classList.toggle("active", tab === "installed");
  $("#tab-browse").classList.toggle("active", tab === "browse");
  $("#view-installed").classList.toggle("hidden", tab !== "installed");
  $("#view-browse").classList.toggle("hidden", tab !== "browse");
  if (tab === "browse") {
    $("#browse-query").focus();
    if (!state.browseResults.length) browseSearch(); // show popular on first open
  }
}

// Match a search result to an installed package: any provider id first,
// then normalized name.
function findInstalled(result) {
  const entries = result.providers || [result];
  for (const e of entries) {
    const field = PKG_ID_FIELD[e.provider];
    const byId = state.packages.find(
      (p) => field && p[field] && String(p[field]) === String(e.id)
    );
    if (byId) return byId;
  }
  const rn = normName(result.name);
  return state.packages.find((p) => normName(p.name) === rn);
}

async function browseSearch() {
  const q = $("#browse-query").value.trim();
  const catSel = $("#browse-category");
  const categoryId = catSel.value || undefined;
  const categoryName = categoryId ? catSel.options[catSel.selectedIndex].textContent : undefined;
  $("#browse-empty").classList.add("hidden");
  $("#browse-results").innerHTML = "";
  $("#browse-more-wrap").classList.add("hidden");
  setStatus(q ? `Searching providers for “${q}”…` : "Loading popular addons…");
  try {
    const res = await window.grimoire.searchProviders({ query: q, categoryId, categoryName });
    for (const note of res.notes || []) toast(note);
    for (const err of res.errors || []) toast(err, "error");
    if (res.clientInterface) state.clientInterface = res.clientInterface;
    state.browseResults = res.results || [];
    state.browseShown = 30;
    state.browseQuery = { query: q, categoryId, categoryName };
    state.browseCursor = res.cursor || null;
    state.browseHasMore = !!res.hasMore;
    state.browseTotal = res.total || 0;
    renderBrowseResults();
    const catNote = categoryId ? " — category filter uses CurseForge's catalog; other providers show where they carry the same addon" : "";
    const totalNote = state.browseTotal > state.browseResults.length ? ` of ${state.browseTotal.toLocaleString()}` : "";
    setStatus(`${state.browseResults.length}${totalNote} results${q ? ` for “${q}”` : " (popular addons)"}${catNote}.`);
  } catch (err) {
    toast(`Search failed: ${err.message || err}`, "error");
    setStatus("Search failed.");
  }
}

function browseFiltered() {
  const flavor = $("#browse-flavor").value;
  if (!flavor) return state.browseResults;
  // Keep results whose flavors are unknown (empty) — hiding them would
  // silently drop providers that don't report game versions.
  return state.browseResults.filter(
    (r) => !(r.flavors || []).length || r.flavors.includes(flavor)
  );
}

function renderBrowseResults() {
  const container = $("#browse-results");
  container.innerHTML = "";
  const all = browseFiltered();
  const shown = all.slice(0, state.browseShown);

  if (!all.length) {
    $("#browse-empty").classList.remove("hidden");
    $("#browse-empty-text").textContent = "No results from any provider.";
    $("#browse-more-wrap").classList.add("hidden");
    return;
  }
  $("#browse-empty").classList.add("hidden");

  for (const r of shown) {
    const row = document.createElement("div");
    row.className = "addon-row";

    const main = document.createElement("div");
    main.className = "addon-main";
    const icon = iconEl(r.name, r.logoUrl);
    const tb = document.createElement("div");
    tb.className = "addon-titleblock";
    const nameEl = document.createElement("div");
    nameEl.className = "addon-name";
    nameEl.textContent = r.name;
    nameEl.appendChild(flavorChips(r.flavors));
    const notesEl = document.createElement("div");
    notesEl.className = "addon-notes";
    const dl = r.downloads ? `${formatDownloads(r.downloads)} downloads · ` : "";
    notesEl.textContent = dl + (r.summary || (r.author ? `by ${r.author}` : ""));
    tb.append(nameEl, notesEl);
    if (r.localInterfaceOutOfDate) {
      const warn = document.createElement("div");
      warn.className = "addon-health hot";
      warn.textContent = `⚠ built for an older retail patch — won't load unless "Load out of date AddOns" is on`;
      warn.title = `Built for an older patch than your client${state.clientInterface ? ` (currently ${state.clientInterface.label})` : ""}. Click the row to see if another provider has a current build.`;
      tb.appendChild(warn);
    }
    main.append(icon, tb);

    const ver = document.createElement("div");
    ver.className = "cell-version";
    ver.textContent = r.remoteVersion || "";

    const prov = document.createElement("div");
    prov.className = "cell-provider";
    const entries = r.providers || [r];
    if (entries.length > 1) {
      const badge = document.createElement("span");
      badge.className = "badge";
      for (const entry of entries) {
        const dot = document.createElement("span");
        dot.className = `dot ${PROVIDER_DOT[entry.provider] || "dot-unk"}`;
        badge.appendChild(dot);
      }
      badge.append(` ${entries.length} providers`);
      badge.title = "Available from: " + entries.map((e) => PROVIDER_LABEL[e.provider]).join(", ") + " — click the row to pick one.";
      prov.appendChild(badge);
    } else {
      const badge = document.createElement("span");
      badge.className = "badge";
      const dot = document.createElement("span");
      dot.className = `dot ${PROVIDER_DOT[r.provider] || "dot-unk"}`;
      badge.append(dot, document.createTextNode(PROVIDER_LABEL[r.provider] || r.provider));
      prov.appendChild(badge);
    }

    const action = document.createElement("div");
    action.className = "cell-action";
    const installed = findInstalled(r);
    if (installed) {
      const ok = document.createElement("span");
      ok.className = "uptodate";
      ok.textContent = `✓ via ${PROVIDER_LABEL[installed.installedVia] || PROVIDER_LABEL[chosenProvider(installed)] || "?"}`;
      ok.title = `Installed — managed via ${PROVIDER_LABEL[installed.installedVia] || "unknown"}`;
      action.appendChild(ok);
    } else if (r.downloadUrl || r.provider === "wowinterface" || r.provider === "wago") {
      const btn = document.createElement("button");
      btn.className = "btn-update";
      if (entries.length > 1) {
        // Multiple providers carry this addon — never guess which one the
        // user wants. Send them to the picker instead of installing quietly.
        // The provider badge to the left already names the options, so the
        // button itself just needs to stay short.
        btn.textContent = "Choose…";
        btn.title = `Available from ${entries.length} providers: ${entries.map((e) => PROVIDER_LABEL[e.provider]).join(", ")}. Click to pick one.`;
        btn.addEventListener("click", (e) => { e.stopPropagation(); openDetailForResult(r, installed); });
      } else {
        btn.textContent = "Install";
        btn.title = `Installs from ${PROVIDER_LABEL[r.provider]}.`;
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!confirmStaleInstall(r.name, r)) return;
          installFromBrowse(r, btn);
        });
      }
      action.appendChild(btn);
    } else {
      const btn = document.createElement("button");
      btn.className = "btn-update";
      btn.textContent = "Get ↗";
      btn.title = "No direct download from this provider — opens the addon page.";
      btn.addEventListener("click", (e) => { e.stopPropagation(); window.grimoire.openExternal(r.pageUrl); });
      action.appendChild(btn);
    }

    row.append(main, ver, prov, action);
    row.addEventListener("click", () => openDetailForResult(r, installed));
    container.appendChild(row);
  }

  // The button stays available when more rows are already loaded OR when more
  // pages exist upstream.
  const moreLocally = all.length > state.browseShown;
  $("#browse-more-wrap").classList.toggle("hidden", !moreLocally && !state.browseHasMore);
  const btn = $("#btn-browse-more");
  if (btn && !btn.disabled) {
    btn.textContent = moreLocally ? "Show more" : "Load more from providers";
  }
}

// Fetch the next page from the providers and fold it into the current list.
async function browseLoadMore() {
  const btn = $("#btn-browse-more");
  btn.disabled = true;
  const prevCount = state.browseResults.length;
  btn.textContent = "Loading…";
  try {
    const res = await window.grimoire.searchProviders({
      ...state.browseQuery,
      cursor: state.browseCursor,
    });
    for (const err of res.errors || []) toast(err, "error");
    if (res.clientInterface) state.clientInterface = res.clientInterface;
    state.browseResults = res.results || state.browseResults;
    state.browseCursor = res.cursor || state.browseCursor;
    state.browseHasMore = !!res.hasMore;
    state.browseTotal = res.total || state.browseTotal;
    // Reveal what just arrived rather than making the user click twice.
    state.browseShown = Math.max(state.browseShown + 30, prevCount);
    renderBrowseResults();
    const added = state.browseResults.length - prevCount;
    setStatus(
      added > 0
        ? `${state.browseResults.length}${state.browseTotal > state.browseResults.length ? ` of ${state.browseTotal.toLocaleString()}` : ""} results loaded.`
        : "No further results from the providers."
    );
    if (added === 0) state.browseHasMore = false;
  } catch (err) {
    toast(`Load more failed: ${err.message || err}`, "error");
  } finally {
    btn.disabled = false;
    renderBrowseResults();
  }
}

// Warn before installing a build that predates the client's current patch —
// so the user finds out now, at the point of choosing, rather than from an
// update-check toast after it's already on disk.
function confirmStaleInstall(name, e) {
  if (!(e.outOfDate || e.localInterfaceOutOfDate)) return true;
  return confirm(
    `${PROVIDER_LABEL[e.provider] || e.provider}'s build of ${name} (${e.remoteVersion || "?"}) is built for an older ` +
    `retail patch than your client${state.clientInterface ? ` (currently ${state.clientInterface.label})` : ""}.\n\n` +
    `It won't load unless "Load out of date AddOns" is on. Install from ${PROVIDER_LABEL[e.provider] || e.provider} anyway?`
  );
}

async function installFromBrowse(r, btn) {
  btn.disabled = true;
  btn.textContent = "Installing…";
  try {
    const res = await window.grimoire.installUpdate({
      key: r.name.replace(/[^\w-]/g, "_"),
      provider: r.provider,
      id: r.id,
      downloadUrl: r.downloadUrl,
      version: r.remoteVersion,
      folders: [],
    });
    toast(`${r.name} installed from ${PROVIDER_LABEL[r.provider] || r.provider} (${res.installedFolders.join(", ")}).`, "ok");
    btn.textContent = "Installed";
    await scan();
    renderBrowseResults();
  } catch (err) {
    toast(`${r.name}: ${err.message || err}`, "error");
    btn.disabled = false;
    btn.textContent = "Install";
  }
}

async function loadBrowseCategories() {
  try {
    state.categories = await window.grimoire.getCategories();
    const sel = $("#browse-category");
    for (const c of state.categories) {
      const opt = document.createElement("option");
      opt.value = String(c.id);
      opt.textContent = c.name;
      sel.appendChild(opt);
    }
  } catch {
    /* no key yet — dropdown stays empty */
  }
}

// ---------------------------------------------------------------- wago ad

// Create the Wago ad panel (or reload it if it already exists) to obtain a
// public token. Called on demand: at startup when no key is configured, and
// whenever a Wago request is rejected — so a saved-but-invalid key, or an
// expired public token, recovers itself instead of leaving Wago dead.
async function ensureWagoAd() {
  const frame = $("#wago-ad-frame");
  if (!frame) return;
  const existing = frame.querySelector("webview");
  if (existing) {
    try { existing.reload(); } catch { /* not ready yet; a later refresh retries */ }
    return;
  }
  try {
    const group = $("#wago-ad-group");
    if (group) group.classList.remove("hidden");
    const pill = $("#wago-status");
    pill.textContent = "connecting…";
    pill.classList.remove("ok");
    const preload = await window.grimoire.wagoAdPreloadPath();
    const wv = document.createElement("webview");
    wv.setAttribute("preload", preload);
    wv.setAttribute("src", "https://addons.wago.io/wowup_ad");
    wv.setAttribute("httpreferrer", "https://wago.io");
    wv.setAttribute(
      "useragent",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/61.0.3163.100 Safari/537.36"
    );
    // No popups — ad pages have no legitimate reason to open windows in-app,
    // and pop-unders can steal focus from the main window.
    wv.setAttribute("partition", "persist:wagoad");
    frame.appendChild(wv);
  } catch {
    $("#wago-status").textContent = "unavailable";
  }
}

async function initWagoAd() {
  // A Wago key is already configured (the user's own, or bundled into this
  // build) — Wago works without the ad panel, so don't run a live third-party
  // ad webview at all. This keeps the app lean and avoids the ad being the
  // one unpredictable, focus-grabbing element in the window.
  // ALWAYS listen for refresh requests, including when we skip the ad below —
  // that signal is what lets a broken/expired token recover by loading the ad.
  window.grimoire.onWagoRefresh(ensureWagoAd);

  if (state.settings.wagoKeyConfigured) {
    // A key is configured, so assume it works and don't run the ad panel. If
    // it turns out to be invalid, the first 401 triggers wago:refresh above
    // and the ad panel loads then.
    const pill = $("#wago-status");
    pill.textContent = "connected ✓";
    pill.classList.add("ok");
    const group = $("#wago-ad-group");
    if (group) group.classList.add("hidden");
    state.wagoConnected = true;
    return;
  }

  const status = await window.grimoire.wagoStatus().catch(() => ({}));
  if (status.connected) setWagoConnected();
  ensureWagoAd();
}

function setWagoConnected() {
  const first = !state.wagoConnected;
  state.wagoConnected = true;
  const pill = $("#wago-status");
  pill.textContent = "connected ✓";
  pill.classList.add("ok");
  if (first) {
    toast("Wago connected — updates and search now include Wago.", "ok");
    // Wago results were missing from any check done before the token arrived.
    if (Object.keys(state.updates).length) checkUpdates();
  }
}

// ---------------------------------------------------------------- settings modal

function openSettings() {
  const s = state.settings || {};
  $("#set-wowpath").value = s.wowPath || "";
  $("#set-cfkey").value = "";
  $("#set-cfkey").placeholder = s.curseKeyConfigured
    ? "Saved securely — enter a replacement or leave blank"
    : "from console.curseforge.com";
  $("#cfkey-status").textContent = s.curseKeyConfigured ? "✓ A CurseForge key is saved securely." : "";
  $("#cfkey-remove-row").classList.toggle("hidden", !s.curseUserKeyConfigured);
  $("#set-cfkey-remove").checked = false;
  $("#set-wagokey").value = "";
  $("#set-wagokey").placeholder = s.wagoUserKeyConfigured
    ? "Saved securely — enter a replacement or leave blank"
    : "optional — ad panel handles this automatically";
  $("#wagokey-status").textContent = s.wagoUserKeyConfigured ? "✓ A Wago token is saved securely." : "";
  $("#wagokey-remove-row").classList.toggle("hidden", !s.wagoUserKeyConfigured);
  $("#set-wagokey-remove").checked = false;
  $("#set-channel").value = s.releaseChannel || "stable";
  const bundled = $("#bundled-note");
  if (bundled) bundled.classList.toggle("hidden", !s.bundledActive);
  $("#modal").classList.remove("hidden");
  if (s.curseKeyConfigured) {
    $("#cfkey-status").textContent = "Testing the saved CurseForge key…";
    window.grimoire.validateCurseKey().then((result) => {
      $("#cfkey-status").textContent = result.valid
        ? "✓ Saved CurseForge key is active."
        : result.message;
    }).catch((err) => {
      $("#cfkey-status").textContent = `Could not test the saved key: ${err.message || err}`;
    });
  }
}

async function saveSettingsFromModal() {
  const button = $("#btn-modal-save");
  const curseApiKey = $("#set-cfkey").value.trim();
  const wagoApiKey = $("#set-wagokey").value.trim();
  const patch = {
    ...state.settings,
    wowPath: $("#set-wowpath").value.trim(),
    releaseChannel: $("#set-channel").value,
  };
  if ($("#set-cfkey-remove").checked) patch.curseApiKey = "";
  else if (curseApiKey) patch.curseApiKey = curseApiKey;
  if ($("#set-wagokey-remove").checked) patch.wagoApiKey = "";
  else if (wagoApiKey) patch.wagoApiKey = wagoApiKey;

  button.disabled = true;
  button.textContent = "Saving…";
  try {
    // Persist first. A newly generated CurseForge key may still be awaiting
    // activation; a failed live check must not silently discard what the user
    // entered and make it look like storage is broken.
    state.settings = await window.grimoire.saveSettings(patch);
    if (curseApiKey && !$("#set-cfkey-remove").checked) {
      button.textContent = "Testing key…";
      const result = await window.grimoire.validateCurseKey();
      if (!result.valid) {
        $("#cfkey-status").textContent = `Saved securely, but ${result.message}`;
        toast("CurseForge key was saved, but CurseForge is still rejecting it. Check its approval/activation status.", "error");
        return;
      }
    }
    $("#modal").classList.add("hidden");
    toast("Settings saved.", "ok");
    if (!state.categories.length) loadBrowseCategories();
    await scan();
  } catch (err) {
    const message = err.message || String(err);
    $("#cfkey-status").textContent = `Could not save or test the key: ${message}`;
    toast(`Settings not saved: ${message}`, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Save";
  }
}

// ---------------------------------------------------------------- wiring

function wire() {
  $("#search").addEventListener("input", (e) => {
    state.search = e.target.value;
    renderList();
  });

  $$("#filter-status .side-item").forEach((b) =>
    b.addEventListener("click", () => { state.status = b.dataset.status; render(); }));
  $$("#filter-provider .side-item").forEach((b) =>
    b.addEventListener("click", () => { state.provider = b.dataset.provider; render(); }));

  $$(".sortable").forEach((b) =>
    b.addEventListener("click", () => {
      if (state.sortBy === b.dataset.sort) state.sortDir *= -1;
      else { state.sortBy = b.dataset.sort; state.sortDir = 1; }
      render();
    }));

  $("#tab-installed").addEventListener("click", () => switchTab("installed"));
  $("#tab-browse").addEventListener("click", () => switchTab("browse"));
  $("#flavor-select").addEventListener("change", (e) => switchFlavor(e.target.value));
  $("#btn-browse-search").addEventListener("click", browseSearch);
  $("#browse-query").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { clearTimeout(browseDebounce); browseSearch(); }
  });
  // Live search while typing (debounced so we don't hammer the providers).
  let browseDebounce;
  $("#browse-query").addEventListener("input", () => {
    clearTimeout(browseDebounce);
    const q = $("#browse-query").value.trim();
    if (q.length === 0 || q.length >= 3) {
      browseDebounce = setTimeout(browseSearch, 450);
    }
  });
  $("#browse-category").addEventListener("change", browseSearch);
  $("#browse-flavor").addEventListener("change", () => renderBrowseResults());
  $("#btn-browse-more").addEventListener("click", () => {
    // Reveal already-loaded rows first; fetch another page once they run out.
    if (browseFiltered().length > state.browseShown) {
      state.browseShown += 30;
      renderBrowseResults();
    } else {
      browseLoadMore();
    }
  });

  $("#btn-rescan").addEventListener("click", scan);
  $("#btn-check").addEventListener("click", checkUpdates);
  $("#btn-settings").addEventListener("click", openSettings);
  $("#btn-modal-cancel").addEventListener("click", () => $("#modal").classList.add("hidden"));
  $("#btn-modal-save").addEventListener("click", saveSettingsFromModal);
  $("#btn-browse").addEventListener("click", async () => {
    const dir = await window.grimoire.pickFolder();
    if (dir) $("#set-wowpath").value = dir;
  });
  $("#modal").addEventListener("click", (e) => {
    if (e.target.id === "modal") $("#modal").classList.add("hidden");
  });

  $("#detail-close").addEventListener("click", closeDetail);
  $("#detail-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "detail-backdrop") closeDetail();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDetail();
  });

  window.grimoire.onWagoConnected(setWagoConnected);

  // Re-scan when the window regains focus. Scanning takes ~40ms, and it means
  // a WoW client that finished installing (or addons changed by another tool)
  // shows up without the user having to hit Rescan.
  let lastFocusScan = Date.now();
  window.addEventListener("focus", () => {
    if (Date.now() - lastFocusScan < 5000) return; // debounce rapid alt-tabbing
    lastFocusScan = Date.now();
    const before = state.flavors.length;
    scan().then(() => {
      if (state.flavors.length > before) {
        const names = state.flavors.map((f) => f.name).join(", ");
        toast(`New World of Warcraft version detected. Now available: ${names}.`, "ok");
      }
    });
  });
}

async function boot() {
  wire();
  window.grimoire.getVersion().then((v) => {
    if (!v) return;
    const label = `v${v}`;
    const header = $("#app-version");
    if (header) header.textContent = label;
    const inSettings = $("#settings-version");
    if (inSettings) inSettings.textContent = `Grimoire ${label}`;
  });
  state.settings = await window.grimoire.getSettings();
  initWagoAd();
  loadBrowseCategories();
  // When a new version has finished downloading, offer a one-click restart.
  window.grimoire.onUpdateReady((version) => {
    const t = document.createElement("div");
    t.className = "toast ok";
    t.textContent = `Grimoire ${version} is ready. `;
    const btn = document.createElement("button");
    btn.className = "btn-update";
    btn.textContent = "Restart to update";
    btn.addEventListener("click", () => window.grimoire.installUpdateNow());
    t.appendChild(btn);
    $("#toasts").appendChild(t); // persists (no auto-dismiss) so it isn't missed
  });
  // macOS: the app can't install its own updates while unsigned, so point the
  // user at the download instead of staying silent.
  window.grimoire.onUpdateAvailable((info) => {
    const t = document.createElement("div");
    t.className = "toast ok";
    t.textContent = `Grimoire ${info.version} is available. `;
    const btn = document.createElement("button");
    btn.className = "btn-update";
    btn.textContent = "Download ↗";
    btn.addEventListener("click", () => window.grimoire.openExternal(info.url));
    t.appendChild(btn);
    $("#toasts").appendChild(t); // persists, same as the Windows update prompt
  });
  await scan();
  // Check for updates (and API compatibility) right away — otherwise a stale
  // or newly-incompatible addon sits unflagged until the user remembers to
  // click "Check for updates" themselves.
  if (state.packages.length) checkUpdates();
}

boot();
