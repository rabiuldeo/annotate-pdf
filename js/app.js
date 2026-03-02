/**
 * AnnotaPDF v5 — Chrome-style PDF Viewer
 * Multi-page scroll, per-page rotation, auto-save
 */
'use strict';

/* ── PDF.JS CONFIG ── */
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

/* ── CONSTANTS ── */
const COLOR_MAP = {
  yellow: { r:255, g:193, b:7,   hex:'#FFC107' },
  green:  { r: 52, g:168, b:83,  hex:'#34A853' },
  blue:   { r: 66, g:133, b:244, hex:'#4285F4' },
  red:    { r:234, g: 67, b:53,  hex:'#EA4335' },
  pink:   { r:255, g:105, b:180, hex:'#FF69B4' },
  orange: { r:255, g:146, b: 43, hex:'#FF922B' },
  purple: { r:151, g:117, b:250, hex:'#9775FA' },
  cyan:   { r: 34, g:211, b:238, hex:'#22D3EE' },
  custom: { r:255, g:193, b:  7, hex:'#FFC107' },
};

const BASE_SCALE      = 1.5;   // PDF render scale at 100%
const SAVE_SCALE      = 3.0;   // Export quality
const MAX_HISTORY     = 50;
const MIN_HIGHLIGHT   = 4;     // px

/* ── STATE ── */
let tabs         = [];
let activeTabId  = null;
let drawMode     = 'highlight';
let activeColor  = 'yellow';
let activeOpacity = 60;
let zoomLevel    = 1.0;       // multiplier on BASE_SCALE
let tabIdCounter = 0;

/* ── DOM ── */
const fileInput    = document.getElementById('file-input');
const loadBar      = document.getElementById('load-bar');
const tabBar       = document.getElementById('tab-bar');
const addTabBtn    = document.getElementById('add-tab-btn');
const dropZone     = document.getElementById('drop-zone');
const pagesContainer = document.getElementById('pages-container');
const thumbList    = document.getElementById('thumb-list');
const thumbEmpty   = document.getElementById('thumb-empty');
const hiList       = document.getElementById('hi-list');
const hiEmpty      = document.getElementById('hi-empty');
const hiCount      = document.getElementById('hi-count');
const opSlider     = document.getElementById('op-slider');
const opVal        = document.getElementById('op-val');
const zoomLabelBtn = document.getElementById('zoom-label');

/* ═══════════════════════════════════════════
   TAB STATE
   ═══════════════════════════════════════════ */
class TabState {
  constructor(id, name, type) {
    this.id          = id;
    this.name        = name;
    this.type        = type;   // 'pdf' | 'image'
    this.pdfDoc      = null;
    this.imgElement  = null;
    this.imgSrc      = null;
    this.totalPages  = 1;
    this.unsaved     = false;

    /** Per-page rotation: Map<pageNum, degrees> */
    this.pageRotation = new Map();

    /**
     * highlights: [{id, page, x, y, w, h, color, opacity}]
     * x,y,w,h stored at BASE_SCALE*zoom=1 (normalised)
     */
    this.highlights  = [];
    this.history     = [];
    this.future      = [];

    /** file handle for auto-save (File System Access API) */
    this.fileHandle  = null;
    this.localFile   = null;  // original File object for auto-save fallback
  }
  getRotation(page) { return this.pageRotation.get(page) || 0; }
  setRotation(page, deg) { this.pageRotation.set(page, ((deg % 360) + 360) % 360); }
}

/* ═══════════════════════════════════════════
   LOAD BAR & TOAST
   ═══════════════════════════════════════════ */
function setLoadBar(pct) {
  if (pct === 0) {
    loadBar.style.display = 'block';
    loadBar.style.width = '5%';
  } else if (pct >= 100) {
    loadBar.style.width = '100%';
    setTimeout(() => { loadBar.style.display = 'none'; loadBar.style.width = '0'; }, 350);
  } else {
    loadBar.style.width = pct + '%';
  }
}

let toastTimer = null;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.innerHTML = msg;
  el.className = type ? `show ${type}` : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 2800);
}

/* ═══════════════════════════════════════════
   FILE HANDLING
   ═══════════════════════════════════════════ */
function openFiles(files) {
  [...files].forEach(f => {
    if (f.type === 'application/pdf') loadPdfFile(f);
    else if (f.type.startsWith('image/')) loadImageFile(f);
    else toast(`সাপোর্টেড নয়: ${f.name}`, 'error');
  });
}

async function loadPdfFile(file) {
  setLoadBar(0);
  try {
    const buf = await file.arrayBuffer();
    setLoadBar(40);
    const doc = await pdfjsLib.getDocument({ data: buf }).promise;
    setLoadBar(80);
    const tab = createTab(file.name, 'pdf');
    tab.pdfDoc     = doc;
    tab.totalPages = doc.numPages;
    tab.localFile  = file;
    // Try to get file handle for auto-save
    activateTab(tab.id);
    setLoadBar(100);
    toast(`<i class="fa-solid fa-circle-check"></i> ${file.name} (${doc.numPages} পেজ)`, 'success');
    autoLoadThumbs(tab);
  } catch(e) {
    setLoadBar(100);
    console.error(e);
    toast('PDF লোড ব্যর্থ', 'error');
  }
}

function loadImageFile(file) {
  setLoadBar(0);
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const tab = createTab(file.name, 'image');
    tab.imgElement = img;
    tab.imgSrc     = url;
    tab.localFile  = file;
    activateTab(tab.id);
    setLoadBar(100);
    toast(`<i class="fa-solid fa-circle-check"></i> ${file.name}`, 'success');
    autoLoadThumbs(tab);
  };
  img.onerror = () => { setLoadBar(100); toast('ইমেজ লোড ব্যর্থ', 'error'); };
  img.src = url;
  setLoadBar(60);
}

/* URL LOADING */
async function loadFromUrl(rawUrl, inputEl = null) {
  const url = rawUrl.trim();
  if (!url) { toast('URL দিন', 'warning'); return; }
  if (inputEl) inputEl.value = '';
  const ext = url.split('?')[0].split('.').pop().toLowerCase();
  const isImg = ['jpg','jpeg','png','webp','gif','bmp','svg'].includes(ext);
  if (isImg) loadImageUrl(url);
  else       await loadPdfUrl(url);
}

function loadImageUrl(url) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const name = url.split('/').pop().split('?')[0] || 'image';
    const tab  = createTab(name, 'image');
    tab.imgElement = img;
    tab.imgSrc     = url;
    activateTab(tab.id);
    setLoadBar(100);
    toast('ইমেজ লোড হয়েছে', 'success');
    autoLoadThumbs(tab);
  };
  img.onerror = () => toast('ইমেজ লোড ব্যর্থ', 'error');
  img.src = url;
  setLoadBar(30);
}

async function fetchWithProgress(fetchUrl, opts = {}) {
  const res = await fetch(fetchUrl, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentLength = res.headers.get('Content-Length');
  if (!contentLength || !res.body) return res.arrayBuffer();
  const total  = parseInt(contentLength, 10);
  const reader = res.body.getReader();
  const chunks = []; let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); received += value.length;
    setLoadBar(Math.min(5 + Math.round(received/total*70), 75));
  }
  const merged = new Uint8Array(received); let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }
  return merged.buffer;
}

async function loadPdfUrl(rawUrl) {
  const name = rawUrl.split('/').pop().split('?')[0] || 'document.pdf';
  setLoadBar(5);

  function openDoc(doc) {
    const tab = createTab(name, 'pdf');
    tab.pdfDoc     = doc;
    tab.totalPages = doc.numPages;
    activateTab(tab.id);
    setLoadBar(100);
    toast('PDF লোড হয়েছে', 'success');
    autoLoadThumbs(tab);
  }

  // Strategy 1: pdf.js direct URL (no fetch = no CORS issue)
  try {
    const doc = await pdfjsLib.getDocument({ url: rawUrl, withCredentials: false }).promise;
    openDoc(doc); return;
  } catch(_) {}

  // Strategy 2: corsproxy.io
  try {
    setLoadBar(10);
    const buf = await fetchWithProgress(`https://corsproxy.io/?${encodeURIComponent(rawUrl)}`);
    if (buf.byteLength > 100) { openDoc(await pdfjsLib.getDocument({ data: buf }).promise); return; }
  } catch(_) {}

  // Strategy 3: allorigins
  try {
    setLoadBar(15);
    const buf = await fetchWithProgress(`https://api.allorigins.win/raw?url=${encodeURIComponent(rawUrl)}`);
    if (buf.byteLength > 100) { openDoc(await pdfjsLib.getDocument({ data: buf }).promise); return; }
  } catch(_) {}

  // Fallback
  setLoadBar(100);
  const toastEl = document.getElementById('toast');
  toastEl.innerHTML = `লোড ব্যর্থ। <a href="${rawUrl}" download target="_blank" style="color:#fff;font-weight:700;text-decoration:underline;">ডাউনলোড করুন</a> তারপর ফাইল হিসেবে খুলুন।`;
  toastEl.className = 'show error';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = ''; }, 9000);
}

/* ═══════════════════════════════════════════
   TAB MANAGEMENT
   ═══════════════════════════════════════════ */
function createTab(name, type) {
  const id  = ++tabIdCounter;
  const tab = new TabState(id, name, type);
  tabs.push(tab);
  renderTabEl(tab);
  return tab;
}

function renderTabEl(tab) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.dataset.id = tab.id;
  el.title = tab.name;
  el.innerHTML = `
    <span class="tab-type ${tab.type}">${tab.type === 'pdf' ? 'PDF' : 'IMG'}</span>
    <span class="tab-name">${tab.name}</span>
    <span class="tab-close" data-id="${tab.id}"><i class="fa-solid fa-xmark"></i></span>
  `;
  el.addEventListener('click', e => {
    if (e.target.closest('.tab-close')) { closeTab(tab.id); return; }
    activateTab(tab.id);
  });
  tabBar.insertBefore(el, addTabBtn);
}

function activateTab(id) {
  activeTabId = id;
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', +t.dataset.id === id)
  );
  dropZone.classList.add('hidden');
  pagesContainer.classList.remove('hidden');
  renderAllPages();
  updateHiPanel();
  updateThumbHighlight();
}

function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx < 0) return;
  const tab = tabs[idx];
  if (tab.imgSrc?.startsWith('blob:')) URL.revokeObjectURL(tab.imgSrc);
  tabs.splice(idx, 1);
  document.querySelector(`.tab[data-id="${id}"]`)?.remove();

  if (tabs.length === 0) {
    activeTabId = null;
    dropZone.classList.remove('hidden');
    pagesContainer.classList.add('hidden');
    pagesContainer.innerHTML = '';
    thumbList.innerHTML = '';
    thumbList.appendChild(thumbEmpty);
    thumbEmpty.style.display = '';
    updateHiPanel();
  } else {
    activateTab(tabs[Math.min(idx, tabs.length-1)].id);
  }
}

function getTab() { return tabs.find(t => t.id === activeTabId) || null; }

/* ═══════════════════════════════════════════
   CHROME-STYLE MULTI-PAGE RENDERING
   Each page = its own set of 3 canvases
   ═══════════════════════════════════════════ */

/** Render all pages of the active tab into pages-container */
async function renderAllPages() {
  const tab = getTab();
  if (!tab) return;

  // Clear existing pages
  pagesContainer.innerHTML = '';
  pagesContainer.dataset.tabId = tab.id;

  if (tab.type === 'image') {
    renderImagePageEl(tab, 1);
    return;
  }

  // PDF: render each page
  for (let p = 1; p <= tab.totalPages; p++) {
    renderPdfPageEl(tab, p);
  }
}

/** Create DOM structure for one PDF page and render it */
async function renderPdfPageEl(tab, pageNum) {
  // Create wrapper
  const wrapper = document.createElement('div');
  wrapper.className = 'page-wrapper';
  wrapper.dataset.page = pageNum;

  const shadow = document.createElement('div');
  shadow.className = 'page-shadow';

  const pdfC  = document.createElement('canvas');
  const ovrC  = document.createElement('canvas');
  const drawC = document.createElement('canvas');
  ovrC.className  = 'overlay-canvas';
  drawC.className = 'draw-canvas';

  shadow.appendChild(pdfC);
  shadow.appendChild(ovrC);
  shadow.appendChild(drawC);

  // Per-page toolbar
  const ptb = document.createElement('div');
  ptb.className = 'page-toolbar';
  ptb.innerHTML = `
    <button class="pg-rot-ccw" title="বামে ঘুরান"><i class="fa-solid fa-rotate-left"></i></button>
    <span class="page-num-label">পেজ ${pageNum}</span>
    <button class="pg-rot-cw" title="ডানে ঘুরান"><i class="fa-solid fa-rotate-right"></i></button>
  `;
  ptb.querySelector('.pg-rot-ccw').addEventListener('click', () => rotatePageEl(tab, pageNum, 'ccw', shadow, pdfC, ovrC, drawC));
  ptb.querySelector('.pg-rot-cw').addEventListener('click',  () => rotatePageEl(tab, pageNum, 'cw',  shadow, pdfC, ovrC, drawC));

  wrapper.appendChild(shadow);
  wrapper.appendChild(ptb);
  pagesContainer.appendChild(wrapper);

  // Draw mode classes
  updatePageCursor(shadow);

  // Attach draw events
  attachDrawEvents(tab, pageNum, shadow, pdfC, ovrC, drawC);

  // Render
  await renderPdfPage(tab, pageNum, pdfC, ovrC, drawC, shadow);
}

async function renderPdfPage(tab, pageNum, pdfC, ovrC, drawC, shadow) {
  try {
    const page = await tab.pdfDoc.getPage(pageNum);
    const rot  = tab.getRotation(pageNum);
    const scale = BASE_SCALE * zoomLevel;
    const vp   = page.getViewport({ scale, rotation: rot });

    [pdfC, ovrC, drawC].forEach(c => { c.width = vp.width; c.height = vp.height; });
    shadow.style.width  = vp.width  + 'px';
    shadow.style.height = vp.height + 'px';

    const ctx = pdfC.getContext('2d');
    const renderTask = page.render({ canvasContext: ctx, viewport: vp });
    await renderTask.promise;

    redrawHighlightsOnCanvas(tab, pageNum, ovrC);
  } catch(e) {
    if (e?.name === 'RenderingCancelledException') return;
    console.error('[render page]', e);
  }
}

function renderImagePageEl(tab, pageNum) {
  const wrapper = document.createElement('div');
  wrapper.className = 'page-wrapper';
  wrapper.dataset.page = pageNum;

  const shadow = document.createElement('div');
  shadow.className = 'page-shadow';

  const pdfC  = document.createElement('canvas');
  const ovrC  = document.createElement('canvas');
  const drawC = document.createElement('canvas');
  ovrC.className  = 'overlay-canvas';
  drawC.className = 'draw-canvas';

  shadow.appendChild(pdfC);
  shadow.appendChild(ovrC);
  shadow.appendChild(drawC);

  const ptb = document.createElement('div');
  ptb.className = 'page-toolbar';
  ptb.innerHTML = `
    <button class="pg-rot-ccw" title="বামে ঘুরান"><i class="fa-solid fa-rotate-left"></i></button>
    <span class="page-num-label">ইমেজ</span>
    <button class="pg-rot-cw" title="ডানে ঘুরান"><i class="fa-solid fa-rotate-right"></i></button>
  `;
  ptb.querySelector('.pg-rot-ccw').addEventListener('click', () => rotatePageEl(tab, 1, 'ccw', shadow, pdfC, ovrC, drawC));
  ptb.querySelector('.pg-rot-cw').addEventListener('click',  () => rotatePageEl(tab, 1, 'cw',  shadow, pdfC, ovrC, drawC));

  wrapper.appendChild(shadow);
  wrapper.appendChild(ptb);
  pagesContainer.appendChild(wrapper);

  updatePageCursor(shadow);
  attachDrawEvents(tab, pageNum, shadow, pdfC, ovrC, drawC);
  renderImageOnCanvas(tab, pdfC, ovrC, drawC, shadow);
}

function renderImageOnCanvas(tab, pdfC, ovrC, drawC, shadow) {
  const img = tab.imgElement;
  const rot = tab.getRotation(1);
  const sc  = BASE_SCALE * zoomLevel;
  const sw  = img.naturalWidth;
  const sh  = img.naturalHeight;
  const cw  = (rot===90||rot===270) ? sh*sc : sw*sc;
  const ch  = (rot===90||rot===270) ? sw*sc : sh*sc;

  [pdfC, ovrC, drawC].forEach(c => { c.width = cw; c.height = ch; });
  shadow.style.width  = cw + 'px';
  shadow.style.height = ch + 'px';

  const ctx = pdfC.getContext('2d');
  ctx.clearRect(0, 0, cw, ch);
  ctx.save();
  ctx.translate(cw/2, ch/2);
  ctx.rotate(rot * Math.PI / 180);
  ctx.drawImage(img, -sw*sc/2, -sh*sc/2, sw*sc, sh*sc);
  ctx.restore();

  redrawHighlightsOnCanvas(tab, 1, ovrC);
}

/* Rotate a single page */
async function rotatePageEl(tab, pageNum, dir, shadow, pdfC, ovrC, drawC) {
  const oldRot = tab.getRotation(pageNum);
  const newRot = (oldRot + (dir === 'cw' ? 90 : -90) + 360) % 360;

  // Remap highlights for this page
  const oldW = pdfC.width, oldH = pdfC.height;
  tab.highlights = tab.highlights.map(h => {
    if (h.page !== pageNum) return h;
    let nx, ny, nw, nh;
    if (dir === 'cw') {
      nx = oldH - h.y - h.h; ny = h.x; nw = h.h; nh = h.w;
    } else {
      nx = h.y; ny = oldW - h.x - h.w; nw = h.h; nh = h.w;
    }
    return { ...h, x:nx, y:ny, w:nw, h:nh };
  });

  tab.setRotation(pageNum, newRot);

  if (tab.type === 'pdf') {
    await renderPdfPage(tab, pageNum, pdfC, ovrC, drawC, shadow);
  } else {
    renderImageOnCanvas(tab, pdfC, ovrC, drawC, shadow);
  }
  updateHiPanel();
  markUnsaved(tab);
  toast('<i class="fa-solid fa-rotate"></i> রোটেট হয়েছে');
}

/* Redraw all highlights for a page onto its overlay canvas */
function redrawHighlightsOnCanvas(tab, pageNum, ovrC) {
  const octx = ovrC.getContext('2d');
  octx.clearRect(0, 0, ovrC.width, ovrC.height);
  tab.highlights
    .filter(h => h.page === pageNum)
    .forEach(h => {
      const c = COLOR_MAP[h.color];
      octx.fillStyle = `rgba(${c.r},${c.g},${c.b},${h.opacity/100})`;
      octx.fillRect(h.x, h.y, h.w, h.h);
    });
}

/** Redraw highlights on all currently rendered pages */
function redrawAllHighlights() {
  const tab = getTab();
  if (!tab) return;
  pagesContainer.querySelectorAll('.page-wrapper').forEach(wrapper => {
    const pageNum = +wrapper.dataset.page;
    const ovrC = wrapper.querySelector('.overlay-canvas');
    if (ovrC) redrawHighlightsOnCanvas(tab, pageNum, ovrC);
  });
}

/* ═══════════════════════════════════════════
   DRAWING INTERACTION (per canvas)
   ═══════════════════════════════════════════ */
let drawState = { active: false, startX:0, startY:0, pageNum:0, drawC:null, ovrC:null, pdfC:null, tab:null, panSX:0, panSY:0, scrollEl:null };

function attachDrawEvents(tab, pageNum, shadow, pdfC, ovrC, drawC) {
  const down = (e) => {
    if (!activeTabId || activeTabId !== tab.id) return;
    const pos = canvasPos(e, drawC);
    if (drawMode === 'pan') {
      drawState = { active:true, pageNum, drawC, ovrC, pdfC, tab,
        panSX: e.clientX ?? e.touches[0].clientX, panSY: e.clientY ?? e.touches[0].clientY,
        scrollEl: document.getElementById('pdf-viewer') };
      shadow.classList.add('panning');
    } else {
      drawState = { active:true, startX:pos.x, startY:pos.y, pageNum, drawC, ovrC, pdfC, tab };
    }
  };
  const move = (e) => {
    if (!drawState.active || drawState.tab !== tab || drawState.pageNum !== pageNum) return;
    if (drawMode === 'pan') {
      const cx = e.clientX ?? e.touches[0].clientX;
      const cy = e.clientY ?? e.touches[0].clientY;
      drawState.scrollEl.scrollLeft -= cx - drawState.panSX;
      drawState.scrollEl.scrollTop  -= cy - drawState.panSY;
      drawState.panSX = cx; drawState.panSY = cy;
      return;
    }
    const pos = canvasPos(e, drawC);
    const dctx = drawC.getContext('2d');
    dctx.clearRect(0, 0, drawC.width, drawC.height);
    const c = COLOR_MAP[activeColor];
    dctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${activeOpacity/100 * 0.5})`;
    const x = Math.min(pos.x, drawState.startX);
    const y = Math.min(pos.y, drawState.startY);
    const w = Math.abs(pos.x - drawState.startX);
    const h = Math.abs(pos.y - drawState.startY);
    dctx.fillRect(x, y, w, h);
  };
  const up = (e) => {
    if (!drawState.active || drawState.tab !== tab || drawState.pageNum !== pageNum) return;
    shadow.classList.remove('panning');
    if (drawMode === 'pan') { drawState.active = false; return; }
    const pos = canvasPos(e, drawC);
    const dctx = drawC.getContext('2d');
    dctx.clearRect(0, 0, drawC.width, drawC.height);

    const x = Math.min(pos.x, drawState.startX);
    const y = Math.min(pos.y, drawState.startY);
    const w = Math.abs(pos.x - drawState.startX);
    const h = Math.abs(pos.y - drawState.startY);

    if (drawMode === 'erase') {
      eraseAt(tab, pageNum, x, y, w, h);
      redrawHighlightsOnCanvas(tab, pageNum, ovrC);
    } else if (drawMode === 'highlight' && w > MIN_HIGHLIGHT && h > MIN_HIGHLIGHT) {
      pushHistory(tab);
      const hl = { id: Date.now(), page:pageNum, x, y, w, h, color:activeColor, opacity:activeOpacity };
      tab.highlights.push(hl);
      redrawHighlightsOnCanvas(tab, pageNum, ovrC);
      updateHiPanel();
      markUnsaved(tab);
      scheduleAutoSave(tab);
    }
    drawState.active = false;
  };

  // Mouse
  drawC.addEventListener('mousedown',  down);
  drawC.addEventListener('mousemove',  move);
  drawC.addEventListener('mouseup',    up);
  drawC.addEventListener('mouseleave', () => {
    if (drawState.active && drawState.pageNum === pageNum) {
      if (drawMode !== 'pan') {
        const dctx = drawC.getContext('2d');
        dctx.clearRect(0, 0, drawC.width, drawC.height);
      }
      drawState.active = false;
    }
  });

  // Touch
  drawC.addEventListener('touchstart', e => { e.preventDefault(); down(e.touches[0]); }, { passive:false });
  drawC.addEventListener('touchmove',  e => { e.preventDefault(); move(e.touches[0]); }, { passive:false });
  drawC.addEventListener('touchend',   e => { e.preventDefault(); up(e.changedTouches[0]); }, { passive:false });
}

function canvasPos(e, canvas) {
  const rect  = canvas.getBoundingClientRect();
  const ratio = canvas.width / rect.width;
  const clientX = e.clientX ?? (e.touches && e.touches[0].clientX);
  const clientY = e.clientY ?? (e.touches && e.touches[0].clientY);
  return { x: (clientX - rect.left) * ratio, y: (clientY - rect.top) * ratio };
}

function eraseAt(tab, pageNum, x, y, w, h) {
  const pad = 20;
  pushHistory(tab);
  tab.highlights = tab.highlights.filter(h => {
    if (h.page !== pageNum) return true;
    const ox = Math.max(h.x, x-pad), oy = Math.max(h.y, y-pad);
    const ox2 = Math.min(h.x+h.w, x+w+pad), oy2 = Math.min(h.y+h.h, y+h+pad);
    return ox >= ox2 || oy >= oy2;
  });
  updateHiPanel();
  markUnsaved(tab);
}

function updatePageCursor(shadow) {
  shadow.classList.remove('mode-pan', 'mode-erase');
  if (drawMode === 'pan')   shadow.classList.add('mode-pan');
  if (drawMode === 'erase') shadow.classList.add('mode-erase');
}

function updateAllCursors() {
  pagesContainer.querySelectorAll('.page-shadow').forEach(s => updatePageCursor(s));
}

/* ═══════════════════════════════════════════
   ZOOM
   ═══════════════════════════════════════════ */
function setZoom(newZoom) {
  const tab = getTab();
  newZoom = Math.max(0.25, Math.min(5, newZoom));
  const ratio = newZoom / zoomLevel;
  zoomLevel = newZoom;
  zoomLabelBtn.textContent = Math.round(newZoom * 100) + '%';

  // Remap highlights
  if (tab) {
    tab.highlights = tab.highlights.map(h => ({
      ...h, x:h.x*ratio, y:h.y*ratio, w:h.w*ratio, h:h.h*ratio
    }));
  }
  renderAllPages();
}

document.getElementById('zoom-in').addEventListener('click',  () => setZoom(zoomLevel + 0.25));
document.getElementById('zoom-out').addEventListener('click', () => setZoom(zoomLevel - 0.25));
zoomLabelBtn.addEventListener('click', async () => {
  // Fit to viewer width
  const viewer = document.getElementById('pdf-viewer');
  const tab = getTab();
  if (!tab) return;
  const availW = viewer.clientWidth - 64;
  let naturalW;
  if (tab.type === 'pdf') {
    const page = await tab.pdfDoc.getPage(1);
    naturalW = page.getViewport({ scale:1, rotation: tab.getRotation(1) }).width;
  } else {
    const r = tab.getRotation(1);
    naturalW = (r===90||r===270) ? tab.imgElement.naturalHeight : tab.imgElement.naturalWidth;
  }
  setZoom((availW / naturalW) / BASE_SCALE);
});

/* ═══════════════════════════════════════════
   UNDO / REDO
   ═══════════════════════════════════════════ */
function pushHistory(tab) {
  tab.history.push(JSON.parse(JSON.stringify(tab.highlights)));
  tab.future = [];
  if (tab.history.length > MAX_HISTORY) tab.history.shift();
}

function undo() {
  const tab = getTab();
  if (!tab || !tab.history.length) return;
  tab.future.push(JSON.parse(JSON.stringify(tab.highlights)));
  tab.highlights = tab.history.pop();
  redrawAllHighlights();
  updateHiPanel();
  toast('<i class="fa-solid fa-rotate-left"></i> আনডু');
}

function redo() {
  const tab = getTab();
  if (!tab || !tab.future.length) return;
  tab.history.push(JSON.parse(JSON.stringify(tab.highlights)));
  tab.highlights = tab.future.pop();
  redrawAllHighlights();
  updateHiPanel();
  toast('<i class="fa-solid fa-rotate-right"></i> রিডু');
}

document.getElementById('undo-btn').addEventListener('click', undo);
document.getElementById('redo-btn').addEventListener('click', redo);

/* ═══════════════════════════════════════════
   SAVE / EXPORT
   ═══════════════════════════════════════════ */
async function saveFile() {
  const tab = getTab();
  if (!tab) { toast('কোনো ফাইল খোলা নেই', 'error'); return; }
  if (tab.type === 'image') await saveImageFile(tab);
  else                      await savePdfFile(tab);
}

async function saveImageFile(tab) {
  const ovrC  = pagesContainer.querySelector('.page-wrapper .overlay-canvas');
  const pdfC  = pagesContainer.querySelector('.page-wrapper canvas:first-child');
  if (!pdfC) return;
  const out = document.createElement('canvas');
  out.width = pdfC.width; out.height = pdfC.height;
  const mctx = out.getContext('2d');
  mctx.drawImage(pdfC, 0, 0);
  mctx.globalCompositeOperation = 'multiply';
  if (ovrC) mctx.drawImage(ovrC, 0, 0);
  mctx.globalCompositeOperation = 'source-over';
  const a = document.createElement('a');
  a.download = tab.name.replace(/\.[^.]+$/, '') + '-highlighted.png';
  a.href = out.toDataURL('image/png');
  a.click();
  toast('ইমেজ ডাউনলোড হচ্ছে...', 'success');
  tab.unsaved = false;
  markUnsaved(tab, false);
}

async function savePdfFile(tab) {
  toast('<i class="fa-solid fa-spinner fa-spin"></i> PDF তৈরি হচ্ছে...');
  setLoadBar(0);
  try {
    const { jsPDF } = window.jspdf;
    let pdf = null; let firstPage = true;

    for (let p = 1; p <= tab.totalPages; p++) {
      setLoadBar(Math.round(p / tab.totalPages * 90));
      const page = await tab.pdfDoc.getPage(p);
      const rot  = tab.getRotation(p);
      const vp   = page.getViewport({ scale: SAVE_SCALE, rotation: rot });

      const tc = document.createElement('canvas');
      tc.width = vp.width; tc.height = vp.height;
      const tctx = tc.getContext('2d');
      await page.render({ canvasContext: tctx, viewport: vp }).promise;

      tctx.globalCompositeOperation = 'multiply';
      const ratio = SAVE_SCALE / (BASE_SCALE * zoomLevel);
      tab.highlights.filter(h => h.page === p).forEach(h => {
        const c = COLOR_MAP[h.color];
        tctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${h.opacity/100})`;
        tctx.fillRect(h.x*ratio, h.y*ratio, h.w*ratio, h.h*ratio);
      });
      tctx.globalCompositeOperation = 'source-over';

      const imgData = tc.toDataURL('image/jpeg', 0.97);
      const mmW = vp.width  * 0.264583;
      const mmH = vp.height * 0.264583;

      if (firstPage) {
        pdf = new jsPDF({ orientation: mmW > mmH ? 'l' : 'p', unit: 'mm', format: [mmW, mmH] });
        firstPage = false;
      } else {
        pdf.addPage([mmW, mmH], mmW > mmH ? 'l' : 'p');
      }
      pdf.addImage(imgData, 'JPEG', 0, 0, mmW, mmH);
    }

    setLoadBar(100);
    pdf.save(tab.name.replace(/\.pdf$/i, '') + '-highlighted.pdf');
    toast('PDF সেভ হয়েছে', 'success');
    tab.unsaved = false;
    markUnsaved(tab, false);
  } catch(e) {
    setLoadBar(100);
    console.error(e);
    toast('PDF সেভ ব্যর্থ: ' + e.message, 'error');
  }
}

/* ── AUTO-SAVE ── */
let autoSaveTimer = null;
function scheduleAutoSave(tab) {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => autoSave(tab), 3000);
}

async function autoSave(tab) {
  // Only auto-save PDFs (images are saved on demand)
  if (tab.type !== 'pdf' || !tab.pdfDoc) return;
  // Silent save — no toast
  try {
    const { jsPDF } = window.jspdf;
    let pdf = null; let firstPage = true;
    for (let p = 1; p <= tab.totalPages; p++) {
      const page = await tab.pdfDoc.getPage(p);
      const rot  = tab.getRotation(p);
      const vp   = page.getViewport({ scale: SAVE_SCALE, rotation: rot });
      const tc = document.createElement('canvas');
      tc.width = vp.width; tc.height = vp.height;
      const tctx = tc.getContext('2d');
      await page.render({ canvasContext: tctx, viewport: vp }).promise;
      tctx.globalCompositeOperation = 'multiply';
      const ratio = SAVE_SCALE / (BASE_SCALE * zoomLevel);
      tab.highlights.filter(h => h.page === p).forEach(h => {
        const c = COLOR_MAP[h.color];
        tctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${h.opacity/100})`;
        tctx.fillRect(h.x*ratio, h.y*ratio, h.w*ratio, h.h*ratio);
      });
      tctx.globalCompositeOperation = 'source-over';
      const imgData = tc.toDataURL('image/jpeg', 0.95);
      const mmW = vp.width*0.264583, mmH = vp.height*0.264583;
      if (firstPage) {
        pdf = new jsPDF({ orientation: mmW>mmH?'l':'p', unit:'mm', format:[mmW,mmH] });
        firstPage = false;
      } else { pdf.addPage([mmW,mmH], mmW>mmH?'l':'p'); }
      pdf.addImage(imgData,'JPEG',0,0,mmW,mmH);
    }
    // Save as blob to localStorage as base64 (no file system needed)
    const pdfBlob = pdf.output('blob');
    const reader = new FileReader();
    reader.onload = () => {
      try {
        localStorage.setItem(`annotapdf_autosave_${tab.id}`, JSON.stringify({
          name: tab.name.replace(/\.pdf$/i,'')+'-autosave.pdf',
          data: reader.result,
          ts: Date.now()
        }));
        markUnsaved(tab, false);
        showAutoSaveIndicator();
      } catch(_) {}  // localStorage might be full
    };
    reader.readAsDataURL(pdfBlob);
  } catch(e) { console.error('[auto-save]', e); }
}

function showAutoSaveIndicator() {
  const el = document.getElementById('toast');
  el.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> স্বয়ংক্রিয় সেভ হয়েছে';
  el.className = 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 1800);
}

function markUnsaved(tab, unsaved = true) {
  tab.unsaved = unsaved;
  const tabEl = document.querySelector(`.tab[data-id="${tab.id}"]`);
  if (tabEl) tabEl.classList.toggle('tab-unsaved', unsaved);
}

/* ═══════════════════════════════════════════
   THUMBNAILS
   ═══════════════════════════════════════════ */
async function autoLoadThumbs(tab) {
  thumbEmpty.style.display = 'none';
  // Remove old thumbs
  thumbList.querySelectorAll('.thumb-item').forEach(e => e.remove());

  if (tab.type === 'image') {
    addThumbItem(tab, 1, async (c) => {
      const img = tab.imgElement;
      const sc  = c.width / img.naturalWidth;
      c.height  = img.naturalHeight * sc;
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    });
    return;
  }

  for (let p = 1; p <= tab.totalPages; p++) {
    addThumbItem(tab, p, async (c) => {
      const page = await tab.pdfDoc.getPage(p);
      const rot  = tab.getRotation(p);
      const vp   = page.getViewport({ scale: 0.3, rotation: rot });
      c.width  = vp.width;
      c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    });
  }
}

function addThumbItem(tab, pageNum, renderFn) {
  const item = document.createElement('div');
  item.className = 'thumb-item';
  item.dataset.page = pageNum;

  const c = document.createElement('canvas');
  c.width = 156;

  const num = document.createElement('div');
  num.className = 'thumb-page-num';
  num.textContent = pageNum;

  const rotBtn = document.createElement('button');
  rotBtn.className = 'thumb-rot-btn';
  rotBtn.title = 'ঘুরান';
  rotBtn.innerHTML = '<i class="fa-solid fa-rotate-right"></i>';

  item.appendChild(c);
  item.appendChild(num);
  item.appendChild(rotBtn);
  thumbList.appendChild(item);

  renderFn(c).catch(() => {});

  item.addEventListener('click', e => {
    if (e.target.closest('.thumb-rot-btn')) return;
    // Scroll to that page
    const wrapper = pagesContainer.querySelector(`.page-wrapper[data-page="${pageNum}"]`);
    if (wrapper) wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  rotBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const wrapper = pagesContainer.querySelector(`.page-wrapper[data-page="${pageNum}"]`);
    if (wrapper) {
      const pdfC  = wrapper.querySelector('canvas:first-child');
      const ovrC  = wrapper.querySelector('.overlay-canvas');
      const drawC = wrapper.querySelector('.draw-canvas');
      const shadow = wrapper.querySelector('.page-shadow');
      await rotatePageEl(tab, pageNum, 'cw', shadow, pdfC, ovrC, drawC);
      // Re-render thumb
      const rot = tab.getRotation(pageNum);
      const vp  = (await tab.pdfDoc?.getPage(pageNum))?.getViewport({ scale:0.3, rotation:rot });
      if (vp) { c.width = vp.width; c.height = vp.height; (await tab.pdfDoc.getPage(pageNum)).render({ canvasContext: c.getContext('2d'), viewport: vp }); }
    }
  });
}

function updateThumbHighlight() {
  thumbList.querySelectorAll('.thumb-item').forEach(item => {
    item.classList.toggle('active', false); // could scroll-sync
  });
}

/* ═══════════════════════════════════════════
   HIGHLIGHTS PANEL
   ═══════════════════════════════════════════ */
function updateHiPanel() {
  const tab = getTab();
  const all = tab ? tab.highlights : [];

  hiCount.textContent = all.length;

  if (!all.length) {
    hiList.innerHTML = '';
    hiList.appendChild(hiEmpty);
    hiEmpty.style.display = '';
    return;
  }

  hiEmpty.style.display = 'none';

  // Group by page
  const byPage = {};
  all.forEach(h => { (byPage[h.page] = byPage[h.page]||[]).push(h); });

  let html = '';
  Object.keys(byPage).sort((a,b)=>+a-+b).forEach(pg => {
    if (tab.totalPages > 1) {
      html += `<div style="font-size:11px;color:#888;padding:6px 10px 2px;font-weight:600">পেজ ${pg}</div>`;
    }
    byPage[pg].forEach((h, i) => {
      const c = COLOR_MAP[h.color];
      html += `
      <div class="hi-item" onclick="jumpToHighlight(${h.id})">
        <div class="hi-dot" style="background:${c.hex}"></div>
        <div class="hi-meta">
          <div class="hi-label">হাইলাইট ${i+1}</div>
          <div class="hi-sub">${Math.round(h.w)}×${Math.round(h.h)}px</div>
        </div>
        <button class="hi-del" onclick="event.stopPropagation();deleteHighlight(${h.id})" title="মুছুন">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>`;
    });
  });

  hiList.innerHTML = html;
  hiList.appendChild(hiEmpty); // keep in DOM
  hiEmpty.style.display = 'none';
}

function jumpToHighlight(id) {
  const tab = getTab(); if (!tab) return;
  const h   = tab.highlights.find(x => x.id === id); if (!h) return;
  const wrapper = pagesContainer.querySelector(`.page-wrapper[data-page="${h.page}"]`);
  if (wrapper) wrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function deleteHighlight(id) {
  const tab = getTab(); if (!tab) return;
  pushHistory(tab);
  tab.highlights = tab.highlights.filter(h => h.id !== id);
  redrawAllHighlights();
  updateHiPanel();
  markUnsaved(tab);
  toast('হাইলাইট মুছা হয়েছে');
}

/* ═══════════════════════════════════════════
   CLEAR PAGE
   ═══════════════════════════════════════════ */
document.getElementById('clear-page-btn').addEventListener('click', () => {
  const tab = getTab(); if (!tab) return;
  // Clear all pages' highlights
  if (!tab.highlights.length) return;
  pushHistory(tab);
  tab.highlights = [];
  redrawAllHighlights();
  updateHiPanel();
  markUnsaved(tab);
  toast('সব হাইলাইট মুছা হয়েছে');
});

/* ═══════════════════════════════════════════
   TOOLBAR EVENT WIRING
   ═══════════════════════════════════════════ */

// Draw mode
document.querySelectorAll('.tool-btn[data-mode]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool-btn[data-mode]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    drawMode = btn.dataset.mode;
    updateAllCursors();
    // Update mobile mode btn
    const mb = document.getElementById('mb-mode');
    const icons  = { highlight:'fa-highlighter', erase:'fa-eraser', pan:'fa-hand' };
    const labels = { highlight:'হাইলাইট', erase:'ইরেজ', pan:'প্যান' };
    mb.querySelector('i').className = `fa-solid ${icons[drawMode]}`;
    mb.querySelector('span').textContent = labels[drawMode];
  });
});

// Color swatches
document.querySelectorAll('.swatch').forEach(s => {
  s.addEventListener('click', () => {
    document.querySelectorAll('.swatch').forEach(x => x.classList.remove('active'));
    s.classList.add('active');
    activeColor = s.dataset.color;
  });
});

document.getElementById('custom-color').addEventListener('input', e => {
  const hex = e.target.value;
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  COLOR_MAP.custom = { r, g, b, hex };
  document.querySelector('.custom-swatch').style.background = hex;
  document.querySelectorAll('.swatch').forEach(x => x.classList.remove('active'));
  document.querySelector('.custom-swatch').classList.add('active');
  activeColor = 'custom';
});

// Opacity
opSlider.addEventListener('input', () => {
  activeOpacity = +opSlider.value;
  opVal.textContent = activeOpacity + '%';
});

// Save
document.getElementById('save-btn').addEventListener('click', saveFile);

// Open file
[document.getElementById('header-file-btn'), document.getElementById('dz-file-btn'), addTabBtn].forEach(btn => {
  if (btn) btn.addEventListener('click', () => fileInput.click());
});
fileInput.addEventListener('change', e => { openFiles(e.target.files); fileInput.value = ''; });

// URL inputs
const hUrlInput = document.getElementById('header-url-input');
document.getElementById('url-load-btn').addEventListener('click', () => loadFromUrl(hUrlInput.value, hUrlInput));
hUrlInput.addEventListener('keydown', e => { if (e.key==='Enter') loadFromUrl(hUrlInput.value, hUrlInput); });
hUrlInput.addEventListener('paste', e => {
  const p = (e.clipboardData||window.clipboardData).getData('text').trim();
  if (p.startsWith('http://') || p.startsWith('https://')) { e.preventDefault(); loadFromUrl(p, hUrlInput); }
});

const dzUrlInput = document.getElementById('dz-url-input');
document.getElementById('dz-url-btn').addEventListener('click', () => loadFromUrl(dzUrlInput.value, dzUrlInput));
dzUrlInput.addEventListener('keydown', e => { if (e.key==='Enter') loadFromUrl(dzUrlInput.value, dzUrlInput); });
dzUrlInput.addEventListener('paste', e => {
  const p = (e.clipboardData||window.clipboardData).getData('text').trim();
  if (p.startsWith('http://') || p.startsWith('https://')) { e.preventDefault(); loadFromUrl(p, dzUrlInput); }
});

// Sidebar toggle
document.getElementById('sidebar-toggle').addEventListener('click', () => {
  const sb = document.getElementById('thumb-sidebar');
  sb.classList.toggle('open');
});

/* ═══════════════════════════════════════════
   DRAG & DROP
   ═══════════════════════════════════════════ */
const dzEl = document.getElementById('drop-zone');
dzEl.addEventListener('dragover',  e => { e.preventDefault(); dzEl.classList.add('drag-over'); });
dzEl.addEventListener('dragleave', e => { if (!dzEl.contains(e.relatedTarget)) dzEl.classList.remove('drag-over'); });
dzEl.addEventListener('drop', e => {
  e.preventDefault(); dzEl.classList.remove('drag-over');
  if (e.dataTransfer.files.length) openFiles(e.dataTransfer.files);
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  if (e.dataTransfer.files.length) openFiles(e.dataTransfer.files);
});

/* ═══════════════════════════════════════════
   MOBILE BAR
   ═══════════════════════════════════════════ */
document.getElementById('mb-file').addEventListener('click', () => fileInput.click());
document.getElementById('mb-save').addEventListener('click', saveFile);

// Mobile mode cycle
document.getElementById('mb-mode').addEventListener('click', () => {
  const modes = ['highlight','erase','pan'];
  const next  = modes[(modes.indexOf(drawMode)+1) % modes.length];
  document.querySelector(`.tool-btn[data-mode="${next}"]`).click();
});

// Mobile color modal
document.getElementById('mb-color').addEventListener('click', () => {
  // Populate mob color grid
  const grid = document.getElementById('mob-color-grid');
  grid.innerHTML = '';
  Object.entries(COLOR_MAP).forEach(([name, c]) => {
    const s = document.createElement('div');
    s.className = `mob-swatch${activeColor===name?' active':''}`;
    s.style.background = name==='custom'
      ? 'conic-gradient(red,yellow,green,cyan,blue,magenta,red)'
      : c.hex;
    s.title = name;
    s.addEventListener('click', () => {
      document.querySelectorAll('.mob-swatch').forEach(x => x.classList.remove('active'));
      s.classList.add('active');
      activeColor = name;
      // sync desktop swatch
      document.querySelectorAll('.swatch').forEach(x => x.classList.toggle('active', x.dataset.color===name));
    });
    grid.appendChild(s);
  });
  document.getElementById('color-modal').classList.remove('hidden');
});
document.getElementById('close-color-modal').addEventListener('click', () =>
  document.getElementById('color-modal').classList.add('hidden')
);
document.getElementById('color-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('color-modal'))
    document.getElementById('color-modal').classList.add('hidden');
});

// Mobile highlight list modal
document.getElementById('mb-hi').addEventListener('click', () => {
  const tab = getTab();
  const all = tab ? tab.highlights : [];
  const ml  = document.getElementById('mob-hi-list');

  if (!all.length) {
    ml.innerHTML = '<div class="hi-empty" style="padding:24px 0;text-align:center;color:#999">হাইলাইট নেই</div>';
  } else {
    ml.innerHTML = all.map((h,i) => {
      const c = COLOR_MAP[h.color];
      return `<div class="hi-item">
        <div class="hi-dot" style="background:${c.hex}"></div>
        <div class="hi-meta">
          <div class="hi-label">হাইলাইট ${i+1} — পেজ ${h.page}</div>
          <div class="hi-sub">${Math.round(h.w)}×${Math.round(h.h)}px</div>
        </div>
        <button class="hi-del" style="opacity:1" onclick="deleteHighlight(${h.id});document.getElementById('mob-hi-list').innerHTML=''">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>`;
    }).join('');
  }
  document.getElementById('hi-modal').classList.remove('hidden');
});
document.getElementById('close-hi-modal').addEventListener('click', () =>
  document.getElementById('hi-modal').classList.add('hidden')
);
document.getElementById('hi-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('hi-modal'))
    document.getElementById('hi-modal').classList.add('hidden');
});

/* ═══════════════════════════════════════════
   KEYBOARD SHORTCUTS
   ═══════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && e.key === 's') { e.preventDefault(); saveFile(); return; }
  if (ctrl && e.key === 'o') { e.preventDefault(); fileInput.click(); return; }
  if (ctrl && e.key === 'z') { e.preventDefault(); undo(); return; }
  if (ctrl && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
  if (ctrl && e.key === '=') { e.preventDefault(); setZoom(zoomLevel + 0.25); return; }
  if (ctrl && e.key === '-') { e.preventDefault(); setZoom(zoomLevel - 0.25); return; }
  if (e.key === 'h' || e.key === 'H') { document.querySelector('.tool-btn[data-mode="highlight"]').click(); return; }
  if (e.key === 'e' || e.key === 'E') { document.querySelector('.tool-btn[data-mode="erase"]').click(); return; }
  if (e.key === 'v' || e.key === 'V') { document.querySelector('.tool-btn[data-mode="pan"]').click(); return; }
});

/* ═══════════════════════════════════════════
   PINCH ZOOM (mobile)
   ═══════════════════════════════════════════ */
let pinchDist = 0;
document.getElementById('pdf-viewer').addEventListener('touchstart', e => {
  if (e.touches.length === 2) {
    pinchDist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
  }
}, { passive: true });

document.getElementById('pdf-viewer').addEventListener('touchmove', e => {
  if (e.touches.length === 2) {
    const d = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    const delta = d - pinchDist;
    pinchDist = d;
    if (Math.abs(delta) > 2) setZoom(zoomLevel + delta * 0.005);
  }
}, { passive: true });

/* ═══════════════════════════════════════════
   SCROLL → THUMB SYNC
   ═══════════════════════════════════════════ */
document.getElementById('pdf-viewer').addEventListener('scroll', () => {
  const viewer = document.getElementById('pdf-viewer');
  const midY   = viewer.scrollTop + viewer.clientHeight / 2;
  let   active = null;
  pagesContainer.querySelectorAll('.page-wrapper').forEach(w => {
    const top = w.offsetTop;
    const bot = top + w.offsetHeight;
    if (midY >= top && midY < bot) active = +w.dataset.page;
  });
  if (active) {
    thumbList.querySelectorAll('.thumb-item').forEach(t => {
      t.classList.toggle('active', +t.dataset.page === active);
    });
  }
}, { passive: true });
