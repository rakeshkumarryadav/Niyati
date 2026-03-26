const { BrowserWindow, clipboard } = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const CFG = Object.freeze({
  maxBlocks: 4, 
  clickTimeoutMs: 10_000, 
  betweenClicksMs: 900,
  panelReadyMs: 3000, 
  clipFreshMs: 1800, 
  pollMs: 80,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const writeAtomic = async (file, data, isText=false) => {
  const dir = path.dirname(file);
  try { await fsp.mkdir(dir, { recursive: true }); } catch {}
  const tmp = path.join(dir, `.${path.basename(file)}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  await fsp.writeFile(tmp, isText ? data : Buffer.from(data));
  await fsp.rename(tmp, file);
};

const last10 = (m) => String(m||"").replace(/\D/g,"").slice(-10);
const idKeyOf = (r) => [String(r.product||"").toLowerCase().trim(), String(r.buyer||"").toLowerCase().trim(), last10(r.mobile)].join("|");
const logKeyOf = (r) => idKeyOf(r) + "|" + String(r.time||"").toLowerCase().trim();
const esc = (s) => (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const nowTS = () => { 
  const d=new Date(),p=n=>String(n).padStart(2,"0"); 
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; 
};

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(v||"");
const pickGSTIN = (s)=>((s||"").toUpperCase().replace(/[^A-Z0-9]/g,"").match(/[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]/)||[])[0]||"";
const cleanAddr = (v)=>String(v||"").trim().replace(/\s*\n\s*/g,", ").replace(/\s+/g," ");
const waitFor = async (fn, to)=>{ 
  const t0=Date.now(); 
  while(Date.now()-t0<to){ 
    try{ if(await fn()) return true; }catch{} 
    await sleep(160);
  } 
  return false; 
};

// ✅ Clipboard safety constants
const MAX_SAFE_CLIPBOARD_LENGTH = 10000;
const CLIPBOARD_DANGEROUS_PATTERNS = [/<script|javascript:|data:text\/html|onerror=/i];

// ✅ FIX: Shared clipboard validation helper (avoids duplicate code)
function validateClipboardContent(content, log = () => {}) {
  if (!content) return { valid: false, reason: 'empty' };

  if (content.length > MAX_SAFE_CLIPBOARD_LENGTH) {
    log("warning", `Clipboard Too Large (${content.length} chars), Skipping`);
    return { valid: false, reason: 'too_large' };
  }

  for (const pattern of CLIPBOARD_DANGEROUS_PATTERNS) {
    if (pattern.test(content)) {
      log("warning", "Clipboard Contains Dangerous Patterns, Skipping");
      return { valid: false, reason: 'dangerous' };
    }
  }

  return { valid: true };
}

// ✅ FIXED: Safe clipboard reading with size limits and pattern detection
const readClipFresh = async (prev, timeout=CFG.clipFreshMs, log=()=>{})=>{
  const end=Date.now()+timeout;
  while(Date.now()<end){
    try {
      const cur = clipboard.readText().trim();
      const validation = validateClipboardContent(cur, log);

      if (!validation.valid) {
        await sleep(CFG.pollMs);
        continue;
      }

      // Safe to use
      if(cur && cur!==prev) return cur;
    } catch (e) {
      if (typeof log === 'function') {
        log("error", `Clipboard Read Error: ${e.message}`);
      }
    }
    await sleep(CFG.pollMs);
  }
  return "";
};

// ✅ Safe clipboard operations (uses shared validation)
function safeReadClipboard(log) {
  try {
    const content = clipboard.readText().trim();
    const validation = validateClipboardContent(content, log);
    return validation.valid ? content : null;
  } catch (e) {
    log("error", `Failed to Read Clipboard: ${e.message}`);
    return null;
  }
}

function safeRestoreClipboard(original, log) {
  if (!original) return;
  try {
    if (clipboard.readText() !== original) {
      clipboard.writeText(original);
    }
  } catch (e) {
    log("error", `Failed to Restore Clipboard: ${e.message}`);
  }
}

class LeadStore {
  constructor(dir){
    this.outDir = path.join(dir||__dirname, "Reports");
    try { fs.mkdirSync(this.outDir, { recursive: true }); } catch {}
    this.jsonFile = path.join(this.outDir, "messagecentre_log.json");
    this.rows=[]; 
    this.serial=1; 
    this.logKeys=new Set(); 
    this.idIndex=new Map(); 
    this._flushTimer=0;
    this._loadSync();
  }
  
  _loadSync(){
    try { 
      const j = JSON.parse(fs.readFileSync(this.jsonFile, "utf8")); 
      if (Array.isArray(j)) this.rows = j; 
    } catch {}
    
    for (let i=0;i<this.rows.length;i++){
      const r=this.rows[i]||{}, s=parseInt(r.serial,10);
      if(!Number.isNaN(s)) this.serial=Math.max(this.serial,s+1);
      this.logKeys.add(logKeyOf(r));
      const ik=idKeyOf(r); 
      if(!this.idIndex.has(ik)) this.idIndex.set(ik,i);
      if(typeof r.notified!=="boolean") r.notified=false;
      if(typeof r.lastSig!=="string") r.lastSig="";
    }
  }
  
  _debouncedFlush(){
    clearTimeout(this._flushTimer);
    this._flushTimer=setTimeout(()=>this.flush().catch(e => {
      console.error('[LeadStore] Flush failed:', e.message);
    }),120);
  }
  
  async flush(){ 
    await writeAtomic(this.jsonFile, JSON.stringify(this.rows, null, 2), true); 
  }
  
  mergeFill(dst, src){
    const F=["product","buyer","mobile","email","company","gstin","address","time"], changed=[];
    for(const f of F){ 
      const cur=String(dst[f]??""), inc=String(src[f]??""); 
      if((cur.trim()===""||cur==="---") && inc.trim()!==""){ 
        dst[f]=inc; 
        changed.push(f);
      } 
    }
    return changed;
  }
  
  upsert(row){
    const ts=nowTS(), ik=idKeyOf(row);
    if(this.idIndex.has(ik)){
      let idx=this.idIndex.get(ik);
      if (idx < 0 || idx >= this.rows.length || idKeyOf(this.rows[idx]) !== ik) {
        const found = this.rows.findIndex(r => idKeyOf(r) === ik);
        if (found >= 0) { idx = found; this.idIndex.set(ik, found); }
      }
      if (idx >= 0) {
        const changed=this.mergeFill(this.rows[idx], row);
        if(changed.length){ 
          this.rows[idx].timestamp=this.rows[idx].timestamp||ts; 
          this._debouncedFlush(); 
          return {action:"merge", index:idx, changedFields:changed}; 
        }
        return {action:"dup", index:idx};
      }
    }
    if(this.logKeys.has(logKeyOf(row))) return {action:"dup", index:-1};
    
    const rec={ 
      serial:this.serial++, 
      timestamp:ts,
      product:row.product||"", 
      buyer:row.buyer||"", 
      mobile:row.mobile||"",
      email:row.email||"", 
      company:row.company||"", 
      gstin:row.gstin||"",
      address:row.address||"", 
      time:row.time||"", 
      notified:false, 
      lastSig:"" 
    };
    
    for (const [k, v] of this.idIndex) this.idIndex.set(k, v + 1);
    this.rows.unshift(rec); 
    this.logKeys.add(logKeyOf(row)); 
    this.idIndex.set(ik,0); 
    this._debouncedFlush();
    return {action:"new", index:0};
  }
  
  get(i){return this.rows[i]}
  
  markSig(i,sig){ 
    const r=this.rows[i]; 
    if(r){ 
      r.notified=true; 
      r.lastSig=sig; 
      this._debouncedFlush(); 
    } 
  }

  // ✅ NEW: Light reset - rebuild indexes from existing data
  reset() {
    try {
      this.logKeys.clear();
      this.idIndex.clear();
      
      for (let i = 0; i < this.rows.length; i++) {
        const r = this.rows[i] || {};
        this.logKeys.add(logKeyOf(r));
        const ik = idKeyOf(r);
        if (!this.idIndex.has(ik)) this.idIndex.set(ik, i);
      }


      console.log(`[LeadStore] Light Reset: ${this.rows.length} Rows, ${this.logKeys.size} Keys, ${this.idIndex.size} Index`);
    } catch (e) {
      console.error('[LeadStore] Reset Failed:', e);
    }
  }
  
  // ✅ NEW: Deep reset - wipe everything
  deepReset() {
    this.rows = [];
    this.serial = 1;
    this.logKeys.clear();
    this.idIndex.clear();
    this._debouncedFlush();
    console.log('[LeadStore] Deep Reset Complete');
  }
  
  // ✅ NEW: Get statistics
  getStats() {
    return {
      rowsCount: this.rows.length,
      logKeysSize: this.logKeys.size,
      idIndexSize: this.idIndex.size,
      serial: this.serial
    };
  }
}

async function readTextFields(win, specs){
  const code = `(function(S){
    const $=s=>document.querySelector(s), 
          xp=s=>document.evaluate(s,document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue, 
          txt=n=>n?(n.textContent||"").trim().replace(/\\s+/g," "):""; 
    const o={}; 
    for(const f of S){ 
      let v=f.textCss?txt($(f.textCss)):""; 
      if(!v&&f.textXp) v=txt(xp(f.textXp)); 
      o[f.key]=v||'---'; 
    } 
    return o;
  })(${JSON.stringify(specs)})`;
  return win.webContents.executeJavaScript(code,true);
}

async function clickAny(win, css, xp, scopeSel){
  const code = `(function(css,xp,scope){
    const root=scope?document.querySelector(scope):document;
    if(!root) return false;
    const vis=e=>e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
    const tap=e=>{
      try{e.scrollIntoView({block:'center',inline:'center'})}catch{};
      e.dispatchEvent?.(new MouseEvent('click',{bubbles:true}));
      e.click?.();
      return true;
    };
    try{
      if(css){
        const el=(scope? root.querySelector(css.startsWith(':scope')?css:(':scope '+css)) : document.querySelector(css));
        if(vis(el)) return tap(el.ownerSVGElement||el);
      }
    }catch{}
    try{
      if(xp){
        const el=document.evaluate(xp,root,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;
        if(vis(el)) return tap(el.ownerSVGElement||el);
      }
    }catch{}
    return false;
  })(${JSON.stringify(css)},${JSON.stringify(xp)},${JSON.stringify(scopeSel)})`;
  return win.webContents.executeJavaScript(code,true);
}

// ✅ NEW: Click Quick Reply 1 button and press Enter to send
// Searches through children 1-9 to find button with "quick reply1" text, then clicks + Enter
// ✅ FIX: First checks if Quick Reply 1 was already sent using HARDCODED text
async function clickQuickReply1(win, log=()=>{}){
  // ✅ HARDCODED: Known Quick Reply 1 message text for verification
  const QUICK_REPLY_1_TEXT = "thank you for showing interest";

  try {
    // Step 1: Check if Quick Reply 1 was already sent (using hardcoded text)
    const checkAlreadySentCode = `(function(){
      try {
        const scrollArea = document.querySelector('#scrollableDiv');
        if (!scrollArea) return { alreadySent: false, reason: 'no-scroll-area' };

        // Get ALL text content from the chat area
        const allText = (scrollArea.textContent || scrollArea.innerText || '').toLowerCase();

        // Check if our known Quick Reply 1 text exists anywhere in chat
        const knownText = ${JSON.stringify(QUICK_REPLY_1_TEXT)};
        if (allText.includes(knownText)) {
          return { alreadySent: true, matchedText: knownText };
        }

        return { alreadySent: false };
      } catch (e) {
        return { alreadySent: false, error: e.message };
      }
    })()`;

    const sentCheck = await win.webContents.executeJavaScript(checkAlreadySentCode, true);

    if (sentCheck && sentCheck.alreadySent) {
      log("info", `MC: Quick Reply 1 Already Sent, Skipping`);
      return { clicked: false, reason: 'already-sent', skipped: true };
    }

    // Step 2: Find and click Quick Reply 1 button
    const clickQR1Code = `(function(){
      try {
        const container = document.querySelector('#suggested_replies > div');
        if (!container) return { clicked: false, reason: 'container-not-found' };

        const children = container.querySelectorAll(':scope > div');
        if (!children.length) return { clicked: false, reason: 'no-children' };

        const quickReply1Keywords = ['quick reply1', 'quick reply 1', 'quickreply1', 'quickreply 1'];
        const vis = e => e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
        const maxCheck = Math.min(children.length, 9);

        for (let i = 0; i < maxCheck; i++) {
          const child = children[i];
          const span = child.querySelector('span');
          if (!span) continue;

          const text = (span.textContent || span.innerText || '').trim();
          const textLower = text.toLowerCase();
          const isQuickReply1 = quickReply1Keywords.some(kw => textLower.includes(kw));

          if (isQuickReply1 && vis(span)) {
            try { span.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
            span.dispatchEvent?.(new MouseEvent('click', { bubbles: true }));
            span.click?.();
            return { clicked: true, childIndex: i + 1, buttonText: text.slice(0, 50) };
          }
        }

        return { clicked: false, reason: 'quick-reply1-not-found', checkedChildren: maxCheck };
      } catch (e) {
        return { clicked: false, reason: 'error', error: e.message };
      }
    })()`;

    const clickResult = await win.webContents.executeJavaScript(clickQR1Code, true);

    if (clickResult && clickResult.clicked) {
      log("info", `MC: Quick Reply 1 Clicked (child ${clickResult.childIndex}: "${clickResult.buttonText}")`);

      // Wait for text to populate in input field
      await new Promise(r => setTimeout(r, 600));

      // Focus the textarea
      await win.webContents.executeJavaScript(`(function(){
        const selectors = ['textarea', 'div[contenteditable="true"]', 'input[type="text"]'];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null) {
            el.focus();
            el.click();
            if (el.setSelectionRange && el.value) {
              el.setSelectionRange(el.value.length, el.value.length);
            }
            return true;
          }
        }
        return false;
      })()`, true);

      await new Promise(r => setTimeout(r, 300));

      // Send Enter key using native Electron API
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      await new Promise(r => setTimeout(r, 100));
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

      log("info", `MC: Enter Sent`);
      return { clicked: true, enterSent: true, childIndex: clickResult.childIndex, buttonText: clickResult.buttonText };

    } else {
      log("info", `MC: Quick Reply 1 Not Found (${clickResult?.reason || 'unknown'})`);
      return clickResult;
    }

  } catch (e) {
    log("error", `MC: Quick Reply 1 Error – ${e.message}`);
    return { clicked: false, reason: 'exception', error: e.message };
  }
}

function formatLead(label, r){
  const ph=last10(r.mobile), wa=ph?`https://wa.me/91${ph}`:"";
  const maps=r.address&&r.address!=="---"?`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.address)}`:"";
  const L=[
    label,
    r.product && `✨ <b>${esc(r.product)}</b>`,
    r.buyer && `👤 <b>Name:</b> ${esc(r.buyer)}`,
    r.company && `🏢 <b>Company:</b> ${esc(r.company)}`,
    ph && `📞 <b>Mobile:</b> +91${ph}`,
    wa && `💬 <b>WhatsApp:</b> <a href="${wa}">${esc(wa)}</a>`,
    r.gstin && `🧾 <b>GSTIN:</b> ${esc(r.gstin)}`,
    r.email && `✉️ <b>Email:</b> ${esc(r.email)}`,
    r.address && `📍 <b>Address:</b> ${esc(r.address)}`,
    maps && `🗺️ <a href="${maps}">Open in Maps</a>`,
    r.time && `⏰ <b>Time:</b> ${esc(r.time)}`
  ].filter(Boolean).join("\n");
  return { text:L, extra:{ parse_mode:"HTML", disable_web_page_preview:true, link_preview_options:{ is_disabled:true } } };
}

const formatNew = (r)=> formatLead("🆕 <b>New Lead</b>", r);
const formatUpd = (r)=> formatLead("🔁 <b>Updated Lead</b>", r);

// vCard (.vcf) builder — Telegram pe contact card bhejna ke liye
function buildVCard(r) {
  const ph = last10(r.mobile);
  const name = String(r.buyer || "").trim();
  const company = String(r.company || "").trim();
  const email = String(r.email || "").trim();
  const address = String(r.address || "").trim();
  const product = String(r.product || "").trim();
  const gstin = String(r.gstin || "").trim();

  const vesc = (s) => String(s || "").replace(/[\\;,]/g, "\\$&").replace(/\n/g, "\\n");

  const lines = ["BEGIN:VCARD", "VERSION:3.0"];

  const parts = name.split(/\s+/);
  const firstName = parts[0] || "";
  const lastName = parts.slice(1).join(" ") || "";
  lines.push(`FN:${vesc(name || company || "Lead")}`);
  if (firstName || lastName) lines.push(`N:${vesc(lastName)};${vesc(firstName)};;;`);

  if (company && company !== "---") lines.push(`ORG:${vesc(company)}`);
  if (ph) lines.push(`TEL;TYPE=CELL:+91${ph}`);
  if (email && email !== "---") lines.push(`EMAIL:${vesc(email)}`);
  if (address && address !== "---") lines.push(`ADR;TYPE=WORK:;;${vesc(address)};;;;`);

  const notes = [];
  if (product && product !== "---") notes.push(`Product: ${product}`);
  if (gstin && gstin !== "---") notes.push(`GSTIN: ${gstin}`);
  if (notes.length) lines.push(`NOTE:${vesc(notes.join(" | "))}`);

  lines.push("END:VCARD");
  return Buffer.from(lines.join("\r\n"), "utf8");
}

function vCardFilename(r) {
  const raw = String(r.buyer || r.company || "lead").trim();
  const safe = raw.replace(/[^a-zA-Z0-9\u0900-\u097F\s]/g, "").replace(/\s+/g, "_").slice(0, 40);
  return `${safe || "lead"}.vcf`;
}
const notifSig = (r)=> JSON.stringify({ 
  product:r.product||"", 
  buyer:r.buyer||"", 
  company:r.company||"", 
  m:last10(r.mobile), 
  email:r.email||"", 
  gstin:r.gstin||"", 
  address:r.address||"", 
  time:r.time||"" 
});

function createMessageCentre(opts = {}){
  const {
    log=()=>{}, 
    url="https://seller.indiamart.com/messagecentre/", 
    parent=null,
    windowOptions={ 
      title:"Message Centre", 
      width:1200, 
      height:800, 
      show:false, 
      backgroundColor:"#0f0f10", 
      autoHideMenuBar:true, 
      webPreferences:{ contextIsolation:true, backgroundThrottling:false } 
    },
    maxBlocks=CFG.maxBlocks, 
    clickTimeoutMs=CFG.clickTimeoutMs, 
    betweenClicksMs=CFG.betweenClicksMs, 
    panelReadyTimeoutMs=CFG.panelReadyMs,
    readFreshMs=CFG.clipFreshMs, 
    pollStepMs=CFG.pollMs, 
    autoClose=true, 
    send=async()=>{}
  } = opts;

  const store=new LeadStore(__dirname);

  // ── Persistent Window ─────────────────────────────────────────────────────
  // एक ही window बनती है, app start पर pre-create होती है, हर job पर show/hide।
  // नई window हर बार नहीं बनती — पहली job पर zero overhead।
  let _mcWin = null;

  function _ensureWindow() {
    if (_mcWin && !_mcWin.isDestroyed()) return _mcWin;

    _mcWin = new BrowserWindow({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'preload.js')
      },
      ...windowOptions,
      show: false,   // हमेशा hidden — openOnce() ज़रूरत पर show करेगी
      parent
    });

    _mcWin.setMenuBarVisibility(false);

    _mcWin.once("closed", () => {
      _mcWin = null;
      log("info", "MC: Persistent Window Destroyed");
    });

    _mcWin.webContents.on("did-finish-load", () => log("info", "MC: Page Loaded"));
    log("info", "MC: Persistent Window Created");
    return _mcWin;
  }

  function _destroyWindow() {
    if (_mcWin && !_mcWin.isDestroyed()) {
      try { _mcWin.destroy(); } catch {}
    }
    _mcWin = null;
  }
  // ─────────────────────────────────────────────────────────────────────────

  const FIELDS=[
    { key:"buyer", textCss:"#left-name", textXp:'//*[@id="left-name"]' },
    { key:"product",
      textCss: `#scrollableDiv > div.infinite-scroll-component__outerdiv > div > div.df > div.df.lms_flxdc.lms_aifs.mr20.mxwdth45 > div.left_side_msg > div.df.justifycontentfstart > div > div:nth-child(1)`,
      textXp: '//*[@id="scrollableDiv"]/div[2]/div/div[2]/div[1]/div[1]/div[1]/div/div[1]'
    },
    { key:"mobile", textCss:"#headerMobile > div:nth-child(1) > span:nth-child(2)", textXp:'//*[@id="headerMobile"]/div[1]/span[2]' },
    { key:"company", kind:"company", container:"#headerCompany", copyCss:"div:nth-child(1) svg path:nth-child(1)", copyXp:'//*[@id="headerCompany"]/div/svg/path[1]' },
    { key:"email", kind:"email", container:"#headerEmail", copyCss:"div:nth-child(1) svg path:nth-child(1)", copyXp:'//*[@id="headerEmail"]/div[1]/svg' },
    { key:"gstin", kind:"gstin", container:"#headerGST", copyCss:"div:nth-child(1)", copyXp:'//*[@id="headerGST"]/div' },
    { key:"address", kind:"address", container:"#headerAddress", copyCss:"span.mr2 svg path:nth-child(1)", copyXp:'//*[@id="headerAddress"]/span[1]/svg/path[1]' },
    { key:"time",
      textCss: ".left_side_msg .time_stamp, .time_stamp",
      textXp: '//*[@id="scrollableDiv"]/div[2]/div/div[2]/div[1]/div[1]/div[5]'
    },
  ];
  
  const BOXES = FIELDS.filter(f=>f.container);

  async function readProductFromList(win,i){
    const k=i+1, 
          cssSel=`#splitViewContactList > div > div > div > div:nth-child(${k}) > div > div:nth-child(4) > div.wrd_elip.fl.fs12.fwb.mxwdt75.bgF0F0F0.pd5_20.brdr_rad15 > span`,
          xpSel =`//*[@id="splitViewContactList"]/div/div/div/div[${k}]/div/div[4]/div[1]/span`;
    const code=`(function(css,xp){
      const t=n=>n?(n.textContent||"").trim().replace(/\\s+/g," "):"";
      try{const el=document.querySelector(css);if(el)return t(el);}catch{}
      try{const n=document.evaluate(xp,document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;if(n)return t(n);}catch{}
      return "";
    })(${JSON.stringify(cssSel)},${JSON.stringify(xpSel)})`;
    try{ return await win.webContents.executeJavaScript(code,true); }catch{ return ""; }
  }

  async function openOnce(){
    // Persistent window लो या बनाओ
    const win = _ensureWindow();
    let jobAborted = false;

    currentWindow = win;

    const onDestroyed = () => { jobAborted = true; };
    win.once("closed", onDestroyed);

    const shouldContinue = () => !jobAborted && win && !win.isDestroyed();

    const selFor=(i)=>{ 
      const k=i+1; 
      return [
        [`#splitViewContactList > div > div > div > div:nth-child(${k}) > div`, null],
        [null, `//*[@id="splitViewContactList"]/div/div/div/div[${k}]/div`],
        [`#contact-${i}`, null],
        [null, `//*[@id="contact-${i}"]`],
      ];
    };

    try{
      try { win.show(); } catch {}
      await win.loadURL(url);

      for(let i=0;i<maxBlocks;i++){
        // ✅ Check if window was closed manually
        if (!shouldContinue()) {
          log("info", "MC: Window closed before contact click, stopping...");
          return false;
        }

        let ok=false;
        for(const [css,xp] of selFor(i)){
          if (!shouldContinue()) break;
          ok = await waitFor(()=>clickAny(win,css,xp), clickTimeoutMs);
          if(ok) break;
        }
        if(!ok) {
          log("info",`MC: Contact ${i} Not Available`);
          continue;
        }

        if (!shouldContinue()) {
          log("info", "MC: Window closed after contact click, stopping...");
          return false;
        }

        const ready = await win.webContents.executeJavaScript(`(t=>new Promise(res=>{
          const HAS = [
            '#left-name','#headerMobile','#headerCompany','#headerEmail','#headerGST','#headerAddress',
            '.left_side_msg .time_stamp'
          ];
          const has=()=>HAS.some(s=>{const n=document.querySelector(s);return n&&n.textContent&&n.textContent.trim().length>2;});
          if(has()) return res(true);
          const mo=new MutationObserver(()=>{ if(has()){ mo.disconnect(); res(true); } });
          mo.observe(document.body,{subtree:true,childList:true,characterData:true});
          setTimeout(()=>{ try{mo.disconnect()}catch{}; res(false); }, t);
        }))(${JSON.stringify(panelReadyTimeoutMs)})`, true);


        if(!ready) log("info","MC: Panel Not Fully Ready");

        let base = await readTextFields(win, FIELDS);

        const fromList = await readProductFromList(win, i); 
        if(fromList) base.product = fromList;

        const prev = safeReadClipboard(log);

        async function readTimeNow(winRef){
          const code = `(()=>{
            const pick = (n)=> n ? (n.textContent||'').trim().replace(/\\s+/g,' ') : '';
            const q = (s)=> document.querySelector(s);
            const cands = [
              '.left_side_msg .time_stamp',
              '.time_stamp',
              '#scrollableDiv > div.infinite-scroll-component__outerdiv > div > div.df > div.df.lms_flxdc.lms_aifs.mr20.mxwdth45 > div.left_side_msg > div.df.time_stamp.flxalgn.lms_dflw.mt5.as_fe'
            ];
            for (const sel of cands) {
              try { const n = q(sel); const t = pick(n); if (t) return t; } catch {}
            }
            return '';
          })()`;
          try { return await winRef.webContents.executeJavaScript(code, true); } catch { return ''; }
        }

        if (!base.time || base.time === '---') {
          for (let r = 0; r < 3 && (!base.time || base.time === '---'); r++) {
            await sleep(250);
            const t = await readTimeNow(win);
            if (t) base.time = t;
          }
        }

        const result = { ...base, company:'---', email:'---', gstin:'---', address:'---' };

        for(const f of BOXES){
          const clicked = await clickAny(win, f.copyCss, f.copyXp, f.container);
          let val=""; 
          if(clicked){ 
            await sleep(120); 
            // ✅ Pass log parameter for security warnings
            val = await readClipFresh(prev, readFreshMs, log); 
          }
          if(!val) val = await win.webContents.executeJavaScript(
            `(s=>{const b=document.querySelector(s);return b?(b.textContent||"").trim():"";})(${JSON.stringify(f.container)})`, 
            true
          );

          if (f.kind==="email") val = isEmail(val) ? val : "";
          else if (f.kind==="gstin") val = pickGSTIN(val);
          else if (f.kind==="address")val = pickGSTIN(val) || isEmail(val) ? "" : cleanAddr(val);
          else if (f.kind==="company"){ 
            if(pickGSTIN(val)||isEmail(val)) val=""; 
            val = String(val||"").trim().replace(/\s+/g," "); 
          }

          result[f.key] = val || '---';
          await sleep(110);
        }

        safeRestoreClipboard(prev, log);

        // ✅ NEW: Click Quick Reply 1 button and press Enter to send
        await clickQuickReply1(win, log);
        await sleep(500); // Wait for message to be sent before moving to next contact

        const row = {
          product: result.product!=='---'?result.product:"",
          buyer: result.buyer!=='---'?result.buyer:"",
          company: result.company!=='---'?result.company:"",
          email: result.email!=='---'?result.email:"",
          gstin: result.gstin!=='---'?result.gstin:"",
          mobile: result.mobile!=='---'?result.mobile:"",
          address: result.address!=='---'?result.address:"",
          time: result.time!=='---'?result.time:"",
        };

        const up = store.upsert(row);
        const idx = up.index>=0 ? up.index : (store.idIndex.get(idKeyOf(row)) ?? -1);
        const cur = idx>=0 ? store.get(idx) : null;

        if (up.action==="new" && cur){
          const sig = notifSig(cur);
          if (cur.lastSig !== sig) {
            const p = formatNew(cur);
            await send(p.text, p.extra);
            // vCard contact card bhejo
            try {
              const vcfBuf = buildVCard(cur);
              const vcfName = vCardFilename(cur);
              await send.__sendVCard?.(vcfBuf, vcfName);
            } catch(e) { log("error", `MC: vCard Send Failed: ${e.message}`); }
            store.markSig(idx, sig);
            log("info","MC: Telegram (New)");
          }
        } else if (up.action==="merge" && cur){
          const sig = notifSig(cur);
          if (cur.lastSig !== sig) {
            const p = formatUpd(cur);
            await send(p.text, p.extra);
            // vCard contact card bhejo
            try {
              const vcfBuf = buildVCard(cur);
              const vcfName = vCardFilename(cur);
              await send.__sendVCard?.(vcfBuf, vcfName);
            } catch(e) { log("error", `MC: vCard Update Send Failed: ${e.message}`); }
            store.markSig(idx, sig);
            log("info","MC: Telegram (Update)");
          }
        }

        log("info",`MC: block#${i} → Buyer:${result.buyer} | Product:${result.product} | Company:${result.company} | Email:${result.email} | GSTIN:${result.gstin} | Mobile:${result.mobile} | Address:${result.address} | Time:${result.time}`);
        await sleep(betweenClicksMs);
      }

      // काम हो गया — hide करो, destroy नहीं
      try { if (!win.isDestroyed()) win.hide(); } catch {}
      win.removeListener("closed", onDestroyed);
      currentWindow = null;
      return true;
    } catch(e) {
      log("error",`MC: Error – ${e.message}`);
      try { if (!win.isDestroyed()) win.hide(); } catch {}
      win.removeListener("closed", onDestroyed);
      currentWindow = null;
      return false;
    }
  }

  let running=false;
  let currentWindow = null; // Track current MC window
  const q=[];

  function enqueue(meta={}){
    return new Promise((resolve,reject)=>{
      q.push({meta,resolve,reject});
      if(!running) drain();
    });
  }

  async function drain(){
    running=true;
    try {
      while(q.length){
        const job=q.shift();
        try{ job.resolve(await openOnce()); }
        catch(e){ job.reject(e); }
      }
    } finally {
      // ✅ Always reset running flag, even if error occurs
      running=false;
      // currentWindow openOnce() में already clear हो जाता है
    }
  }

  // ✅ Force stop - use when MC gets stuck
  function forceStop() {
    log("info", "MC: Force Stop Called");
    running = false;
    q.length = 0; // Clear queue

    // ✅ FIX: Clear any pending flush timer to prevent orphan operations
    if (store._flushTimer) {
      clearTimeout(store._flushTimer);
      store._flushTimer = 0;
    }

    // Window hide करो — destroy नहीं, persistent रहे अगली job के लिए
    if (currentWindow && !currentWindow.isDestroyed()) {
      try { currentWindow.hide(); } catch {}
    }
    currentWindow = null;
  }

  // App start होते ही window pre-create — hidden रहेगी, पहली job पर तुरंत ready
  try { _ensureWindow(); } catch (e) { log("error", `MC: Pre-create Failed – ${e.message}`); }

  return {
    enqueue,
    get running(){ return running; },
    get size(){ return q.length; },
    // ✅ NEW: Expose reset methods
    reset: () => store.reset(),
    deepReset: () => store.deepReset(),
    getStats: () => store.getStats(),
    forceStop, // ✅ NEW: Force stop method
    destroyWindow: _destroyWindow  // app shutdown पर call करो
  };
}

module.exports = { createMessageCentre };