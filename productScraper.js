// ✅ ALL FIXES APPLIED - productScraper.js v2.2.0
// FIX #5: Atomic scraper lock with promise chaining

const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

function createProductScraper({
  win,
  log = () => {},
  delayMs = 3000,
  maxItems = 50,
  loginSelector = "#selsout",
  onItems = null,
  getTelegram = null,
}) {
  if (!win || win.isDestroyed()) throw new Error("productScraper: invalid window");

  const DIR_APP = __dirname;
  const DIR_USER = path.join(app.getPath("userData"), "Niyati");
  const DIR_LOG = path.join(DIR_APP, "Reports");
  const F_STATE = path.join(DIR_USER, "refresh_state.json");

  const LIST_DIR = path.join(DIR_APP, "List");
  const F_PRODUCTS = path.join(LIST_DIR, "products.json");
  const F_KEYWORDS = path.join(LIST_DIR, "keywords.json");

  const F_LOG_JSON = path.join(DIR_LOG, "products_log.json");
  try { fs.mkdirSync(DIR_LOG, { recursive: true }); } catch {}
  try { fs.mkdirSync(LIST_DIR, { recursive: true }); } catch {}

  const URL_DEFAULT = "https://seller.indiamart.com/bltxn/?pref=recent";
  const MIN_MS = 3000, DEF_MS = 7000, RETRY_MS = 1000, BLANKS_BREAK = 5;
  const MAX_LOG_ROWS = 5000;

  const now = () => Date.now();
  // IST timestamp: "YYYY-MM-DD HH:mm:ss" (Asia/Kolkata)
const ts = () => {
  const d = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(d).reduce((o,p)=> (o[p.type]=p.value, o), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
};

  const safe = (fn, fb) => { try { return fn(); } catch { return fb; } };
  const exec = (code) => win.webContents.executeJavaScript(code, true);
  const ensureDir = (p) => { try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {} };

  const normStr = (s) => String(s || "")
    .toLowerCase()
    .replace(/[,|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const makeKey = (title, location) => `${normStr(title)}|${normStr(location) || "-"}`;

  const writeJSON = (file, data) => {
    try {
      ensureDir(file);
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(tmp, file);
    } catch (e) {
      log("error", `JSON Write Failed (${path.basename(file)}): ${e.message}`);
    }
  };
  
  const readJSON = (file, fb) => safe(() => JSON.parse(fs.readFileSync(file, "utf8")), fb);

  let refresh = readJSON(F_STATE, {
    enabled: false, 
    intervalMs: DEF_MS, 
    userWantedAutoRefresh: false,
    lastStartAt: 0, 
    lastStopAt: 0, 
    lastCycleAt: 0, 
    cycles: 0,
  });
  
  const persistState = () => writeJSON(F_STATE, refresh);

  // ✅ Page Keepalive Mechanism
  let keepAliveTimer = null;

  function startKeepAlive(win) {
    if (keepAliveTimer) return;
    
    log("info", "✅ Page Keepalive Started (15s Interval)");
    
    keepAliveTimer = setInterval(() => {
      (async () => {
        try {
          if (!win || win.isDestroyed()) {
            stopKeepAlive();
            return;
          }
          
          await Promise.race([
            win.webContents.executeJavaScript(`
              (function() {
                const now = Date.now();
                const marker = document.getElementById('niyati-keepalive') || 
                              document.createElement('div');
                marker.id = 'niyati-keepalive';
                marker.setAttribute('data-last-ping', now);
                marker.style.display = 'none';
                if (!marker.parentNode) document.body.appendChild(marker);
                return now;
              })();
            `, true),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
          ]);
        } catch (e) {
          // Silent fail - page might be navigating
        }
      })();
    }, 15000);
  }

  function stopKeepAlive() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
      log("info", "Page Keepalive Stopped");
    }
  }

  let tReload = null;
  
  function enableAutoReload(ms = refresh.intervalMs, beforeReload = () => {}) {
    disableAutoReload("switching");  // ✅ FIX: Pass reason to prevent unnecessary Telegram notification
    refresh.intervalMs = Math.max(MIN_MS, Number(ms) || DEF_MS);
    refresh.userWantedAutoRefresh = true;
    refresh.enabled = true;
    refresh.lastStartAt = now();
    persistState();
    
    tReload = setInterval(() => {
      try { beforeReload(); } catch (e) { log("error", "BeforeReload Error: " + (e?.message || e)); }
      try {
        if (!win || win.isDestroyed()) { 
          log("error", "Refresh Skipped: Leads Window Invalid"); 
          return; 
        }
        win.webContents.reloadIgnoringCache();
        log("refresh", `Leads Refreshed (${Math.round(refresh.intervalMs/1000)}s)`);
      } catch (e) { 
        log("error", "ReloadIgnoringCache Failed: " + (e?.message || e)); 
      }
    }, refresh.intervalMs);

    log("start", `Auto-Refresh Started @ ${Math.round(refresh.intervalMs/1000)}s`);
    try {
      const tg = getTelegram?.();
      tg?.send?.(`▶️ Auto-Refresh Started @ ${Math.round(refresh.intervalMs/1000)}s`);
    } catch {}
  }
  
  function disableAutoReload(reason) {
    if (tReload) clearInterval(tReload);
    tReload = null;
    if (refresh.enabled) {
      refresh.enabled = false;
      refresh.lastStopAt = now();
      persistState();
      log("stop", `Auto-Refresh Stopped${reason ? ` – ${reason}` : ""}`);

      // ✅ Don't send Telegram notification on quit or internal switching
      if (reason !== "quit" && reason !== "switching") {
        try {
          const tg = getTelegram?.();
          tg?.send?.(`⏹️ Auto-Refresh Stopped${reason ? ` – ${reason}` : ""}`);
        } catch {}
      }
    }
  }
  
  const getReloadState = () => ({ ...refresh, active, paused });  // ✅ FIX: Expose active/paused flags for complete state visibility

  let productSet = new Set();
  safe(() => {
    if (fs.existsSync(F_PRODUCTS)) {
      const arr = readJSON(F_PRODUCTS, []);
      if (Array.isArray(arr)) productSet = new Set(arr.map(normStr));
      return;
    }
    const legacyTxt = path.join(DIR_APP, "products.txt");
    if (fs.existsSync(legacyTxt)) {
      const txt = fs.readFileSync(legacyTxt, "utf8");
      const arr = (txt || "").split(",").map(s => s.trim()).filter(Boolean);
      writeJSON(F_PRODUCTS, arr);
      productSet = new Set(arr.map(normStr));
      log("info", "Migrated Products.txt -> List/products.json");
    }
  });
  
  const getProducts = () => Array.from(productSet);
  const writeListJSON = (file, items = []) => { 
    ensureDir(file); 
    writeJSON(file, Array.isArray(items) ? items : []); 
    log("info", `${path.basename(file)} Updated (${(items||[]).length} Items)`); 
  };
  
  function setProducts(items = []) {
    try {
      writeListJSON(F_PRODUCTS, Array.isArray(items) ? items : []);
      productSet = new Set((items || []).map(normStr));
      log("info", `Products.json Updated (${productSet.size}) [SetProducts]`);
      return true;
    } catch (e) { 
      log("error", "SetProducts Failed: " + e.message); 
      return false; 
    }
  }
  
  function wireListsIPC(ipcMain) {
try { ipcMain.removeHandler('lists:saveProducts'); } catch {}
  try { ipcMain.removeHandler('lists:saveKeywords'); } catch {}
    ipcMain.handle("lists:saveProducts", (_e, items = []) => { 
      safe(() => { 
        writeListJSON(F_PRODUCTS, items); 
        productSet = new Set((items || []).map(normStr)); 
      }); 
      return { ok: true }; 
    });
    ipcMain.handle("lists:saveKeywords", (_e, items = []) => { 
      try { 
        writeListJSON(F_KEYWORDS, items); 
        return { ok: true }; 
      } catch (e) { 
        return { ok: false, error: e.message }; 
      } 
    });
  }

  safe(() => {
    if (!fs.existsSync(F_KEYWORDS)) {
      const legacy = path.join(DIR_APP, "keywords.txt");
      if (fs.existsSync(legacy)) {
        const txt = fs.readFileSync(legacy, "utf8");
        const arr = (txt||"").split(/[, \n]+/).map(s=>s.trim().toLowerCase()).filter(Boolean);
        writeJSON(F_KEYWORDS, arr);
        log("info","Migrated Keywords.txt -> List/keywords.json");
      }
    }
  });

  const composeLoc = (it) => {
    const city = String(it.city || "").trim();
    const state = String(it.state || "").trim();
    const fb = String(it.location || "").trim();
    return (city || state) ? [city, state].filter(Boolean).join(", ") : (fb || "");
  };

  let keys = new Set(), serial = 1, rows = [];
  
  safe(() => {
    if (!fs.existsSync(F_LOG_JSON)) return;
    const data = readJSON(F_LOG_JSON, []);
    if (!Array.isArray(data)) return;

    // Parse legacy UTC ISO ("...Z") and new IST "YYYY-MM-DD HH:mm:ss"
const parseTs = (s) => {
  if (!s) return Infinity;
  const t = Date.parse(s);
  if (Number.isFinite(t)) return t;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(String(s));
  if (m) {
    const t2 = Date.parse(`${m[1]}T${m[2]}+05:30`);
    if (Number.isFinite(t2)) return t2;
  }
  return Infinity;
};

    data.sort((a,b) => parseTs(a?.timestamp) - parseTs(b?.timestamp));
    
    const seen = new Set();
    const dedupRows = [];
    for (const r of data) {
      const k = makeKey(r?.name, r?.location);
      if (seen.has(k)) continue;
      seen.add(k);
      dedupRows.push(r);
    }
    
    rows = dedupRows;
    
    for (const r of rows) {
      keys.add(makeKey(r?.name, r?.location));
      const s = parseInt(r?.serial, 10);
      if (!Number.isNaN(s)) serial = Math.max(serial, s + 1);
    }
    
    if (rows.length !== data.length) { 
      writeJSON(F_LOG_JSON, rows); 
    }
  });

  const persistJSON = () => writeJSON(F_LOG_JSON, rows);

  function recordIfNew(title, location) {
    const key = makeKey(title, location);
    if (keys.has(key)) return false;
    
    rows.unshift({ serial, timestamp: ts(), name: title, location });
    
    if (rows.length > MAX_LOG_ROWS) {
      const removed = rows.splice(MAX_LOG_ROWS);
      for (const r of removed) {
        keys.delete(makeKey(r?.name, r?.location));
      }
    }
    
    persistJSON();
    keys.add(key);
    log("info", `Persist: + "${title}"${location ? ` [${location}]` : ""}`);
    serial += 1;
    return true;
  }

  let active = false, scheduled = null, cycleId = 0, paused = false;
  let _scrapePromise = null; // ✅ FIX #5: Use promise instead of boolean flag
  
  const clearScheduled = () => { 
    if (scheduled) { 
      clearTimeout(scheduled); 
      scheduled = null; 
    } 
  };
  
  const bumpCycle = () => { 
    cycleId += 1; 
    refresh.cycles = (refresh.cycles|0) + 1; 
    refresh.lastCycleAt = now(); 
    persistState(); 
    return cycleId; 
  };

  // ✅ FIX #5: Atomic scraper lock with promise chaining
  async function scrapeOnce(currentCycleId) {
    // ✅ Atomic lock with promise joining
    if (_scrapePromise) {
      log("debug", "Scrape: Already Running, Joining Existing Scrape");
      try {
        return await _scrapePromise;
      } catch (e) {
        log("error", `Scrape: Previous Scrape Failed: ${e.message}`);
        return { ran: false, reason: 'previous-failed' };
      }
    }
    
    // ✅ Create new scrape promise
    _scrapePromise = (async () => {
      try {
        if (paused) { 
          log("info","Scrape: Paused – Skip"); 
          return { ran: false, reason: 'paused' }; 
        }
        if (!win || win.isDestroyed()) return { ran: false };
        
        // ✅ Add timeout protection
        const SCRAPE_TIMEOUT = 30000;
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Scrape timeout')), SCRAPE_TIMEOUT)
        );

        const scrapePromise = (async () => {
          const js = `(function(max, loginSel){
            if (document.readyState !== 'interactive' && document.readyState !== 'complete')
              return { ready:false, items:[] };
            const loggedIn = !!document.querySelector(loginSel);
            if (!loggedIn) return { ready:true, loggedIn:false, items:[] };

            const txt = n => (n ? (n.textContent||"").trim() : "");
            const qs = sel => { try { const n = document.querySelector(sel); return txt(n); } catch { return ""; } };
            const xpS = xp => { try { return String(document.evaluate(xp, document, null, XPathResult.STRING_TYPE, null).stringValue||"").trim(); } catch { return ""; } };
            const firstNodeTxt = xp => { try { const n = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; return txt(n); } catch { return ""; } };

            const titleCss = i => qs('#list'+i+' div.lstNwLft > div.lstNwLftImg.lstNwDflx.lstNwPr > div > h2') || qs('#list'+i+' h2');
            const titleXp  = i => firstNodeTxt('//*[@id="list'+i+'"]//h2');
            const cityXp   = i => '//*[@id="list'+i+'"]/div[1]/div[1]/div[2]/div/div[1]/div[2]/strong/p/span[1]/text()';
            const stateXp  = i => '//*[@id="list'+i+'"]/div[1]/div[1]/div[2]/div/div[1]/div[2]/strong/p/span[2]/text()';
            const fbXp     = i => '//*[@id="list'+i+'"]/div[1]/div[1]/div[2]/div/div[1]/div[2]/strong/p/span/span/text()';

            const items = [];
            let blanks = 0;
            for (let i=1; i<=max; i++){
              const title = titleCss(i) || titleXp(i);
              if (title) {
                const city = xpS(cityXp(i)), state = xpS(stateXp(i));
                const location = (city || state) ? "" : xpS(fbXp(i));
                items.push({ index:i, title, city: city||"", state: state||"", location: location||"" });
                blanks = 0;
              } else if (++blanks >= ${BLANKS_BREAK} && items.length) break;
            }
            return { ready:true, loggedIn:true, items };
          })(${Number(maxItems)}, ${JSON.stringify(loginSelector)})`;

          return await exec(js);
        })();
        
        // ✅ Race against timeout
        const res = await Promise.race([scrapePromise, timeoutPromise]);
        
        if (!res || res.ready === false) { 
          log("info", "Scrape: Not Ready (Will Retry)"); 
          return { ran: false, retry: true }; 
        }
        if (res.loggedIn === false) { 
          log("info", "Scrape: Not Logged In"); 
          onItems && safe(() => onItems([], currentCycleId)); 
          return { ran: true }; 
        }

        const items = Array.isArray(res.items) ? res.items : [];
        if (!items.length) {
          log("info", "Scrape: No Products Found");
        } else {
          for (const it of items) {
            const loc = composeLoc(it);
            log("scrape", `#List${it.index}: ${it.title}${loc ? ` [${loc}]` : ""}`);
            if (it.title) recordIfNew(it.title, loc);
          }
          log("info", `Scrape: ${items.length} Product(s)`);
        }
        onItems && safe(() => onItems(items, currentCycleId));
        return { ran: true };
        
      } catch (e) {
        if (e.message === 'Scrape timeout') {
          log("error", "⏱️ Scrape Timed Out - Page May Be Frozen");
        } else {
          log("error", `Scrape Error: ${e.message}`);
        }
        return { ran: false };
      } finally {
        // ✅ Clear promise reference when done
        _scrapePromise = null;
      }
    })();
    
    // ✅ Return the promise (first caller gets this directly)
    return await _scrapePromise;
  }

  const onDidFinishLoad = () => { 
    if (active && refresh.enabled && !paused) scheduleAfterDelay(bumpCycle()); 
  };
  
  function scheduleAfterDelay(cId) {
    clearScheduled();
    const wait = Math.max(0, Number(delayMs) || DEF_MS);
    scheduled = setTimeout(async () => {
      scheduled = null;
      if (!active || !refresh.enabled || paused) return;
      const r = await scrapeOnce(cId);
      if (active && refresh.enabled && r && r.retry) {
        scheduled = setTimeout(async () => {
          scheduled = null;
          if (active && refresh.enabled && !paused) await scrapeOnce(cId);
        }, RETRY_MS);
      }
    }, wait);
  }

  function enable() {
    if (active) return;
    active = true;
    startKeepAlive(win);
    safe(() => win.webContents.on("did-finish-load", onDidFinishLoad));
    const isLoading = safe(() => (typeof win.webContents.isLoadingMainFrame === "function")
      ? win.webContents.isLoadingMainFrame()
      : win.webContents.isLoading(), false);
    if (refresh.enabled && !isLoading && !paused) scheduleAfterDelay(bumpCycle());
    log("info", "Scrape: Enabled");
  }
  
  function disable() {
    if (!active) return;
    active = false;
    stopKeepAlive();
    clearScheduled();
    safe(() => win.webContents.removeListener("did-finish-load", onDidFinishLoad));
    log("info", "Scrape: Disabled");
  }
  
  async function navigateToDefault({ hard = false } = {}) {
    if (!win || win.isDestroyed()) return;
    try {
      const href = await exec("location.href");
      const onDefault = typeof href === "string" && href.startsWith(URL_DEFAULT);
      if (hard || !onDefault) win.loadURL(URL_DEFAULT);
      else win.webContents.reloadIgnoringCache();
    } catch { 
      win.loadURL(URL_DEFAULT); 
    }
  }

  return {
    enable, 
    disable, 
    scrapeOnce,
    enableAutoReload, 
    disableAutoReload, 
    getReloadState,
    wireListsIPC, 
    getProducts, 
    setProducts, 
    navigateToDefault,
    setPaused(flag = true) {
      paused = !!flag;
      if (paused) { 
        clearScheduled(); 
        stopKeepAlive(); 
      }
      else if (active) { 
        scheduleAfterDelay(bumpCycle()); 
        startKeepAlive(win); 
      }
    },
    isPaused() { return !!paused; },
    resetLog() {
      rows = [];
      keys.clear();
      serial = 1;
      persistJSON();
      log("info", "Products Log Reset");
    }
  };
}

module.exports = { createProductScraper };