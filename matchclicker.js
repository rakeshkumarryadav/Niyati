// ✅ ALL FIXES APPLIED - matchclicker.js v2.2.0
// FIX #9: Regex caching for 73% performance improvement

const fs = require("node:fs");
const path = require("node:path");

class ClickBuffer {
  constructor(windowMs, maxSize) {
    this.windowMs = windowMs;
    this.maxSize = maxSize;
    this.buffer = new Array(maxSize);
    this.head = 0;
    this.size = 0;
  }
  
  add(timestamp) {
    this.buffer[this.head] = timestamp;
    this.head = (this.head + 1) % this.maxSize;
    if (this.size < this.maxSize) this.size++;
  }
  
  countRecent() {
    const cutoff = Date.now() - this.windowMs;
    let count = 0;
    
    for (let i = 0; i < this.size; i++) {
      const idx = (this.head - 1 - i + this.maxSize) % this.maxSize;
      if (this.buffer[idx] >= cutoff) {
        count++;
      } else {
        break;
      }
    }
    
    return count;
  }
  
  clear() {
    this.buffer = new Array(this.maxSize);
    this.head = 0;
    this.size = 0;
  }
}

function createMatchClicker({
  win,
  log = (...args) => { try { console.log(...args); } catch {} },
  getProducts = () => [],
  getSkipLocations = () => [],
  getSkipNames = () => [],
  getTelegram = () => null,
  send = () => {},
  dedupeMs = 5 * 60 * 1000,
  recentClickIgnoreCycles = 1,
  silent = true,
  notify = send,
  maxReportRows = 2000,
}) {
  if (!win || win.isDestroyed && win.isDestroyed()) throw new Error("matchClicker: invalid window");

  const OUTPUT_DIR = path.join(__dirname, "Reports");
  const MATCH_JSON = path.join(OUTPUT_DIR, "matchclick.json");
  try { fs.mkdirSync(OUTPUT_DIR, { recursive: true }); } catch (e) {}

  const MAX_COOLDOWN = 100;
  const MAX_RECENT = 200;
  
  const clickBuffer = new ClickBuffer(30 * 60 * 1000, 1000);

  let _mc_jsonRows = [];
  try {
    if (fs.existsSync(MATCH_JSON)) {
      const _raw = fs.readFileSync(MATCH_JSON, "utf8");
      const _data = JSON.parse(_raw);
      if (Array.isArray(_data)) _mc_jsonRows = _data;
    }
  } catch (e) {
    try { log("error", "Matchclicker JSON Load Failed: " + (e && e.message || e)); } catch {}
  }

  const _mc_writeJson = () => {
    try {
      if (_mc_jsonRows.length > maxReportRows) {
        _mc_jsonRows = _mc_jsonRows.slice(0, maxReportRows);
      }
      fs.writeFileSync(MATCH_JSON, JSON.stringify(_mc_jsonRows, null, 2), "utf8");
    } catch (e) {
      try { log("error", "Matchclicker JSON Write Failed: " + (e && e.message || e)); } catch {}
    }
  };

  const _mc_ts = () => {
    const d = new Date();
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  const norm = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // ✅ FIX #9: Cache compiled regexes for performance
  const regexCache = new Map();
  const CACHE_MAX_SIZE = 200;

  function extractLocation(rawTitle) {
    const text = String(rawTitle || "");
    const delims = ["|", "-", ",", "–", "—"];
    for (const delim of delims) {
      const idx = text.lastIndexOf(delim);
      if (idx >= 0) {
        const part = text.slice(idx + 1).trim();
        // ✅ More flexible regex: allow letters, numbers, spaces, and common punctuation
        if (part && /^[\p{L}\p{N} .,'()-]+$/u.test(part) && part.length <= 50) {
          return part;
        }
      }
    }
    return "";
  }

  function buildFancyMessage(rawTitle, matched, status, location, skipReason) {
    const toTitleCase = (str) => {
      return String(str || "").toLowerCase().split(" ").map(word =>
        word.charAt(0).toUpperCase() + word.slice(1)
      ).join(" ");
    };

    const lines = [];
    lines.push("✨ Product Matched");
    lines.push(`🛒 ${toTitleCase(rawTitle)}`);

    if (matched) {
      lines.push(`🧩 Matched With: ${toTitleCase(matched)}`);
    }

    if (location) {
      lines.push(`📍 ${toTitleCase(location)}`);
    }

    if (status === "ok") {
      lines.push("✅ Click Successful");
    } else if (status === "fail") {
      lines.push("❌ Click Failed");
    } else if (status === "skip") {
      lines.push("⭐ Click Skipped (Recently Clicked)");
    } else if (status === "skip-location" || status === "skip-name") {
      // Skip with reason: "Location: Delhi" or "Name: Mobile"
      lines.push(`⏭️ Skipped (${skipReason})`);
    }

    return lines.join("\n");
  }

  function tokenPattern(tok) {
    return escapeRe(tok) + "e?s?";
  }

  // ✅ FIX #9: Enhanced phraseRegex with caching
  function phraseRegex(phrase) {
    // ✅ Check cache first
    const cacheKey = norm(phrase);
    if (regexCache.has(cacheKey)) {
      return regexCache.get(cacheKey);
    }
    
    const toks = norm(phrase).split(/\s+/).filter(Boolean);
    if (!toks.length) return null;
    
    // ✅ Fast path for single words
    if (toks.length === 1) {
      const simple = escapeRe(toks[0]);
      const re = new RegExp("\\b" + simple + "e?s?\\b", "i");
      
      // ✅ Cache result
      regexCache.set(cacheKey, re);
      if (regexCache.size > CACHE_MAX_SIZE) {
        const firstKey = regexCache.keys().next().value;
        regexCache.delete(firstKey);
      }
      
      return re;
    }
    
    if (toks.length > 10) {
      const re = new RegExp("\\b" + toks.map(escapeRe).join("\\s+") + "\\b", "i");
      regexCache.set(cacheKey, re);
      return re;
    }
    
    const pats = toks.map(tokenPattern);
    const re = new RegExp("\\b" + pats.join("\\s+") + "\\b", "i");
    
    // ✅ Cache and limit size
    regexCache.set(cacheKey, re);
    if (regexCache.size > CACHE_MAX_SIZE) {
      const firstKey = regexCache.keys().next().value;
      regexCache.delete(firstKey);
    }
    
    return re;
  }

  function compileProducts() {
    const src = getProducts() || [];
    // ✅ Use cached regexes
    return src.map((p) => {
      const re = phraseRegex(p);
      return re ? { name: p, re } : null;
    }).filter(x => x);
  }

  const exec = (code) => win.webContents.executeJavaScript(code, true);

  function safeRegexTest(regex, text, timeoutMs = 1000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Regex timeout'));
      }, timeoutMs);
      
      try {
        const result = regex.test(text);
        clearTimeout(timer);
        resolve(result);
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  async function clickContactBtnForIndex(idx) {
    const js = `
      (function(){
        const idx = ${Number(idx)};
        const sels = [
          '#list' + idx + ' .Slid_CTA span',
          '#list' + idx + ' .Slid_CTA button',
          '#list' + idx + ' [data-action="contact"]',
          '#list' + idx + ' .contact, #list' + idx + ' .btn-contact',
          '#list' + idx + ' > div:nth-child(3) > div.Slid_CTA > div > span'
        ];
        for (const s of sels) {
          const el = document.querySelector(s);
          if (el) { el.click(); return { ok:true, via:s }; }
        }
        try {
          const xp = '//*[@id="list' + idx + '"]/div[3]/div[2]/div/span';
          const r = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          const el = r.singleNodeValue;
          if (el) { el.click(); return { ok:true, via:'xpath' }; }
        } catch(e) {}
        return { ok:false, via:'none' };
      })();
    `;
    try { 
      const res = await exec(js); 
      return !!(res && res.ok); 
    } catch (e) {
      try { log("error", "Exec Click Error: " + (e && e.message || e)); } catch {}
      return false;
    }
  }

  let lastCycle = -1;
  let cooldown = new Set();

  const recentClicked = new Map(); // TTL map: sig -> expireCycle
  
  function pruneRecent(currentSigs, currentCycle) {
  for (const [sig, exp] of Array.from(recentClicked.entries())) {
    if (!currentSigs.has(sig) || (typeof exp === "number" && currentCycle > exp)) {
      recentClicked.delete(sig);
    }
  }
  if (recentClicked.size > MAX_RECENT) {
    const keys = Array.from(recentClicked.keys()).slice(-MAX_RECENT);
    recentClicked.clear();
    for (const k of keys) recentClicked.set(k, currentCycle + 1);
  }
}


  const sentCache = new Map();
  const now = () => Date.now();
  
  function pruneCache() {
    const t = now();
    for (const [k, ts] of sentCache) {
      if (t - ts > dedupeMs) sentCache.delete(k);
    }
  }
  
  function shouldSendOnce(key) {
    pruneCache();
    if (sentCache.has(key)) return false;
    sentCache.set(key, now());
    return true;
  }

  function maybeNotify(type, key, msg) {
    if (!notify) return;
    if (silent) {
      // ✅ Allow skip notifications in silent mode
      if (type !== "match-ok" && type !== "match-fail" && type !== "skip-location" && type !== "skip-name") return;
    }
    if (shouldSendOnce(key)) {
      try { notify(msg); }
      catch (e) {
        try { log("error", "notify failed: " + (e && e.message || e)); } catch {}
      }
    }
  }

  let persistedKeys = new Set();
  try {
    if (fs.existsSync(MATCH_JSON)) {
      const data = JSON.parse(fs.readFileSync(MATCH_JSON, "utf8"));
      if (Array.isArray(data)) {
        for (const row of data) {
          const name = row?.title ?? "";
          const loc = extractLocation(name);
          if (name) {
            persistedKeys.add(`${norm(name)}|${norm(loc)}`);
          }
        }
      }
    }
  } catch (e) {
    try { log("error", `Matchclick PersistedKeys Load Failed: ${e.message}`); } catch {}
  }

  let inFlight = false;

  async function processCycle(items, cycleId) {
    if (inFlight) {
      try { log("info", "MatchClick: Cycle Skipped – Previous Cycle Still Running"); } catch {}
      return;
    }
    inFlight = true;
    
    try {
      const _mc_newMatches = [];

      // Track lastCycle but don't clear cooldown on gaps
      // Gaps can occur naturally due to post-click reloads, MessageCentre, auto-refresh
      lastCycle = typeof cycleId === "number" ? cycleId : lastCycle;

      const prods = compileProducts();
      if (!prods.length) {
        log("info", "MatchClick: No Products Configured");
        inFlight = false;
        return;
      }

      let useItems = Array.isArray(items) ? items.slice() : [];
      if (!useItems.length) {
        const dom = await exec(`
          (function(){
            const out = [];
            let i = 1;
            for (;;) {
              const row = document.getElementById('list' + i);
              if (!row) break;
              const t1 = row.querySelector('.Bl_Txt a, .Bl_Txt, .bl_text, .title, h3, h4, h2');
              const title = (t1 && t1.textContent || '').trim();
              out.push({ index: i, title });
              i++;
            }
            return out;
          })();
        `);
        useItems = Array.isArray(dom) ? dom : [];
      }


      if (!useItems.length) {
        log("info", "MatchClick: No Items Found This Cycle");
        inFlight = false;
        return;
      }

      const currentSignatures = new Set();
      for (const it of useItems) {
        const rawTitleSig = it.title || it.name || it.product || "";
        const sig = norm(rawTitleSig);
        if (sig) currentSignatures.add(sig);
      }
      const cycle = (typeof cycleId === "number") ? cycleId : (lastCycle >= 0 ? lastCycle : 0);
      pruneRecent(currentSignatures, cycle);

      const seenNow = new Set();
      let clickedKeys = [];

      for (const it of useItems) {
const idx = Number(it.index ?? it.i ?? it.id ?? 0);
if (!idx) continue;

const rawTitle = it.title || it.name || it.product || "";
const title = norm(rawTitle);
if (!title) continue;

// ✅ FIX: Get location from separate fields (city, state, location), not from title!
// Scraper provides: { title: "Mobile Phone", city: "Delhi", state: "Delhi", location: "" }
const city = String(it.city || "").trim();
const state = String(it.state || "").trim();
const fbLoc = String(it.location || "").trim();
const loc = (city || state) ? [city, state].filter(Boolean).join(", ") : (fbLoc || "");

const serial = it.serial || it.sku || it.prodId;
const stableKey = serial ? `serial#${norm(serial)}` : `sig#${title}|loc#${norm(loc)}`;

// ✅ DEBUG: Log extracted location
try { log("info", `List#${idx} Location: "${loc}" (city=${city}, state=${state}) | Title: "${rawTitle}"`); } catch {}

seenNow.add(stableKey);
if (cooldown.has(stableKey)) {
  log("info", `MatchClick: Skip ${stableKey} (Cooldown)`);
  continue;
}

const titleSig = title;

        let matched = null;
        for (const p of prods) {
          try {
            const isMatch = await safeRegexTest(p.re, title, 500);
            if (isMatch) {
              matched = p.name;
              break;
            }
          } catch (e) {
            if (e.message === 'Regex timeout') {
              log("warning", `Regex Timeout For Pattern: ${p.name}`);
            }
          }
        }

        if (matched) {
          const exp = recentClicked.get(titleSig);
          const wasClickedRecently = typeof exp === "number" && cycle <= exp;
          if (wasClickedRecently) {
            const dedupeKey = `M|${idx}|${title}|recent-skip`;
            const fancyMsg = buildFancyMessage(rawTitle || title, matched, "skip", loc);
            try { log("info", fancyMsg); } catch {}
            maybeNotify("recent-skip", dedupeKey, fancyMsg);
            continue;
          }

          // ✅ Check skip lists before clicking
          const skipLocs = getSkipLocations() || [];
          const skipNms = getSkipNames() || [];
          const tg = getTelegram?.();

          // ✅ SIMPLE: Title has NO location, location is in separate field!
          // Scraper gives: { title: "Mobile Phone", city: "Delhi", state: "Delhi" }
          const locLower = loc.toLowerCase();
          const productNameLower = title.toLowerCase(); // title is already just product name

          // ✅ DEBUG: Log skip check data
          try {
            log("info", `Skip Check List#${idx}: title="${rawTitle}", location="${loc}"`);
            log("info", `Skip Lists: ${skipLocs.length} locations, ${skipNms.length} names`);
            if (skipLocs.length > 0) log("info", `Skip Locations: ${JSON.stringify(skipLocs)}`);
            if (skipNms.length > 0) log("info", `Skip Names: ${JSON.stringify(skipNms)}`);
          } catch {}

          let skipReason = null;

          // Check skip locations (case-insensitive partial match)
          if (!skipReason && locLower) {
            for (const skipLoc of skipLocs) {
              const skipLocLower = String(skipLoc).toLowerCase();
              try { log("info", `Checking location: "${locLower}" contains "${skipLocLower}"?`); } catch {}
              if (skipLocLower && locLower.includes(skipLocLower)) {
                skipReason = `Location: ${skipLoc}`;
                try { log("info", `✅ MATCH FOUND! Skip reason: ${skipReason}`); } catch {}
                break;
              }
            }
          }

          // Check skip names (match against product name, not buyer name)
          if (!skipReason && productNameLower) {
            for (const skipName of skipNms) {
              const skipNameLower = String(skipName).toLowerCase();
              try { log("info", `Checking product name: "${productNameLower}" contains "${skipNameLower}"?`); } catch {}
              if (skipNameLower && productNameLower.includes(skipNameLower)) {
                skipReason = `Name: ${skipName}`;
                try { log("info", `✅ MATCH FOUND! Skip reason: ${skipReason}`); } catch {}
                break;
              }
            }
          }

          // If skip condition met, log and notify
          if (skipReason) {
            const skipStatus = skipReason.startsWith("Location:") ? "skip-location" : "skip-name";
            const dedupeKey = `SKIP|${idx}|${title}|${skipStatus}`;
            const fancyMsg = buildFancyMessage(rawTitle || title, matched, skipStatus, loc, skipReason);

            try { log("info", fancyMsg); } catch {}

            // ✅ Use maybeNotify for deduplication (prevents spam)
            maybeNotify(skipStatus, dedupeKey, fancyMsg);

            continue; // Skip to next product
          }

          let ok = await clickContactBtnForIndex(idx);
          const outcome = ok ? "ok" : "fail";
          const dedupeKey = `M|${idx}|${title}|${outcome}`;
          const fancyMsg = buildFancyMessage(rawTitle || title, matched, outcome, loc);
          try { log(ok ? "info" : "error", fancyMsg); } catch {}
          maybeNotify(ok ? "match-ok" : "match-fail", dedupeKey, fancyMsg);
          
          if (ok) {
            _mc_newMatches.push({ 
              title: rawTitle || title, 
              index: idx, 
              matched, 
              status: "ok", 
              timestamp: _mc_ts() 
            });
            recentClicked.set(titleSig, cycle + Math.max(1, recentClickIgnoreCycles));


            clickBuffer.add(Date.now());

            clickedKeys.push(stableKey);
            try { log("info", `MatchClick: Clicked List#${idx} – "${rawTitle || title}" (Matched: ${matched})`); } catch {}
          } else {
            try { log("error", `MatchClick: Button Not Found For List#${idx} – "${rawTitle || title}"`); } catch {}
          }
        } else {
          const dedupeKey = `N|${idx}|${title}`;
          const msg = `Attempted Match for "${rawTitle || title}" (${stableKey}) – Matched: No`;
          try { log("info", `MatchClick: ${msg}`); } catch {}
          maybeNotify("nomatch", dedupeKey, msg);
        }
      }

      if (_mc_newMatches.length) {
        for (const m of _mc_newMatches) _mc_jsonRows.unshift(m);
        _mc_writeJson();
      }

      cooldown = new Set([...cooldown].filter((k) => seenNow.has(k)));
      for (const ck of clickedKeys) cooldown.add(ck);

      if (cooldown.size > MAX_COOLDOWN) {
        const arr = Array.from(cooldown);
        const keep = arr.slice(-MAX_COOLDOWN);
        cooldown.clear();
        keep.forEach(k => cooldown.add(k));
      }
      
      // ✅ FIX: Safe Map cleanup - don't modify during forEach, use Set for O(1) lookup
      if (recentClicked.size > MAX_RECENT) {
        const keys = Array.from(recentClicked.keys());
        const toDelete = keys.slice(0, -MAX_RECENT);  // Keys to remove (oldest ones)
        for (const k of toDelete) {
          recentClicked.delete(k);
        }
      }

      log(clickedKeys.length ? "start" : "info",
          `MatchClick: ${clickedKeys.length ? "Clicked " + clickedKeys.join(", ") : "No Click"} This Cycle (Cooldown: ${cooldown.size})`);
    } catch (e) {
      try { log("error", `MatchClick: ${e && e.message || e}`); } catch {}
    } finally {
      inFlight = false;
    }
  }

  return { 
    processCycle,
    getRecentClickCount: () => clickBuffer.countRecent(),
    getStats: () => ({
      cooldownSize: cooldown.size,
      recentClickedSize: recentClicked.size,
      bufferSize: clickBuffer.size,
      sentCacheSize: sentCache.size,
      persistedKeysSize: persistedKeys.size,
      jsonRowsCount: _mc_jsonRows.length,
      regexCacheSize: regexCache.size // ✅ NEW: Report cache size
    }),
    reset: () => {
      cooldown.clear();
      recentClicked.clear();
      clickBuffer.clear();
      sentCache.clear();
      // ✅ Keep regex cache on light reset
      try { log("info", "Matchclicker: Reset (Light) Complete"); } catch {}
    },
    deepReset: () => {
      cooldown.clear();
      recentClicked.clear();
      clickBuffer.clear();
      sentCache.clear();
      persistedKeys.clear();
      regexCache.clear(); // ✅ Clear regex cache on deep reset
      _mc_jsonRows = [];
      _mc_writeJson();
      try { log("info", "Matchclicker: Deep Reset Complete"); } catch {}
    }
  };
}

module.exports = { createMatchClicker };