// Elder Tree tracker (Alt1)
// v0.5.0 — per-location live panels, overlay HUD, banner OCR + minimap OCR,
// audio pre-alert, stats tracking, export/import data

// ---------- helpers ----------
const el = id => document.getElementById(id);
const fmtMMSS = s => {
  if (s <= 0) return "00:00";
  const m = Math.floor(s/60), r = Math.floor(s%60);
  return `${String(m).padStart(2,"0")}:${String(r).padStart(2,"0")}`;
};
const fmtHMS = ms => {
  const t = Math.max(0, Math.floor(ms/1000));
  const h = Math.floor(t/3600), m = Math.floor((t%3600)/60), s = t%60;
  return [h,m,s].map(v=>String(v).padStart(2,"0")).join(":");
};
const LOCS = ["Edgeville","Varrock","Yanille"];

// ---------- state ----------
let a1ready=false, inAlt1=false;
let startTs = Date.now();
let activeLoc = localStorage.getItem("elder_loc") || "Edgeville";
const state = {}; // per location
const stats = { totalLogs: 0, totalXP: 0, totalChops: 0 }; // session stats
LOCS.forEach(n => state[n] = { chopEnd:0, coolEnd:0, logs:0, xp:0, preAlertPlayed:false });

// restore per-loc counters from storage
LOCS.forEach(n=>{
  const s = state[n];
  ["chopEnd","coolEnd","logs","xp"].forEach(k=>{
    const v = localStorage.getItem(`elder_${n}_${k}`);
    if (v!=null) s[k] = k.endsWith("End") ? Number(v) : Number(v)||0;
  });
});

// restore stats
["totalLogs","totalXP","totalChops"].forEach(k=>{
  const v = localStorage.getItem(`elder_stats_${k}`);
  if (v!=null) stats[k] = Number(v)||0;
});
const savedStartTs = localStorage.getItem("elder_startTs");
if (savedStartTs) startTs = Number(savedStartTs);

// ---------- UI bindings ----------
const locSel = el("location");
const locTitle = el("locTitle");
locSel.value = activeLoc;
locTitle.textContent = activeLoc;

locSel.onchange = () => setActiveLocation(locSel.value, "manual");

// Buff checkboxes persistence
["juju","beaver","sentinel","torch","cape","aura"].forEach(key=>{
  const id = "buf_"+key, box = el(id);
  const k = "elder_buf_"+key;
  box.checked = localStorage.getItem(k)==="1";
  box.addEventListener("change", ()=> localStorage.setItem(k, box.checked?"1":"0"));
});

// Overlay toggle
const toggleHud = el("toggleHud");
toggleHud.checked = localStorage.getItem("elder_hud")==="1";
toggleHud.onchange = ()=> localStorage.setItem("elder_hud", toggleHud.checked?"1":"0");

// Sound toggle + pre-alert seconds
const toggleSound = el("toggleSound");
const preAlertInput = el("preAlert");
toggleSound.checked = (localStorage.getItem("elder_sound") ?? "1") === "1";
preAlertInput.value = Number(localStorage.getItem("elder_prealert") ?? 10);
toggleSound.onchange = ()=> localStorage.setItem("elder_sound", toggleSound.checked ? "1":"0");
preAlertInput.onchange = ()=> localStorage.setItem("elder_prealert", String(Math.max(1, Math.min(60, Number(preAlertInput.value)||10))));

// Buttons
el("forceChop").onclick = () => startChopTimer();
el("forceCool").onclick = () => startCooldown();
el("resetAll").onclick = () => {
  LOCS.forEach(n=>{ state[n]={chopEnd:0,coolEnd:0,logs:0,xp:0, preAlertPlayed:false}; saveLoc(n); });
  paintAll();
};

// Export/Import data
function exportData(){
  const data = {
    version: "0.5.0",
    state: {},
    stats: {...stats},
    activeLoc: activeLoc,
    startTs: startTs,
    timestamp: Date.now()
  };
  LOCS.forEach(n=>{
    data.state[n] = {...state[n]};
    delete data.state[n].preAlertPlayed; // don't export temp state
  });
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], {type: "application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `elder-timer-backup-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
  safeOverlay("Data exported", 1000);
}

function importData(){
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json";
  input.onchange = (e)=>{
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev)=>{
      try{
        const data = JSON.parse(ev.target.result);
        if (data.state){
          LOCS.forEach(n=>{
            if (data.state[n]){
              Object.assign(state[n], data.state[n]);
              state[n].preAlertPlayed = false;
              saveLoc(n);
            }
          });
        }
        if (data.stats) Object.assign(stats, data.stats);
        if (data.activeLoc && LOCS.includes(data.activeLoc)){
          setActiveLocation(data.activeLoc, "import");
        }
        if (data.startTs) startTs = data.startTs;
        saveStats();
        paintAll();
        safeOverlay("Data imported", 1500);
      }catch(err){
        alert("Failed to import: " + err.message);
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

// Bind export/import if buttons exist
const exportBtn = el("exportData");
const importBtn = el("importData");
const resetStatsBtn = el("resetStats");
if (exportBtn) exportBtn.onclick = exportData;
if (importBtn) importBtn.onclick = importData;
if (resetStatsBtn){
  resetStatsBtn.onclick = () => {
    if (confirm("Reset all stats? This cannot be undone.")){
      stats.totalLogs = 0;
      stats.totalXP = 0;
      stats.totalChops = 0;
      startTs = Date.now();
      saveStats();
      paintAll();
      safeOverlay("Stats reset", 1000);
    }
  };
}

// ---------- audio alerts (WebAudio) ----------
let _ctx=null;
function beep(freq=1100, duration=0.36){
  if (!toggleSound.checked) return;
  try{
    _ctx = _ctx || new (window.AudioContext||window.webkitAudioContext)();
    const o = _ctx.createOscillator();
    const g = _ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(freq, _ctx.currentTime);
    g.gain.setValueAtTime(0.0001, _ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.2, _ctx.currentTime+0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, _ctx.currentTime+duration);
    o.connect(g); g.connect(_ctx.destination);
    o.start(); o.stop(_ctx.currentTime+duration);
  }catch(e){}
}
function beepCompletion(){
  // Triple beep for completion
  beep(800, 0.25);
  setTimeout(()=>beep(1000, 0.25), 150);
  setTimeout(()=>beep(1200, 0.4), 300);
}

// ---------- Alt1 setup ----------
a1lib.onready(() => {
  a1ready = true;
  inAlt1 = a1lib.detectAppMode && a1lib.detectAppMode() === "alt1";
  el("a1status").textContent = inAlt1 ? "Alt1 connected" : "Open in Alt1";
  if (inAlt1) initReaders();
  highlightActiveCard();
});
setTimeout(()=>{ if(!a1ready) el("a1status").textContent="Alt1 library not found"; }, 2000);

// ---------- chat + popup reading ----------
let chatReader = null;
function initReaders(){
  try{
    chatReader = new ChatboxReader();
    chatReader.find();
    setInterval(pollChat, 400);

    // Center popup OCR for depletion
    setInterval(checkCenterPopup, 900);

    // Area-name auto-detect (banner) + minimap fallback
    setInterval(autoDetectBanner, 2500);
    setInterval(autoDetectMinimap, 3000);
  }catch(e){ console.error(e); }
}

let lastLine = "";
function pollChat(){
  if (!chatReader) return;
  const res = chatReader.read();
  if (!res || !res.success) return;
  const all = res.text ?? res.lines?.map(l=>l.text).join("\n") ?? "";
  if (!all) return;

  const lines = all.split("\n").filter(Boolean);
  const line = lines[lines.length-1];
  if (!line || line === lastLine) return;
  lastLine = line;

  // Start 5m on start-chop message
  if (/\byou begin to swipe at the tree\b/i.test(line)){
    startChopTimer();
  }

  // Count logs
  if (/\byou get (some|an?) elder log/i.test(line) || (/You get/i.test(line) && /elder logs?/i.test(line))){
    state[activeLoc].logs++;
    stats.totalLogs++;
    saveLoc(activeLoc);
    saveStats();
    paintAll();
  }

  // Sum XP if line shows "+XX XP" messages
  const xpMatch = line.match(/\b(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s+XP\b/i);
  if (xpMatch){
    const val = parseFloat(xpMatch[1].replace(/,/g,""));
    if (!isNaN(val)){
      state[activeLoc].xp += val;
      stats.totalXP += val;
      saveLoc(activeLoc);
      saveStats();
      paintAll();
    }
  }
}

async function checkCenterPopup(){
  if (!inAlt1) return;
  try{
    const rs = a1lib.getRuneScapeRect && a1lib.getRuneScapeRect();
    if (!rs) return;
    const cx = rs.x + rs.width/2, cy = rs.y + rs.height/2;
    const rect = { x: Math.floor(cx-210), y: Math.floor(cy-70), width: 420, height: 140 };
    const img = a1lib.capture(rect);
    if (!img) return;
    const ocr = await a1lib.ocrRead(img);
    const text = (ocr?.text || "").trim();
    if (/no branches.*regrow shortly/i.test(text)){
      startCooldown();
    }
  }catch(e){}
}

// ---------- auto location detect ----------
let lastAutoTs = 0;
async function autoDetectBanner(){
  if (!inAlt1) return;
  try{
    const rs = a1lib.getRuneScapeRect && a1lib.getRuneScapeRect();
    if (!rs) return;
    const rect = { x: rs.x + 70, y: rs.y + 50, width: 360, height: 90 };
    const img = a1lib.capture(rect);
    if (!img) return;
    const ocr = await a1lib.ocrRead(img);
    const raw = (ocr?.text || "").toLowerCase();
    const loc = matchLocation(raw);
    if (loc){ setActiveLocation(loc, "banner"); }
    else if (Date.now() - lastAutoTs > 5000){ el("autoDetect").textContent = "auto: idle…"; }
  }catch(e){}
}
async function autoDetectMinimap(){
  if (!inAlt1) return;
  try{
    const rs = a1lib.getRuneScapeRect && a1lib.getRuneScapeRect();
    if (!rs) return;
    const rect = { x: rs.x + rs.width - 330, y: rs.y + 70, width: 320, height: 110 };
    const img = a1lib.capture(rect);
    if (!img) return;
    const ocr = await a1lib.ocrRead(img);
    const raw = (ocr?.text || "").toLowerCase();
    const loc = matchLocation(raw);
    if (loc){ setActiveLocation(loc, "minimap"); }
  }catch(e){}
}
function matchLocation(rawLower){
  if (!rawLower) return null;
  const hits = LOCS.map(n=>{
    const key = n.toLowerCase();
    const score = rawLower.includes(key) ? 2 :
      rawLower.replace(/[^a-z]/g,"").includes(key.replace(/[^a-z]/g,"")) ? 1 : 0;
    return { n, score };
  }).sort((a,b)=>b.score-a.score);
  return hits[0].score > 0 ? hits[0].n : null;
}
function setActiveLocation(loc, source){
  if (loc !== activeLoc){
    activeLoc = loc;
    localStorage.setItem("elder_loc", loc);
    locSel.value = loc;
    locTitle.textContent = loc;
    highlightActiveCard();
    paintAll();
    safeOverlay(`Location: ${loc} (${source})`, 1500);
  }
  el("autoDetect").textContent = `auto: ✔ ${loc} (${source})`;
  lastAutoTs = Date.now();
}
function highlightActiveCard(){
  LOCS.forEach(n=>{
    const card = document.getElementById(`card-${n}`);
    if (!card) return;
    card.classList.toggle("active", n===activeLoc);
  });
}

// ---------- per-location timers ----------
function startChopTimer(){
  const s = state[activeLoc];
  s.chopEnd = Date.now() + 5*60*1000;
  s.preAlertPlayed = false;
  stats.totalChops++;
  saveLoc(activeLoc);
  saveStats();
  safeOverlay("Chop 5:00 started", 900);
}
function startCooldown(){
  const s = state[activeLoc];
  s.coolEnd = Date.now() + 10*60*1000;
  s.chopEnd = 0;
  s.preAlertPlayed = false;
  saveLoc(activeLoc);
  safeOverlay("Cooldown 10:00 started", 900);
}
function saveLoc(loc){
  const s = state[loc];
  Object.entries(s).forEach(([k,v]) => {
    if (k==="preAlertPlayed") return;
    localStorage.setItem(`elder_${loc}_${k}`, String(v));
  });
}
function saveStats(){
  Object.entries(stats).forEach(([k,v]) => {
    localStorage.setItem(`elder_stats_${k}`, String(v));
  });
  localStorage.setItem("elder_startTs", String(startTs));
}

// ---------- overlay + paint ----------
function paintAll(){
  const now = Date.now();
  const preAlertSecs = Math.max(1, Math.min(60, Number(preAlertInput.value)||10));

  LOCS.forEach(loc=>{
    const s = state[loc];
    const chopLeft = s.chopEnd ? Math.max(0, Math.floor((s.chopEnd - now)/1000)) : 0;
    const coolLeft = s.coolEnd ? Math.max(0, Math.floor((s.coolEnd - now)/1000)) : 0;

    el(`${loc}-chop`).textContent = s.chopEnd ? fmtMMSS(chopLeft) : "—:—";
    el(`${loc}-cool`).textContent = s.coolEnd ? fmtMMSS(coolLeft) : "—:—";
    el(`${loc}-logs`).textContent = String(s.logs);
    el(`${loc}-xp`).textContent = Math.round(s.xp).toLocaleString();

    // Finish notifications
    if (s.chopEnd && chopLeft===0){
      s.chopEnd=0;
      s.preAlertPlayed=false;
      saveLoc(loc);
      if (loc===activeLoc){
        beepCompletion();
        safeOverlay("Chop timer done! Tree depleted", 2000);
      }
    }
    if (s.coolEnd && coolLeft===0){
      s.coolEnd=0;
      saveLoc(loc);
      if (loc===activeLoc){
        beepCompletion();
        safeOverlay("Cooldown done! Tree ready", 2000);
      }
    }

    // Pre-alert (only for current location’s chop timer)
    if (loc===activeLoc && s.chopEnd && chopLeft<=preAlertSecs && !s.preAlertPlayed){
      s.preAlertPlayed = true;
      beep();
      safeOverlay(`Chop ending in ${chopLeft}s`, 1200);
    }
  });

  // Uptime
  el("uptime").textContent = fmtHMS(Date.now() - startTs);

  // Update stats if elements exist
  const totalLogsEl = el("totalLogs");
  const totalXPEl = el("totalXP");
  const totalChopsEl = el("totalChops");
  if (totalLogsEl) totalLogsEl.textContent = stats.totalLogs.toLocaleString();
  if (totalXPEl) totalXPEl.textContent = Math.round(stats.totalXP).toLocaleString();
  if (totalChopsEl) totalChopsEl.textContent = stats.totalChops.toLocaleString();

  // HUD (current location only)
  if (toggleHud.checked && inAlt1){
    const s = state[activeLoc];
    const chopLeft = s.chopEnd ? Math.max(0, Math.floor((s.chopEnd - now)/1000)) : 0;
    const coolLeft = s.coolEnd ? Math.max(0, Math.floor((s.coolEnd - now)/1000)) : 0;
    const lines = [
      `Elder — ${activeLoc}`,
      `Chop: ${s.chopEnd ? fmtMMSS(chopLeft) : "--:--"} | Cool: ${s.coolEnd ? fmtMMSS(coolLeft) : "--:--"}`
    ];
    try{
      a1lib.overlay.clear && a1lib.overlay.clear();
      a1lib.overlay.text(lines.join("\n"), {color:"#7dd3fc", width:2, font:"16px Segoe UI"});
    }catch(_){}
  } else if (inAlt1 && a1lib.overlay && a1lib.overlay.clear){
    a1lib.overlay.clear();
  }
}
function safeOverlay(msg, ms){
  if (!inAlt1) return;
  try{ a1lib.overlay && a1lib.overlay.text(msg, {color:"#7dd3fc", width:2}, ms||1200); }catch(_){}
}

// steady refresh
setInterval(paintAll, 250);
paintAll();
