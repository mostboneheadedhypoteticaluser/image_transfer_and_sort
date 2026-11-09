export const REMOTE_START_PAGE = String.raw`<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#0b0d10">
  <title>Image Sortierer</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:#0b0d10;
      color:#f5f7fa;
      --bg:#0b0d10;
      --panel:#13171c;
      --panel2:#191e25;
      --line:#29313b;
      --muted:#96a0ad;
      --good:#5edd8b;
      --warn:#f0c36b;
      --bad:#ff7b7b;
      --accent:#f4f5f7;
    }
    * { box-sizing:border-box; }
    html,body { margin:0; min-height:100%; background:var(--bg); }
    body { min-height:100vh; min-height:100dvh; }
    button,input,select { font:inherit; }
    button { cursor:pointer; }
    .app { width:min(1180px,100%); margin:0 auto; min-height:100dvh; padding-bottom:86px; }
    header {
      position:sticky; top:0; z-index:20;
      padding:12px max(14px,env(safe-area-inset-left));
      border-bottom:1px solid rgba(255,255,255,.07);
      background:rgba(11,13,16,.92); backdrop-filter:blur(18px);
      display:flex; align-items:center; justify-content:space-between; gap:12px;
    }
    .brand { display:flex; align-items:center; gap:10px; min-width:0; }
    .brand strong { font-size:17px; }
    .status-dot { width:9px; height:9px; border-radius:50%; background:var(--warn); box-shadow:0 0 0 4px rgba(240,195,107,.12); flex:0 0 auto; }
    .status-dot.ok { background:var(--good); box-shadow:0 0 0 4px rgba(94,221,139,.12); }
    .status-dot.bad { background:var(--bad); box-shadow:0 0 0 4px rgba(255,123,123,.12); }
    .header-status { color:var(--muted); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .view { display:none; padding:14px; }
    .view.active { display:block; }
    .section-head { display:flex; justify-content:space-between; align-items:center; gap:10px; margin:4px 0 14px; }
    .section-head h1 { margin:0; font-size:24px; letter-spacing:-.02em; }
    .section-head p { margin:3px 0 0; color:var(--muted); font-size:13px; }
    .toolbar { display:grid; grid-template-columns:1fr auto; gap:8px; margin-bottom:12px; }
    .toolbar.three { grid-template-columns:1fr 1fr auto; }
    select,input[type="search"],input[type="text"] {
      width:100%; min-width:0; border:1px solid var(--line); border-radius:11px;
      background:var(--panel); color:#fff; padding:11px 12px; outline:none;
    }
    input:focus,select:focus { border-color:#697586; }
    .btn {
      border:1px solid var(--line); border-radius:11px; padding:10px 13px;
      background:var(--panel2); color:#fff; font-weight:700;
    }
    .btn.primary { background:#f4f5f7; color:#0b0d10; border-color:#f4f5f7; }
    .btn.good { border-color:rgba(94,221,139,.45); color:#8ff0ae; }
    .btn.warn { border-color:rgba(240,195,107,.45); color:#f6d792; }
    .btn.bad { border-color:rgba(255,123,123,.45); color:#ff9b9b; }
    .btn:disabled { opacity:.5; cursor:wait; }
    .cards { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px; }
    .media-card {
      border:1px solid var(--line); border-radius:13px; overflow:hidden; background:var(--panel);
      color:inherit; text-align:left; padding:0;
    }
    .thumb-wrap { position:relative; aspect-ratio:1/1; background:#080a0d; overflow:hidden; }
    .thumb-wrap img { width:100%; height:100%; object-fit:cover; display:block; }
    .thumb-placeholder { width:100%; height:100%; display:grid; place-items:center; color:#596372; font-size:28px; }
    .badge {
      display:inline-flex; align-items:center; border:1px solid rgba(255,255,255,.12);
      background:rgba(10,12,15,.72); border-radius:999px; padding:3px 7px; font-size:10px; color:#dde2e8;
    }
    .thumb-badges { position:absolute; left:6px; bottom:6px; display:flex; gap:5px; flex-wrap:wrap; }
    .media-copy { padding:9px; min-width:0; }
    .media-name { font-size:12px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .media-meta { margin-top:4px; font-size:10px; color:var(--muted); display:flex; justify-content:space-between; gap:5px; }
    .empty { padding:28px 16px; text-align:center; color:var(--muted); border:1px dashed var(--line); border-radius:14px; }
    .metric-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:9px; margin-bottom:12px; }
    .metric { border:1px solid var(--line); background:var(--panel); border-radius:13px; padding:13px; }
    .metric strong { display:block; font-size:25px; letter-spacing:-.03em; }
    .metric span { display:block; color:var(--muted); font-size:11px; margin-top:4px; }
    .panel { border:1px solid var(--line); background:var(--panel); border-radius:14px; overflow:hidden; margin-bottom:12px; }
    .panel-title { padding:13px; font-weight:800; border-bottom:1px solid var(--line); }
    .stage-row { display:grid; grid-template-columns:minmax(0,1.6fr) repeat(4,minmax(44px,.55fr)); gap:6px; align-items:center; padding:10px 12px; border-bottom:1px solid rgba(255,255,255,.06); font-size:11px; }
    .stage-row:last-child { border-bottom:0; }
    .stage-row.head { color:var(--muted); font-size:10px; text-transform:uppercase; letter-spacing:.04em; }
    .stage-row strong { font-size:12px; }
    .pill { border-radius:999px; padding:4px 7px; background:#20262e; display:inline-block; }
    .pill.good { color:#90efad; }
    .pill.warn { color:#f5d18a; }
    .pill.bad { color:#ff9c9c; }
    .candidate-list { display:grid; gap:10px; }
    .candidate {
      border:1px solid var(--line); border-radius:14px; padding:11px; background:var(--panel);
      display:grid; grid-template-columns:78px minmax(0,1fr); gap:11px;
    }
    .candidate img { width:78px; height:78px; object-fit:cover; border-radius:11px; background:#090b0e; }
    .candidate-info { min-width:0; }
    .candidate-info h3 { margin:0 0 3px; font-size:15px; }
    .candidate-info p { margin:0 0 8px; color:var(--muted); font-size:11px; }
    .candidate-actions { display:grid; grid-template-columns:1fr auto auto; gap:6px; }
    .candidate-actions input { padding:8px 9px; font-size:12px; }
    .candidate-actions .btn { padding:8px 9px; font-size:11px; }
    .candidate-review-button { width:100%; margin-top:7px; padding:7px 9px; font-size:11px; }
    .group-review-dialog { width:min(900px,100%); }
    .group-review-body { padding:12px 12px 118px; }
    .group-review-tools { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; margin-bottom:10px; }
    .group-review-tools input { padding:10px 11px; }
    .group-review-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:7px; }
    .group-review-item {
      position:relative; aspect-ratio:1; padding:0; overflow:hidden;
      border:2px solid rgba(94,221,139,.62); border-radius:10px; background:#07090b;
    }
    .group-review-item img { width:100%; height:100%; object-fit:cover; display:block; }
    .group-review-item.excluded { border-color:rgba(255,123,123,.8); opacity:.55; }
    .group-review-item.excluded::after {
      content:"×"; position:absolute; inset:0; display:grid; place-items:center;
      background:rgba(70,5,5,.32); color:#ff9b9b; font-size:34px; font-weight:900;
    }
    .group-review-more { min-height:54px; display:grid; place-items:center; color:var(--muted); font-size:11px; }
    .group-review-footer {
      position:fixed; left:auto; right:0; bottom:0; z-index:6; width:min(900px,100%);
      border-top:1px solid var(--line); background:rgba(13,16,20,.97); backdrop-filter:blur(14px);
      padding:10px 12px calc(10px + env(safe-area-inset-bottom));
      display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; align-items:center;
    }
    .group-review-footer small { color:var(--muted); display:block; margin-top:3px; }
    .group-review-footer .btn { white-space:nowrap; }
    .candidate-pager {
      display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:8px;
      align-items:center; margin:12px 0 2px;
    }
    .candidate-pager .btn { min-width:92px; }
    .candidate-page-info { text-align:center; color:var(--muted); font-size:11px; line-height:1.35; }
    .candidate-page-info strong { display:block; color:#fff; font-size:12px; }
    .subtabs { display:flex; gap:7px; overflow:auto; margin-bottom:12px; }
    .subtabs .btn.active { background:#f4f5f7; color:#0b0d10; border-color:#f4f5f7; }
    .history-bars { display:flex; align-items:flex-end; gap:7px; height:150px; padding:16px 10px 8px; overflow-x:auto; }
    .bar-item { min-width:38px; height:100%; display:flex; flex-direction:column; justify-content:flex-end; align-items:center; gap:5px; }
    .bar { width:28px; min-height:3px; border-radius:7px 7px 2px 2px; background:#e7ebef; }
    .bar-label { font-size:9px; color:var(--muted); white-space:nowrap; }
    .bar-value { font-size:9px; color:#dfe4e9; }
    .history-day { padding:11px 12px; border-bottom:1px solid rgba(255,255,255,.06); }
    .history-day:last-child { border-bottom:0; }
    .history-day-head { display:flex; justify-content:space-between; gap:10px; margin-bottom:7px; }
    .history-day-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:5px 10px; color:var(--muted); font-size:10px; }
    .history-day-grid span { display:flex; justify-content:space-between; gap:8px; }
    .more-row { display:flex; justify-content:space-between; gap:12px; padding:12px; border-bottom:1px solid rgba(255,255,255,.06); font-size:12px; }
    .more-row:last-child { border-bottom:0; }
    .more-row span:first-child { color:var(--muted); }
    nav {
      position:fixed; left:0; right:0; bottom:0; z-index:30;
      padding:7px max(8px,env(safe-area-inset-left)) calc(7px + env(safe-area-inset-bottom));
      background:rgba(13,16,20,.96); backdrop-filter:blur(18px); border-top:1px solid rgba(255,255,255,.08);
      display:grid; grid-template-columns:repeat(5,1fr); gap:3px;
    }
    nav button { border:0; background:transparent; color:#87919e; padding:7px 3px 5px; border-radius:10px; font-size:10px; font-weight:700; }
    nav button span { display:block; font-size:18px; margin-bottom:2px; }
    nav button.active { color:#fff; background:#1b2128; }
    dialog {
      width:min(760px,100%); max-width:none; height:100dvh; max-height:none; margin:0 0 0 auto;
      border:0; border-left:1px solid var(--line); padding:0; background:#0d1014; color:#fff;
    }
    dialog::backdrop { background:rgba(0,0,0,.72); }
    .detail-head { position:sticky; top:0; z-index:4; background:rgba(13,16,20,.95); backdrop-filter:blur(14px); border-bottom:1px solid var(--line); padding:11px; display:flex; align-items:center; justify-content:space-between; gap:8px; }
    .detail-body { padding:12px 12px 40px; }
    .detail-media { width:100%; max-height:58vh; object-fit:contain; background:#050607; border-radius:12px; display:block; }
    .detail-title { margin:12px 0 4px; font-size:16px; overflow-wrap:anywhere; }
    .detail-sub { color:var(--muted); font-size:11px; margin-bottom:12px; }
    .identity-row { display:grid; grid-template-columns:58px minmax(0,1fr); gap:9px; padding:9px 0; border-bottom:1px solid rgba(255,255,255,.06); }
    .identity-row img { width:58px; height:58px; object-fit:cover; border-radius:9px; background:#050607; }
    .identity-control { display:grid; grid-template-columns:1fr auto; gap:6px; margin-top:5px; }
    .identity-control input { padding:8px; font-size:12px; }
    .identity-control .btn { padding:7px 9px; font-size:11px; }
    .scene { border:1px solid var(--line); border-radius:12px; padding:8px; margin-top:9px; background:#11151a; }
    .scene img { width:100%; border-radius:9px; display:block; }
    .scene-time { margin:6px 0; color:var(--muted); font-size:11px; }
    .loading { opacity:.6; pointer-events:none; }
    .toast { position:fixed; left:50%; bottom:92px; z-index:80; transform:translateX(-50%) translateY(20px); opacity:0; transition:.18s; padding:10px 13px; border-radius:999px; background:#f4f5f7; color:#0b0d10; font-size:12px; font-weight:800; pointer-events:none; max-width:calc(100% - 30px); text-align:center; }
    .toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
    @media (min-width:700px) {
      .view { padding:22px; }
      .cards { grid-template-columns:repeat(4,minmax(0,1fr)); }
      .metric-grid { grid-template-columns:repeat(4,minmax(0,1fr)); }
      nav { left:50%; right:auto; width:min(620px,100%); transform:translateX(-50%); border:1px solid var(--line); border-bottom:0; border-radius:16px 16px 0 0; }
    }
  </style>
</head>
<body>
<div class="app">
  <header>
    <div class="brand"><span id="statusDot" class="status-dot"></span><strong>Image Sortierer</strong></div>
    <div id="headerStatus" class="header-status">Verbindung wird geprüft …</div>
  </header>

  <main>
    <section id="view-media" class="view active">
      <div class="section-head"><div><h1>Medien</h1><p>Bilder und Videos ansehen und herunterladen</p></div><button id="mediaRefresh" class="btn">↻</button></div>
      <div class="toolbar three">
        <select id="sourceSelect" aria-label="Quelle"></select>
        <select id="kindSelect" aria-label="Medientyp"><option value="all">Alle</option><option value="image">Bilder</option><option value="video">Videos</option></select>
        <button id="loadMedia" class="btn primary">Laden</button>
      </div>
      <input id="mediaFilter" type="search" placeholder="In geladenen Medien filtern …" style="margin-bottom:12px">
      <div id="mediaGrid" class="cards"></div>
    </section>

    <section id="view-confirm" class="view">
      <div class="section-head"><div><h1>Bestätigen</h1><p>Personen und Tiere zuordnen</p></div><button id="confirmRefresh" class="btn">↻</button></div>
      <div class="subtabs"><button class="btn active" data-confirm-mode="people">Personen</button><button class="btn" data-confirm-mode="pets">Tiere</button></div>
      <div id="candidateSummary" class="metric-grid"></div>
      <div id="candidateList" class="candidate-list"></div>
      <div id="candidatePager" class="candidate-pager" hidden>
        <button id="candidatePrev" class="btn" type="button">← Zurück</button>
        <div id="candidatePageInfo" class="candidate-page-info"></div>
        <button id="candidateNext" class="btn" type="button">Weiter →</button>
      </div>
    </section>

    <section id="view-analysis" class="view">
      <div class="section-head"><div><h1>Analyse</h1><p>Warteschlange und Leistung steuern</p></div><button id="analysisRefresh" class="btn">↻</button></div>
      <div id="analysisMetrics" class="metric-grid"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
        <button id="boostButton" class="btn good">Boost</button>
        <button id="pauseButton" class="btn warn">Pause</button>
      </div>
      <div class="panel">
        <div class="stage-row head"><span>Schritt</span><span>Offen</span><span>Läuft</span><span>Fertig</span><span>Fehler</span></div>
        <div id="stageRows"></div>
      </div>
    </section>

    <section id="view-history" class="view">
      <div class="section-head"><div><h1>Verlauf</h1><p>Erledigte Analyseschritte pro Tag</p></div><button id="historyRefresh" class="btn">↻</button></div>
      <div class="subtabs">
        <button class="btn" data-history-days="3">3 Tage</button>
        <button class="btn active" data-history-days="7">7 Tage</button>
        <button class="btn" data-history-days="30">30 Tage</button>
      </div>
      <div class="panel"><div id="historyBars" class="history-bars"></div></div>
      <div id="historyDays" class="panel"></div>
    </section>

    <section id="view-more" class="view">
      <div class="section-head"><div><h1>Mehr</h1><p>Status der lokalen Image-Sortierer-App</p></div></div>
      <div id="morePanel" class="panel"></div>
      <div class="panel"><div class="panel-title">Verbindungstest</div><div style="padding:12px"><button id="pingButton" class="btn primary">Testdaten senden</button><div id="pingResult" style="margin-top:9px;color:var(--muted);font-size:11px">Noch kein Test gesendet.</div></div></div>
    </section>
  </main>
</div>

<nav>
  <button class="active" data-view="media"><span>▦</span>Medien</button>
  <button data-view="confirm"><span>✓</span>Bestätigen</button>
  <button data-view="analysis"><span>⚙</span>Analyse</button>
  <button data-view="history"><span>▥</span>Verlauf</button>
  <button data-view="more"><span>•••</span>Mehr</button>
</nav>

<dialog id="detailDialog">
  <div class="detail-head"><strong>Medium</strong><div><a id="downloadLink" class="btn primary" style="text-decoration:none;display:inline-block" href="#">Download</a> <button id="detailClose" class="btn">Schließen</button></div></div>
  <div id="detailBody" class="detail-body"></div>
</dialog>

<dialog id="groupReviewDialog" class="group-review-dialog">
  <div class="detail-head"><strong id="groupReviewTitle">Gruppe prüfen</strong><button id="groupReviewClose" class="btn">Schließen</button></div>
  <div class="group-review-body">
    <div class="group-review-tools">
      <input id="groupReviewName" type="text" placeholder="Name" autocomplete="off">
      <button id="groupReviewSelectAll" class="btn" type="button">Alle auswählen</button>
    </div>
    <div id="groupReviewGrid" class="group-review-grid"></div>
    <div id="groupReviewMore" class="group-review-more"></div>
  </div>
  <div class="group-review-footer">
    <div><strong id="groupReviewCount">0 ausgewählt</strong><small>Falsche Bilder antippen, um sie auszuschließen.</small></div>
    <button id="groupReviewConfirm" class="btn good" type="button">Auswahl bestätigen</button>
  </div>
</dialog>
<div id="toast" class="toast"></div>
<datalist id="personNames"></datalist>
<datalist id="petNames"></datalist>

<script>
(function(){
  "use strict";
  var state = {
    sources: [], media: [], filteredMedia: [], people: null, pets: null,
    identityOptions: null, status: null, summary: null, history: null,
    confirmMode: "people", confirmPage: {people:0,pets:0}, confirmPageSize: 10,
    groupReview: null, historyDays: 7, activeView: "media"
  };
  var fmt = new Intl.NumberFormat("de-DE");
  var moduleLabels = {
    "file-probe-v1":"Technische Prüfung",
    "thumbnail-v1":"Thumbnail",
    "image-metadata-v1":"Bildmetadaten",
    "face-detect-yunet-v1":"Gesichtsdetektion",
    "face-embed-sface-v1":"Gesichtsmerkmale",
    "pet-detect-nanodet-v1":"Haustiere · NanoDet",
    "pet-detect-yolox-v1":"Haustiere · YOLOX-S",
    "pet-fuse-ensemble-v1":"Haustier-Fusion",
    "pet-embed-dogreid-v1":"Hundemerkmale",
    "semantic-embed-siglip2-v1":"SigLIP2",
    "catalog-semantic-qwen3vl4b-v3":"Qwen3-VL",
    "video-analyze-v1":"Videoanalyse"
  };
  var moduleOrder = Object.keys(moduleLabels);
  var stageLabels = {
    technical:"Technische Prüfung",
    thumbnails:"Thumbnail",
    imageMetadata:"Bildmetadaten",
    faces:"Gesichtsdetektion",
    faceEmbeddings:"Gesichtsmerkmale",
    petDetection:"Haustiererkennung",
    petFusion:"Haustier-Fusion",
    petEmbeddings:"Hundemerkmale",
    semanticEmbeddings:"SigLIP2",
    objectVerification:"Qwen3-VL",
    videoAnalysis:"Videoanalyse"
  };
  var stageOrder = Object.keys(stageLabels);
  var el = function(id){ return document.getElementById(id); };
  var escapeHtml = function(value){
    return String(value == null ? "" : value)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;").replace(/'/g,"&#039;");
  };
  var basename = function(p){ var parts=String(p||"").replace(/\\/g,"/").split("/"); return parts[parts.length-1] || p || ""; };
  var fileSize = function(bytes){
    var n=Number(bytes)||0; if(n<1024) return n+" B"; if(n<1048576) return (n/1024).toFixed(1)+" KB";
    if(n<1073741824) return (n/1048576).toFixed(1)+" MB"; return (n/1073741824).toFixed(1)+" GB";
  };
  var toastTimer = null;
  function toast(message){
    var t=el("toast"); t.textContent=message; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer=setTimeout(function(){t.classList.remove("show");},2200);
  }
  async function api(url, options){
    var response = await fetch(url, Object.assign({cache:"no-store"}, options||{}));
    if(!response.ok){
      var text = await response.text().catch(function(){return "";});
      throw new Error(text || ("HTTP "+response.status));
    }
    var type=response.headers.get("content-type")||"";
    return type.indexOf("application/json")>=0 ? response.json() : response.text();
  }
  async function apiPost(url, body){
    return api(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body||{})});
  }
  function setConnection(ok, text){
    el("statusDot").className="status-dot "+(ok?"ok":"bad");
    el("headerStatus").textContent=text;
  }
  function switchView(name){
    state.activeView=name;
    document.querySelectorAll(".view").forEach(function(v){v.classList.toggle("active",v.id==="view-"+name);});
    document.querySelectorAll("nav button").forEach(function(b){b.classList.toggle("active",b.getAttribute("data-view")===name);});
    if(name==="confirm") loadCandidates(false);
    if(name==="analysis") refreshStatus();
    if(name==="history") loadHistory();
    if(name==="more") loadSummary().catch(function(e){toast(e.message);});
  }
  document.querySelectorAll("nav button").forEach(function(b){b.addEventListener("click",function(){switchView(b.getAttribute("data-view"));});});

  async function loadSources(){
    state.sources=await api("/api/sources");
    var select=el("sourceSelect");
    select.innerHTML=state.sources.filter(function(s){return s.enabled;}).map(function(s){
      return '<option value="'+s.id+'">'+escapeHtml(basename(s.path))+'</option>';
    }).join("");
    if(!select.value && state.sources.length){ select.value=String(state.sources[0].id); }
  }

  function mediaKind(item){
    var ext=String(item.extension||"").toLowerCase();
    return [".mp4",".mov",".m4v",".avi",".mkv",".webm",".mts",".m2ts"].indexOf(ext)>=0?"video":"image";
  }
  function renderMedia(){
    var q=el("mediaFilter").value.trim().toLowerCase();
    state.filteredMedia=state.media.filter(function(m){return !q || String(m.relativePath).toLowerCase().indexOf(q)>=0;});
    var grid=el("mediaGrid");
    if(!state.filteredMedia.length){grid.innerHTML='<div class="empty" style="grid-column:1/-1">Keine Medien in dieser Auswahl.</div>';return;}
    grid.innerHTML=state.filteredMedia.map(function(m){
      var kind=mediaKind(m);
      var badges=[];
      if(kind==="video") badges.push('<span class="badge">▶ Video</span>');
      if(m.faceCount) badges.push('<span class="badge">☺ '+fmt.format(m.faceCount)+'</span>');
      if(m.petCount) badges.push('<span class="badge">🐾 '+fmt.format(m.petCount)+'</span>');
      var image=m.thumbnailReady?'<img loading="lazy" src="/api/media/'+m.id+'/thumbnail?v='+encodeURIComponent(m.thumbnailVersion||"")+'" alt="">':'<div class="thumb-placeholder">'+(kind==="video"?"▶":"▧")+'</div>';
      return '<button class="media-card" data-media-id="'+m.id+'"><div class="thumb-wrap">'+image+'<div class="thumb-badges">'+badges.join("")+'</div></div><div class="media-copy"><div class="media-name">'+escapeHtml(basename(m.relativePath))+'</div><div class="media-meta"><span>'+fileSize(m.sizeBytes)+'</span><span>'+escapeHtml(m.analysisStageStatus||"")+'</span></div></div></button>';
    }).join("");
    grid.querySelectorAll("[data-media-id]").forEach(function(b){b.addEventListener("click",function(){openDetail(Number(b.getAttribute("data-media-id")));});});
  }
  async function loadMedia(){
    var sourceId=Number(el("sourceSelect").value);
    if(!sourceId) return;
    el("mediaGrid").innerHTML='<div class="empty" style="grid-column:1/-1">Medien werden geladen …</div>';
    state.media=await api("/api/media?sourceId="+sourceId+"&kind="+encodeURIComponent(el("kindSelect").value)+"&limit=300");
    renderMedia();
  }
  el("mediaFilter").addEventListener("input",renderMedia);
  el("loadMedia").addEventListener("click",function(){loadMedia().catch(function(e){toast(e.message);});});
  el("mediaRefresh").addEventListener("click",function(){loadMedia().catch(function(e){toast(e.message);});});

  function nameLists(){
    var options=state.identityOptions||{}, people=options.people||[], pets=options.pets||[];
    el("personNames").innerHTML=people.map(function(p){return '<option value="'+escapeHtml(p.name)+'"></option>';}).join("");
    el("petNames").innerHTML=pets.map(function(p){return '<option value="'+escapeHtml(p.name)+'"></option>';}).join("");
  }
  async function ensureIdentityLists(force){
    if(force||!state.identityOptions) state.identityOptions=await api("/api/identity-options");
    nameLists();
  }
  function identityRows(details){
    var rows=[];
    (details.faces||[]).forEach(function(f){
      var suggestion=f.personName || (f.suggestedPersons&&f.suggestedPersons[0]&&f.suggestedPersons[0].personName) || "";
      rows.push('<div class="identity-row"><img src="/api/face/'+f.id+'" alt=""><div><strong>Person</strong><div style="color:var(--muted);font-size:10px;margin-top:2px">'+(f.personName?escapeHtml(f.personName):"noch nicht bestätigt")+'</div><div class="identity-control"><input data-identity-name="person-'+f.id+'" list="personNames" value="'+escapeHtml(suggestion)+'" placeholder="Name"><button class="btn good" data-assign-kind="person" data-detection-id="'+f.id+'">Speichern</button></div></div></div>');
    });
    (details.pets||[]).forEach(function(p){
      var suggestion=p.petName || (p.suggestedPets&&p.suggestedPets[0]&&p.suggestedPets[0].petName) || "";
      rows.push('<div class="identity-row"><img src="/api/pet/'+p.id+'" alt=""><div><strong>'+(p.petClass==="cat"?"Katze":"Hund")+'</strong><div style="color:var(--muted);font-size:10px;margin-top:2px">'+(p.petName?escapeHtml(p.petName):"noch nicht bestätigt")+'</div><div class="identity-control"><input data-identity-name="pet-'+p.id+'" list="petNames" value="'+escapeHtml(suggestion)+'" placeholder="Name"><button class="btn good" data-assign-kind="pet" data-detection-id="'+p.id+'">Speichern</button></div></div></div>');
    });
    return rows.join("");
  }
  function sceneRows(details){
    if(!details.videoAnalysis||!details.videoAnalysis.frames) return "";
    var frames=details.videoAnalysis.frames.filter(function(f){return f.detections&&f.detections.length;}).slice(0,60);
    if(!frames.length) return "";
    return '<div class="panel-title" style="margin-top:14px">Szenen mit Personen/Tieren</div>'+frames.map(function(frame){
      var query="ms="+frame.timestampMs+"&width=720";
      if(frame.frameIndex!=null) query+="&i="+frame.frameIndex;
      if(frame.frameHash) query+="&h="+encodeURIComponent(frame.frameHash);
      var controls=frame.detections.map(function(d){
        var list=d.kind==="person"?"personNames":"petNames";
        return '<div class="identity-control"><input list="'+list+'" data-video-name="'+details.mediaId+'-'+frame.timestampMs+'-'+d.kind+'-'+d.detectionIndex+'" value="'+escapeHtml(d.name||"")+'" placeholder="'+(d.kind==="person"?"Person":"Tier")+'"><button class="btn good" data-video-assign="1" data-media-id="'+details.mediaId+'" data-time="'+frame.timestampMs+'" data-kind="'+d.kind+'" data-index="'+d.detectionIndex+'" data-pet-class="'+escapeHtml(d.petClass||"")+'">Speichern</button></div>';
      }).join("");
      return '<div class="scene"><img loading="lazy" src="/api/video/'+details.mediaId+'/frame?'+query+'" alt=""><div class="scene-time">'+Math.round(frame.timestampMs/100)/10+' s</div>'+controls+'</div>';
    }).join("");
  }
  async function openDetail(mediaId){
    var dialog=el("detailDialog"), body=el("detailBody");
    body.innerHTML='<div class="empty">Details werden geladen …</div>';
    dialog.showModal();
    try{
      await ensureIdentityLists();
      var details=await api("/api/media/"+mediaId+"/details");
      var kind=String(details.extension||"").toLowerCase();
      var isVideo=[".mp4",".mov",".m4v",".avi",".mkv",".webm",".mts",".m2ts"].indexOf(kind)>=0;
      el("downloadLink").href="/api/media/"+mediaId+"/content?download=1";
      var media=isVideo?'<video class="detail-media" controls preload="metadata" src="/api/media/'+mediaId+'/content"></video>':'<img class="detail-media" src="/api/media/'+mediaId+'/preview" alt="">';
      var captured=details.imageMetadata&&details.imageMetadata.capturedAt?new Date(details.imageMetadata.capturedAt).toLocaleString("de-DE"):"—";
      var confirmable=(details.faces||[]).filter(function(f){return f.personName;}).length+(details.pets||[]).filter(function(p){return p.petName;}).length;
      body.innerHTML=media+'<h2 class="detail-title">'+escapeHtml(details.relativePath)+'</h2><div class="detail-sub">'+fileSize(details.sizeBytes)+' · Aufnahme '+escapeHtml(captured)+'</div>'+
        (confirmable?'<button class="btn good" id="confirmAllDetail" data-media-id="'+mediaId+'" style="width:100%;margin-bottom:10px">Alle vorhandenen Zuordnungen bestätigen</button>':'')+
        '<div class="panel"><div class="panel-title">Personen und Tiere</div><div style="padding:0 10px">'+(identityRows(details)||'<div class="empty" style="margin:10px 0">Keine Personen oder Tiere erkannt.</div>')+'</div></div>'+
        sceneRows(details);
      bindDetailActions();
    }catch(e){body.innerHTML='<div class="empty">Fehler: '+escapeHtml(e.message)+'</div>';}
  }
  function bindDetailActions(){
    document.querySelectorAll("[data-assign-kind]").forEach(function(b){b.addEventListener("click",async function(){
      var kind=b.getAttribute("data-assign-kind"), id=Number(b.getAttribute("data-detection-id"));
      var input=document.querySelector('[data-identity-name="'+kind+'-'+id+'"]');
      var name=input&&input.value?input.value.trim():""; if(!name){toast("Bitte einen Namen eingeben.");return;}
      b.disabled=true; try{await apiPost("/api/identity/assign",{kind:kind,detectionId:id,name:name}); state.identityOptions=null;toast("Zuordnung gespeichert.");}catch(e){toast(e.message);}finally{b.disabled=false;}
    });});
    document.querySelectorAll("[data-video-assign]").forEach(function(b){b.addEventListener("click",async function(){
      var mediaId=Number(b.getAttribute("data-media-id")), time=Number(b.getAttribute("data-time")), kind=b.getAttribute("data-kind"), index=Number(b.getAttribute("data-index"));
      var key=mediaId+"-"+time+"-"+kind+"-"+index, input=document.querySelector('[data-video-name="'+key+'"]');
      var name=input&&input.value?input.value.trim():""; if(!name){toast("Bitte einen Namen eingeben.");return;}
      b.disabled=true; try{await apiPost("/api/video/assign",{mediaId:mediaId,timestampMs:time,kind:kind,detectionIndex:index,petClass:b.getAttribute("data-pet-class")||null,name:name});toast("Szenen-Zuordnung gespeichert.");}catch(e){toast(e.message);}finally{b.disabled=false;}
    });});
    var all=el("confirmAllDetail"); if(all) all.addEventListener("click",async function(){
      all.disabled=true; try{var result=await apiPost("/api/media/"+all.getAttribute("data-media-id")+"/confirm-all",{});toast(fmt.format(result.confirmed)+" Zuordnungen bestätigt.");}catch(e){toast(e.message);}finally{all.disabled=false;}
    });
  }
  el("detailClose").addEventListener("click",function(){el("detailDialog").close();});

  function candidatePage(){
    return Math.max(0,Number(state.confirmPage[state.confirmMode])||0);
  }
  function candidateTotalPages(data){
    var total=Math.max(0,Number(data&&data.candidateTotal)||0);
    return Math.max(1,Math.ceil(total/state.confirmPageSize));
  }
  async function loadCandidates(refreshGrouping){
    var mode=state.confirmMode, page=candidatePage(), offset=page*state.confirmPageSize;
    el("candidateList").innerHTML='<div class="empty">Bestätigungen werden geladen …</div>';
    el("candidatePager").hidden=true;
    var query="?limit="+state.confirmPageSize+"&offset="+offset+(refreshGrouping?"&refresh=1":"");
    var data=await api("/api/"+mode+query);
    if(mode==="people") state.people=data; else state.pets=data;

    var totalPages=candidateTotalPages(data);
    if(page>=totalPages && page>0){
      state.confirmPage[mode]=totalPages-1;
      return loadCandidates(false);
    }
    renderCandidates();
    if(!state.identityOptions) {
      ensureIdentityLists(false).catch(function(){});
    }
  }
  function renderCandidates(){
    var isPeople=state.confirmMode==="people", data=isPeople?state.people:state.pets;
    var candidates=data&&data.candidates?data.candidates:[];
    var ungrouped=isPeople?(data?data.ungroupedFaceTotal:0):(data?data.ungroupedDetectionTotal:0);
    var detections=isPeople?(data?data.candidateFaceTotal:0):(data?data.candidateDetectionTotal:0);
    var groupTotal=Math.max(0,Number(data&&data.candidateTotal)||0);
    var page=candidatePage(), totalPages=candidateTotalPages(data);
    el("candidateSummary").innerHTML='<div class="metric"><strong>'+fmt.format(groupTotal)+'</strong><span>Gruppen offen</span></div><div class="metric"><strong>'+fmt.format(detections||0)+'</strong><span>Erkennungen in Gruppen</span></div><div class="metric"><strong>'+fmt.format(ungrouped||0)+'</strong><span>Noch ungruppiert</span></div><div class="metric"><strong>'+(data&&data.clusteringPending?"ja":"nein")+'</strong><span>Gruppierung läuft</span></div>';

    var pager=el("candidatePager");
    pager.hidden=groupTotal===0;
    el("candidatePrev").disabled=page<=0;
    el("candidateNext").disabled=page>=totalPages-1;
    var first=groupTotal===0?0:page*state.confirmPageSize+1;
    var last=Math.min(groupTotal,page*state.confirmPageSize+candidates.length);
    el("candidatePageInfo").innerHTML='<strong>Seite '+fmt.format(page+1)+' / '+fmt.format(totalPages)+'</strong>'+fmt.format(first)+'–'+fmt.format(last)+' von '+fmt.format(groupTotal)+' Gruppen';

    if(!candidates.length){el("candidateList").innerHTML='<div class="empty">Aktuell keine Kandidaten zu bestätigen.</div>';return;}
    el("candidateList").innerHTML=candidates.map(function(c){
      var imageId=isPeople?(c.representativeFaceId||c.newestFaceId):(c.representativePetId||c.newestPetId);
      var imageUrl=isPeople?"/api/face/"+imageId:"/api/pet/"+imageId;
      var suggested=isPeople?(c.suggestedPersons&&c.suggestedPersons[0]&&c.suggestedPersons[0].personName):(c.suggestedPetName||(c.suggestedPets&&c.suggestedPets[0]&&c.suggestedPets[0].petName));
      var count=isPeople?c.faceCount:c.detectionCount;
      return '<div class="candidate"><img loading="lazy" src="'+imageUrl+'" alt=""><div class="candidate-info"><h3>'+(suggested?escapeHtml(suggested):"Unbekannt")+'</h3><p>'+fmt.format(count||0)+' '+(isPeople?"Gesichter":"Erkennungen")+'</p><div class="candidate-actions"><input data-candidate-name="'+c.id+'" list="'+(isPeople?"personNames":"petNames")+'" value="'+escapeHtml(suggested||"")+'" placeholder="Name"><button class="btn good" data-confirm-candidate="'+c.id+'">✓</button><button class="btn bad" data-ignore-candidate="'+c.id+'">×</button></div><button class="btn candidate-review-button" data-review-candidate="'+c.id+'" type="button">Alle '+fmt.format(count||0)+' prüfen</button></div></div>';
    }).join("");
    el("candidateList").querySelectorAll("[data-confirm-candidate]").forEach(function(b){b.addEventListener("click",function(){confirmCandidate(Number(b.getAttribute("data-confirm-candidate")),b);});});
    el("candidateList").querySelectorAll("[data-ignore-candidate]").forEach(function(b){b.addEventListener("click",function(){ignoreCandidate(Number(b.getAttribute("data-ignore-candidate")),b);});});
    el("candidateList").querySelectorAll("[data-review-candidate]").forEach(function(b){b.addEventListener("click",function(){
      openGroupReview(Number(b.getAttribute("data-review-candidate"))).catch(function(e){toast(e.message);});
    });});
  }

  var groupReviewObserver=null;
  function candidateMemberIds(candidate){
    return String(candidate&&candidate.memberSignature||"")
      .split(",")
      .map(function(value){return Number(value);})
      .filter(function(value,index,array){return Number.isSafeInteger(value)&&value>0&&array.indexOf(value)===index;});
  }
  function candidateDefaultName(candidate,mode){
    if(mode==="people"){
      return candidate&&candidate.suggestedPersons&&candidate.suggestedPersons[0]
        ? String(candidate.suggestedPersons[0].personName||"")
        : "";
    }
    return candidate
      ? String(candidate.suggestedPetName||(candidate.suggestedPets&&candidate.suggestedPets[0]&&candidate.suggestedPets[0].petName)||"")
      : "";
  }
  function updateGroupReviewCount(){
    var review=state.groupReview;
    if(!review) return;
    el("groupReviewCount").textContent=
      fmt.format(review.selected.size)+" von "+fmt.format(review.ids.length)+" ausgewählt";
    el("groupReviewConfirm").disabled=review.selected.size===0;
  }
  function renderGroupReview(){
    var review=state.groupReview;
    if(!review) return;
    var visible=review.ids.slice(0,review.visibleCount);
    var prefix=review.mode==="people"?"/api/face/":"/api/pet/";
    el("groupReviewGrid").innerHTML=visible.map(function(id){
      return '<button type="button" class="group-review-item'+(review.selected.has(id)?"":" excluded")+'" data-review-id="'+id+'"><img loading="lazy" src="'+prefix+id+'" alt=""></button>';
    }).join("");
    el("groupReviewGrid").querySelectorAll("[data-review-id]").forEach(function(button){
      button.addEventListener("click",function(){
        var id=Number(button.getAttribute("data-review-id"));
        if(review.selected.has(id)) review.selected.delete(id); else review.selected.add(id);
        button.classList.toggle("excluded",!review.selected.has(id));
        updateGroupReviewCount();
      });
    });
    var more=el("groupReviewMore");
    if(review.visibleCount<review.ids.length){
      more.textContent="Weitere Bilder werden nachgeladen …";
      more.hidden=false;
      if(groupReviewObserver) groupReviewObserver.disconnect();
      groupReviewObserver=new IntersectionObserver(function(entries){
        if(!entries.some(function(entry){return entry.isIntersecting;})) return;
        if(!state.groupReview) return;
        state.groupReview.visibleCount=Math.min(state.groupReview.ids.length,state.groupReview.visibleCount+24);
        renderGroupReview();
      },{root:el("groupReviewDialog"),rootMargin:"240px"});
      groupReviewObserver.observe(more);
    }else{
      more.hidden=true;
      if(groupReviewObserver){groupReviewObserver.disconnect();groupReviewObserver=null;}
    }
    updateGroupReviewCount();
  }
  async function openGroupReview(id){
    var candidate=currentCandidate(id);
    if(!candidate){toast("Die Gruppe ist nicht mehr aktuell. Bitte neu laden.");return;}
    var mode=state.confirmMode;
    el("groupReviewTitle").textContent=(mode==="people"?"Personengruppe":"Tiergruppe")+" · wird geladen …";
    el("groupReviewGrid").innerHTML='<div class="empty" style="grid-column:1/-1">Fundstellen werden geladen …</div>';
    el("groupReviewMore").hidden=true;
    el("groupReviewName").setAttribute("list",mode==="people"?"personNames":"petNames");
    el("groupReviewName").value=candidateDefaultName(candidate,mode);
    if(!el("groupReviewDialog").open) el("groupReviewDialog").showModal();

    var result=await api("/api/"+mode+"/"+id+"/items?limit=5000&offset=0");
    var items=result&&result.items?result.items:[];
    var ids=items.map(function(item){
      return Number(mode==="people"?item.faceDetectionId:item.petDetectionId);
    }).filter(function(value,index,array){
      return Number.isSafeInteger(value)&&value>0&&array.indexOf(value)===index;
    });
    if(!ids.length){
      el("groupReviewDialog").close();
      toast("Für diese Gruppe wurden keine Fundstellen gefunden.");
      return;
    }
    state.groupReview={
      mode:mode,
      candidateId:id,
      ids:ids,
      selected:new Set(ids),
      visibleCount:Math.min(24,ids.length)
    };
    el("groupReviewTitle").textContent=(mode==="people"?"Personengruppe":"Tiergruppe")+" · "+fmt.format(ids.length)+" Fundstellen";
    renderGroupReview();
  }
  el("groupReviewClose").addEventListener("click",function(){el("groupReviewDialog").close();});
  el("groupReviewDialog").addEventListener("close",function(){
    state.groupReview=null;
    if(groupReviewObserver){groupReviewObserver.disconnect();groupReviewObserver=null;}
  });
  el("groupReviewSelectAll").addEventListener("click",function(){
    var review=state.groupReview;if(!review)return;
    review.selected=new Set(review.ids);
    renderGroupReview();
  });
  el("groupReviewConfirm").addEventListener("click",async function(){
    var review=state.groupReview;if(!review)return;
    var name=el("groupReviewName").value.trim();
    if(!name){toast("Bitte einen Namen eingeben.");el("groupReviewName").focus();return;}
    var detectionIds=review.ids.filter(function(id){return review.selected.has(id);});
    if(!detectionIds.length){toast("Mindestens eine Fundstelle auswählen.");return;}
    var button=el("groupReviewConfirm");button.disabled=true;
    try{
      var result=await apiPost("/api/"+review.mode+"/assign-selection",{
        candidateId:review.candidateId,
        detectionIds:detectionIds,
        name:name
      });
      state.identityOptions=null;
      el("groupReviewDialog").close();
      toast(review.mode==="people"
        ? fmt.format(result.faceCount||0)+" Gesichter bestätigt."
        : fmt.format(result.detectionCount||0)+" Fundstellen bestätigt.");
      await loadCandidates(false);
    }catch(e){toast(e.message);}finally{button.disabled=false;}
  });

  async function changeCandidatePage(delta){
    var data=state.confirmMode==="people"?state.people:state.pets;
    var totalPages=candidateTotalPages(data);
    var next=Math.max(0,Math.min(totalPages-1,candidatePage()+delta));
    if(next===candidatePage()) return;
    state.confirmPage[state.confirmMode]=next;
    await loadCandidates(false);
    window.scrollTo({top:0,behavior:"smooth"});
  }
  function currentCandidate(id){
    var data=state.confirmMode==="people"?state.people:state.pets;
    var candidates=data&&data.candidates?data.candidates:[];
    return candidates.find(function(c){return Number(c.id)===Number(id);})||null;
  }
  async function confirmCandidate(id,button){
    var input=document.querySelector('[data-candidate-name="'+id+'"]'), name=input&&input.value?input.value.trim():"";
    if(!name){toast("Bitte einen Namen eingeben.");return;}
    var candidate=currentCandidate(id);
    if(!candidate){toast("Die Gruppe ist nicht mehr aktuell. Bitte neu laden.");return;}
    var payload={candidateId:id,name:name};
    if(state.confirmMode==="people"){
      payload.fallbackFaceDetectionId=candidate.representativeFaceId||(candidate.faces&&candidate.faces[0]&&candidate.faces[0].faceDetectionId)||null;
      payload.expectedFaceCount=candidate.faceCount;
      if(candidate.memberSignature) payload.expectedMemberSignature=candidate.memberSignature;
    }else{
      var suggestedName=candidate.suggestedPetName||(candidate.suggestedPets&&candidate.suggestedPets[0]&&candidate.suggestedPets[0].petName)||"";
      var suggestedId=candidate.suggestedPetId||(candidate.suggestedPets&&candidate.suggestedPets[0]&&candidate.suggestedPets[0].petId)||null;
      if(suggestedId&&suggestedName&&name.toLocaleLowerCase("de-DE")!==String(suggestedName).toLocaleLowerCase("de-DE")){
        payload.rejectedPetId=suggestedId;
      }
      payload.fallbackPetDetectionId=candidate.representativePetId||(candidate.pets&&candidate.pets[0]&&candidate.pets[0].petDetectionId)||null;
      payload.expectedDetectionCount=candidate.detectionCount;
      if(candidate.memberSignature) payload.expectedMemberSignature=candidate.memberSignature;
    }
    button.disabled=true;
    try{
      var result=await apiPost("/api/"+state.confirmMode+"/confirm",payload);
      state.identityOptions=null;
      toast(state.confirmMode==="people"
        ? fmt.format(result.faceCount||0)+" Gesichter bestätigt."
        : fmt.format(result.detectionCount||0)+" Fundstellen bestätigt.");
      await loadCandidates(false);
    }catch(e){toast(e.message);}finally{button.disabled=false;}
  }
  async function ignoreCandidate(id,button){
    var candidate=currentCandidate(id);
    if(!candidate){toast("Die Gruppe ist nicht mehr aktuell. Bitte neu laden.");return;}
    var payload={candidateId:id,ignoredIdentityId:candidate.ignoredIdentityId||null};
    if(state.confirmMode==="people"){
      payload.fallbackFaceDetectionId=candidate.representativeFaceId||(candidate.faces&&candidate.faces[0]&&candidate.faces[0].faceDetectionId)||null;
      payload.expectedFaceCount=candidate.faceCount;
      if(candidate.memberSignature) payload.expectedMemberSignature=candidate.memberSignature;
    }else{
      payload.fallbackPetDetectionId=candidate.representativePetId||(candidate.pets&&candidate.pets[0]&&candidate.pets[0].petDetectionId)||null;
      payload.expectedDetectionCount=candidate.detectionCount;
      if(candidate.memberSignature) payload.expectedMemberSignature=candidate.memberSignature;
    }
    button.disabled=true;
    try{
      await apiPost("/api/"+state.confirmMode+"/ignore",payload);
      toast("Kandidat ignoriert.");
      await loadCandidates(false);
    }catch(e){toast(e.message);}finally{button.disabled=false;}
  }
  document.querySelectorAll("[data-confirm-mode]").forEach(function(b){b.addEventListener("click",function(){
    state.confirmMode=b.getAttribute("data-confirm-mode");
    state.confirmPage[state.confirmMode]=0;
    document.querySelectorAll("[data-confirm-mode]").forEach(function(x){x.classList.toggle("active",x===b);});
    loadCandidates(false).catch(function(e){toast(e.message);});
  });});
  el("candidatePrev").addEventListener("click",function(){changeCandidatePage(-1).catch(function(e){toast(e.message);});});
  el("candidateNext").addEventListener("click",function(){changeCandidatePage(1).catch(function(e){toast(e.message);});});
  el("confirmRefresh").addEventListener("click",function(){
    state.confirmPage[state.confirmMode]=0;
    loadCandidates(true)
      .then(function(){toast("Neugruppierung läuft im Hintergrund. Der bisherige Stand bleibt sichtbar.");})
      .catch(function(e){toast(e.message);});
  });

  var candidateTouchStart=null;
  el("candidateList").addEventListener("touchstart",function(event){
    if(!event.touches||event.touches.length!==1) return;
    candidateTouchStart={x:event.touches[0].clientX,y:event.touches[0].clientY};
  },{passive:true});
  el("candidateList").addEventListener("touchend",function(event){
    if(!candidateTouchStart||!event.changedTouches||event.changedTouches.length!==1) return;
    var dx=event.changedTouches[0].clientX-candidateTouchStart.x;
    var dy=event.changedTouches[0].clientY-candidateTouchStart.y;
    candidateTouchStart=null;
    if(Math.abs(dx)<70||Math.abs(dx)<=Math.abs(dy)*1.25) return;
    changeCandidatePage(dx<0?1:-1).catch(function(e){toast(e.message);});
  },{passive:true});

  function queueTotals(moduleQueues){
    var out={pending:0,running:0,done:0,failed:0,unavailable:0};
    Object.keys(moduleQueues||{}).forEach(function(k){var q=moduleQueues[k]||{};Object.keys(out).forEach(function(s){out[s]+=Number(q[s]||0);});});
    return out;
  }
  function todayDone(){
    if(!state.history||!state.history.rows) return 0;
    var today=new Date().toLocaleDateString("sv-SE");
    return state.history.rows.filter(function(r){return r.day===today&&r.status==="DONE";}).reduce(function(sum,r){return sum+Number(r.count||0);},0);
  }
  function renderAnalysis(){
    var p=state.status||{}, analysis=p.analysis||{}, queues=p.pipeline||{};
    var totals=queueTotals(queues);
    el("analysisMetrics").innerHTML='<div class="metric"><strong>'+fmt.format(totals.pending)+'</strong><span>Jobs offen</span></div><div class="metric"><strong>'+fmt.format(totals.running)+'</strong><span>Laufen</span></div><div class="metric"><strong>'+fmt.format(todayDone())+'</strong><span>Heute erledigt</span></div><div class="metric"><strong>'+fmt.format(totals.failed)+'</strong><span>Fehler</span></div>';
    el("boostButton").textContent=analysis.boostEnabled?"Boost deaktivieren":"Boost aktivieren";
    el("boostButton").className="btn "+(analysis.boostEnabled?"warn":"good");
    var paused=p.background&&p.background.paused;
    el("pauseButton").textContent=paused?"Fortsetzen":"Pause";
    el("pauseButton").className="btn "+(paused?"good":"warn");
    el("stageRows").innerHTML=stageOrder.map(function(stage){
      var q=queues[stage]||{pending:0,running:0,done:0,failed:0,unavailable:0};
      return '<div class="stage-row"><strong>'+stageLabels[stage]+'</strong><span class="pill warn">'+fmt.format(q.pending||0)+'</span><span class="pill">'+fmt.format(q.running||0)+'</span><span class="pill good">'+fmt.format(q.done||0)+'</span><span class="pill bad">'+fmt.format(q.failed||0)+'</span></div>';
    }).join("");
  }
  async function refreshStatus(){
    try{
      state.status=await api("/api/remote-status");
      setConnection(true,(state.status.background&&state.status.background.paused)?"Analyse pausiert":"Verbunden");
      renderAnalysis();
      renderMore();
    }catch(e){setConnection(false,"Verbindung unterbrochen");}
  }
  el("analysisRefresh").addEventListener("click",function(){refreshStatus();});
  el("boostButton").addEventListener("click",async function(){
    var enabled=!(state.status&&state.status.analysis&&state.status.analysis.boostEnabled);this.disabled=true;
    try{await apiPost("/api/analysis/boost",{enabled:enabled});await refreshStatus();toast(enabled?"Boost aktiv.":"Boost deaktiviert.");}catch(e){toast(e.message);}finally{this.disabled=false;}
  });
  el("pauseButton").addEventListener("click",async function(){
    var paused=!(state.status&&state.status.background&&state.status.background.paused);this.disabled=true;
    try{await apiPost("/api/analysis/pause",{paused:paused});await refreshStatus();toast(paused?"Analyse pausiert.":"Analyse läuft weiter.");}catch(e){toast(e.message);}finally{this.disabled=false;}
  });

  function historyByDay(){
    var map={}; if(!state.history||!state.history.rows) return map;
    state.history.rows.forEach(function(r){
      if(!map[r.day]) map[r.day]={total:0,modules:{}};
      if(r.status==="DONE"){
        map[r.day].total+=Number(r.count||0);
        map[r.day].modules[r.module]=(map[r.day].modules[r.module]||0)+Number(r.count||0);
      }
    });
    return map;
  }
  function renderHistory(){
    var map=historyByDay(), days=Object.keys(map).sort();
    var max=Math.max.apply(null,[1].concat(days.map(function(d){return map[d].total;})));
    el("historyBars").innerHTML=days.map(function(day){
      var pct=Math.max(3,Math.round(map[day].total/max*100));
      return '<div class="bar-item"><div class="bar-value">'+fmt.format(map[day].total)+'</div><div class="bar" style="height:'+pct+'%"></div><div class="bar-label">'+day.slice(5)+'</div></div>';
    }).join("") || '<div class="empty" style="width:100%">Noch keine Verlaufsdaten.</div>';
    el("historyDays").innerHTML=days.slice().reverse().map(function(day){
      var data=map[day], rows=moduleOrder.filter(function(m){return data.modules[m];}).map(function(m){return '<span><em style="font-style:normal">'+moduleLabels[m]+'</em><strong>'+fmt.format(data.modules[m])+'</strong></span>';}).join("");
      var label=new Date(day+"T12:00:00").toLocaleDateString("de-DE",{weekday:"short",day:"2-digit",month:"2-digit",year:"numeric"});
      return '<div class="history-day"><div class="history-day-head"><strong>'+escapeHtml(label)+'</strong><strong>'+fmt.format(data.total)+' erledigt</strong></div><div class="history-day-grid">'+rows+'</div></div>';
    }).join("") || '<div class="empty" style="margin:12px">Noch keine Verlaufsdaten.</div>';
    renderAnalysis();
  }
  async function loadHistory(){
    state.history=await api("/api/analysis/history?days="+state.historyDays);
    renderHistory();
  }
  document.querySelectorAll("[data-history-days]").forEach(function(b){b.addEventListener("click",function(){
    state.historyDays=Number(b.getAttribute("data-history-days"));document.querySelectorAll("[data-history-days]").forEach(function(x){x.classList.toggle("active",x===b);});loadHistory().catch(function(e){toast(e.message);});
  });});
  el("historyRefresh").addEventListener("click",function(){loadHistory().catch(function(e){toast(e.message);});});

  async function loadSummary(){
    state.summary=await api("/api/remote-summary");
    renderMore();
  }
  function renderMore(){
    var p=state.status||{}, stats=state.summary||{}, analysis=p.analysis||{};
    var rows=[
      ["Serverzeit",p.serverTime?new Date(p.serverTime).toLocaleString("de-DE"):"—"],
      ["Medien gesamt",stats.total==null?"—":fmt.format(stats.total)],
      ["Verfügbar",stats.available==null?"—":fmt.format(stats.available)],
      ["Personen",stats.persons==null?"—":fmt.format(stats.persons)],
      ["Haustiere",stats.pets==null?"—":fmt.format(stats.pets)],
      ["Letzter Scan",stats.lastScan?new Date(stats.lastScan).toLocaleString("de-DE"):"—"],
      ["Worker",analysis.state||"—"],
      ["Parallel",analysis.maxConcurrentJobs==null?"—":String(analysis.maxConcurrentJobs)],
      ["CPU-Ziel",analysis.cpuBudgetPercent==null?"—":analysis.cpuBudgetPercent+" %"]
    ];
    el("morePanel").innerHTML=rows.map(function(r){return '<div class="more-row"><span>'+escapeHtml(r[0])+'</span><strong>'+escapeHtml(r[1])+'</strong></div>';}).join("");
  }
  el("pingButton").addEventListener("click",async function(){
    var start=performance.now();this.disabled=true;
    try{var result=await apiPost("/api/remote-echo",{sentAt:new Date().toISOString(),message:"Hallo vom Handy"});el("pingResult").textContent="Antwort in "+Math.round(performance.now()-start)+" ms · "+new Date(result.receivedAt).toLocaleTimeString("de-DE");}catch(e){el("pingResult").textContent="Fehler: "+e.message;}finally{this.disabled=false;}
  });

  async function boot(){
    try{
      await Promise.all([loadSources(),refreshStatus()]);
      await loadMedia();
      setConnection(true,"Verbunden");
    }catch(e){setConnection(false,"Fehler: "+e.message);toast(e.message);}
  }
  setInterval(function(){refreshStatus();},5000);
  boot();
})();
</script>
</body>
</html>`;
