/**
 * AnnotaPDF — PDF & Image Highlighter
 * app.js — Main Application Logic
 * Author: AnnotaPDF Team
 * Version: 4.0.0
 * License: MIT
 *
 * Dependencies:
 *   - pdf.js  v3.11.174  (CDN)
 *   - jsPDF   v2.5.1     (CDN)
 */

'use strict';

/* ════════════════════════════════════════════
   PDF.JS WORKER CONFIG
   ════════════════════════════════════════════ */
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

/* ════════════════════════════════════════════
   CONSTANTS
   ════════════════════════════════════════════ */

/** Preset highlight colors (name → RGBA components + hex) */
const COLOR_MAP = {
  yellow: { r: 255, g: 193, b: 7,   hex: '#FFC107' },
  green:  { r:  81, g: 207, b: 102, hex: '#51CF66' },
  blue:   { r:  51, g: 154, b: 240, hex: '#339AF0' },
  red:    { r: 255, g: 107, b: 107, hex: '#FF6B6B' },
  pink:   { r: 240, g: 101, b: 149, hex: '#F06595' },
  orange: { r: 255, g: 146, b:  43, hex: '#FF922B' },
  purple: { r: 151, g: 117, b: 250, hex: '#9775FA' },
  cyan:   { r:  34, g: 211, b: 238, hex: '#22D3EE' },
  custom: { r: 255, g: 193, b:   7, hex: '#FFC107' }, // user-defined
};

const PDF_RENDER_SCALE  = 1.5;   // Default display scale
const SAVE_RENDER_SCALE = 3.0;   // High-resolution for exported PDF/PNG
const MAX_HISTORY_STEPS = 50;    // Undo stack limit
const MIN_HIGHLIGHT_PX  = 5;     // Minimum rect size to register a highlight

/* ════════════════════════════════════════════
   APPLICATION STATE
   ════════════════════════════════════════════ */

let tabs         = [];           // Array of TabState instances
let activeTabId  = null;
let drawMode     = 'highlight';  // 'highlight' | 'erase' | 'pan'
let activeColor  = 'yellow';
let activeOpacity = 100;         // 10–100 %
let isDrawing    = false;
let startX       = 0;
let startY       = 0;
let panStartX    = 0;
let panStartY    = 0;
let panScrollX   = 0;
let panScrollY   = 0;

/** Active PDF.js render task — cancelled when switching pages */
let currentRenderTask = null;

/** Auto-incrementing tab ID counter */
let tabIdCounter = 0;

/* ════════════════════════════════════════════
   TAB STATE CLASS
   ════════════════════════════════════════════ */
class TabState {
  /**
   * @param {number} id
   * @param {string} name  File name
   * @param {'pdf'|'image'} type
   */
  constructor(id, name, type) {
    this.id          = id;
    this.name        = name;
    this.type        = type;
    this.pdfDoc      = null;     // pdfjsLib PDFDocumentProxy
    this.imgElement  = null;     // HTMLImageElement
    this.imgSrc      = null;     // object URL or remote URL
    this.currentPage = 1;
    this.totalPages  = 1;
    this.scale       = PDF_RENDER_SCALE;
    this.baseScale   = PDF_RENDER_SCALE;
    this.rotation    = 0;        // degrees: 0 | 90 | 180 | 270

    /** @type {Array<{id:number, page:number, x:number, y:number, w:number, h:number, color:string, opacity:number}>} */
    this.highlights  = [];

    this.history     = [];       // Undo stack (array of deep-cloned highlight arrays)
    this.future      = [];       // Redo stack
  }

  /** Returns the DOM tab element for this TabState */
  get tabEl() {
    return document.querySelector(`.tab[data-id="${this.id}"]`);
  }
}

/* ════════════════════════════════════════════
   DOM REFERENCES
   ════════════════════════════════════════════ */
const tabBar        = document.getElementById('tab-bar');
const addTabBtn     = document.getElementById('add-tab-btn');
const dropZone      = document.getElementById('drop-zone');
const canvasArea    = document.getElementById('canvas-area');
const canvasWrapper = document.getElementById('canvas-wrapper');
const pdfCanvas     = document.getElementById('pdf-canvas');
const overlayCanvas = document.getElementById('overlay-canvas');
const drawCanvas    = document.getElementById('draw-canvas');
const sidebar       = document.getElementById('sidebar');
const hiList        = document.getElementById('hi-list');
const hiEmpty       = document.getElementById('hi-empty');
const hiCountBadge  = document.getElementById('hi-count');
const infoContent   = document.getElementById('info-content');
const pageLabel     = document.getElementById('page-label');
const zoomLabel     = document.getElementById('zoom-label');
const fileInput     = document.getElementById('file-input');
const loadBar       = document.getElementById('load-bar');

const ctx  = pdfCanvas.getContext('2d');
const octx = overlayCanvas.getContext('2d');
const dctx = drawCanvas.getContext('2d');

/* ════════════════════════════════════════════
   LOADING BAR
   ════════════════════════════════════════════ */
/**
 * Control the top progress bar.
 * @param {number} pct  0 = show & start, 100 = finish & hide, else set width
 */
function setLoadBar(pct) {
  if (pct === 0) {
    loadBar.style.display = 'block';
    loadBar.style.width   = '5%';
  } else if (pct >= 100) {
    loadBar.style.width = '100%';
    setTimeout(() => {
      loadBar.style.display = 'none';
      loadBar.style.width   = '0%';
    }, 380);
  } else {
    loadBar.style.width = pct + '%';
  }
}

/* ════════════════════════════════════════════
   TOAST NOTIFICATION
   ════════════════════════════════════════════ */
let toastTimer = null;

/**
 * Show a brief toast notification.
 * @param {string} msg
 * @param {'success'|'error'|'warning'|''} type
 */
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.innerHTML = msg;
  el.className = type ? `show ${type}` : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 2800);
}

/* ════════════════════════════════════════════
   FILE HANDLING
   ════════════════════════════════════════════ */

/**
 * Open a FileList — dispatch each file by MIME type.
 * @param {FileList} files
 */
function openFiles(files) {
  [...files].forEach(f => {
    if (f.type === 'application/pdf')        loadPdfFile(f);
    else if (f.type.startsWith('image/'))    loadImageFile(f);
    else toast(`<i class="fa-solid fa-circle-exclamation"></i> সাপোর্টেড নয়: ${f.name}`, 'error');
  });
}

/**
 * Load a PDF File object via pdf.js.
 * @param {File} file
 */
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
    activateTab(tab.id);
    setLoadBar(100);
    toast(`<i class="fa-solid fa-circle-check"></i> ${file.name} লোড হয়েছে (${doc.numPages} পেজ)`, 'success');
  } catch (e) {
    setLoadBar(100);
    console.error('[AnnotaPDF] PDF load error:', e);
    toast('<i class="fa-solid fa-circle-xmark"></i> PDF লোড ব্যর্থ হয়েছে', 'error');
  }
}

/**
 * Load an image File object.
 * @param {File} file
 */
function loadImageFile(file) {
  setLoadBar(0);
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    setLoadBar(80);
    const tab = createTab(file.name, 'image');
    tab.imgElement = img;
    tab.imgSrc     = url;
    tab.totalPages = 1;
    activateTab(tab.id);
    setLoadBar(100);
    toast(`<i class="fa-solid fa-circle-check"></i> ${file.name} লোড হয়েছে`, 'success');
  };
  img.onerror = () => {
    setLoadBar(100);
    URL.revokeObjectURL(url);
    toast('<i class="fa-solid fa-circle-xmark"></i> ইমেজ লোড ব্যর্থ হয়েছে', 'error');
  };
  img.src = url;
}

/**
 * Load a file from a URL string.
 * Clears the source input after triggering.
 * @param {string} rawUrl
 * @param {HTMLInputElement|null} inputEl  Input element to clear
 */
function loadFromUrl(rawUrl, inputEl = null) {
  const url = rawUrl.trim();
  if (!url) {
    toast('<i class="fa-solid fa-triangle-exclamation"></i> URL দিন', 'warning');
    return;
  }
  if (inputEl) inputEl.value = '';
  setLoadBar(0);

  const ext   = url.split('?')[0].split('.').pop().toLowerCase();
  const isImg = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg'].includes(ext);

  if (isImg) loadImageUrl(url);
  else       loadPdfUrl(url);
}

/**
 * Load image from remote URL.
 * @param {string} url
 */
function loadImageUrl(url) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    setLoadBar(80);
    const name = url.split('/').pop().split('?')[0] || 'image';
    const tab  = createTab(name, 'image');
    tab.imgElement = img;
    tab.imgSrc     = url;
    activateTab(tab.id);
    setLoadBar(100);
    toast('<i class="fa-solid fa-circle-check"></i> ইমেজ লোড হয়েছে', 'success');
  };
  img.onerror = () => {
    setLoadBar(100);
    toast('<i class="fa-solid fa-circle-xmark"></i> ইমেজ লোড ব্যর্থ', 'error');
  };
  img.src = url;
}

/**
 * Load PDF from remote URL.
 * Uses fetch() through CORS proxies to get ArrayBuffer,
 * then passes data directly to pdf.js — bypasses CORS block.
 * @param {string} rawUrl
 */
async function loadPdfUrl(rawUrl) {
  const name = rawUrl.split('/').pop().split('?')[0] || 'document.pdf';

  // Proxy list — fetch returns ArrayBuffer, avoiding pdf.js CORS issues
  const proxies = [
    (u) => fetch(`https://corsproxy.io/?${encodeURIComponent(u)}`),
    (u) => fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`),
    (u) => fetch(u),  // direct last (works if server has CORS headers)
  ];

  for (const proxyFn of proxies) {
    try {
      const res = await proxyFn(rawUrl);
      if (!res.ok) continue;
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength < 100) continue;  // sanity check
      const doc = await pdfjsLib.getDocument({ data: buffer }).promise;
      setLoadBar(80);
      const tab      = createTab(name, 'pdf');
      tab.pdfDoc     = doc;
      tab.totalPages = doc.numPages;
      activateTab(tab.id);
      setLoadBar(100);
      toast('<i class="fa-solid fa-circle-check"></i> PDF লোড হয়েছে', 'success');
      return;
    } catch (e) {
      // try next proxy
    }
  }

  setLoadBar(100);
  toast('<i class="fa-solid fa-circle-xmark"></i> PDF লোড ব্যর্থ — URL টি সরাসরি অ্যাক্সেসযোগ্য কিনা দেখুন।', 'error');
}

/* ════════════════════════════════════════════
   TAB MANAGEMENT
   ════════════════════════════════════════════ */

/**
 * Create a new tab and register it in the tab bar.
 * @param {string} name
 * @param {'pdf'|'image'} type
 * @returns {TabState}
 */
function createTab(name, type) {
  const id  = ++tabIdCounter;
  const tab = new TabState(id, name, type);
  tabs.push(tab);
  renderTabElement(tab);
  return tab;
}

/**
 * Render a tab DOM element and insert before the "+" button.
 * @param {TabState} tab
 */
function renderTabElement(tab) {
  const el = document.createElement('div');
  el.className    = 'tab';
  el.dataset.id   = tab.id;
  el.title        = tab.name;
  el.innerHTML = `
    <span class="tab-badge ${tab.type}">${tab.type === 'pdf' ? 'PDF' : 'IMG'}</span>
    <span class="tab-name">${tab.name}</span>
    <span class="tab-close" data-id="${tab.id}" title="বন্ধ করুন">
      <i class="fa-solid fa-xmark"></i>
    </span>
  `;
  el.addEventListener('click', e => {
    if (e.target.closest('.tab-close')) { closeTab(tab.id); return; }
    activateTab(tab.id);
  });
  tabBar.insertBefore(el, addTabBtn);
}

/**
 * Activate a tab — update UI and render its content.
 * @param {number} id
 */
function activateTab(id) {
  activeTabId = id;
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', +t.dataset.id === id)
  );
  dropZone.classList.add('hidden');
  canvasArea.classList.remove('hidden');
  sidebar.classList.add('visible');

  const tab = getTab();
  setScale(tab.scale, false);
  renderPage();
}

/**
 * Close a tab and clean up.
 * @param {number} id
 */
function closeTab(id) {
  const idx = tabs.findIndex(t => t.id === id);
  if (idx < 0) return;

  // Revoke object URLs for local images
  const tab = tabs[idx];
  if (tab.type === 'image' && tab.imgSrc && tab.imgSrc.startsWith('blob:')) {
    URL.revokeObjectURL(tab.imgSrc);
  }

  tabs.splice(idx, 1);
  document.querySelector(`.tab[data-id="${id}"]`)?.remove();

  if (tabs.length === 0) {
    activeTabId = null;
    dropZone.classList.remove('hidden');
    canvasArea.classList.add('hidden');
    sidebar.classList.remove('visible');
    clearCanvases();
  } else {
    activateTab(tabs[Math.min(idx, tabs.length - 1)].id);
  }
}

/** @returns {TabState|null} Currently active tab */
function getTab() {
  return tabs.find(t => t.id === activeTabId) || null;
}

/* ════════════════════════════════════════════
   RENDERING
   ════════════════════════════════════════════ */

/**
 * Render the current page of the active tab.
 * Cancels any in-progress render task first.
 */
async function renderPage() {
  const tab = getTab();
  if (!tab) return;

  // Cancel any in-flight render
  if (currentRenderTask) {
    try { currentRenderTask.cancel(); } catch (_) {}
    currentRenderTask = null;
  }

  if (tab.type === 'pdf') {
    await renderPdfPage(tab);
  } else {
    renderImagePage(tab);
  }

  redrawHighlights();
  updatePageLabel();
  updateSidebar();
  updateInfoPanel();
}

/**
 * Render a single PDF page onto the main canvas.
 * @param {TabState} tab
 */
async function renderPdfPage(tab) {
  try {
    const page = await tab.pdfDoc.getPage(tab.currentPage);
    const vp   = page.getViewport({ scale: tab.scale, rotation: tab.rotation });

    setCanvasSize(vp.width, vp.height);
    ctx.clearRect(0, 0, vp.width, vp.height);

    const renderTask = page.render({ canvasContext: ctx, viewport: vp });
    currentRenderTask = renderTask;
    await renderTask.promise;
    currentRenderTask = null;
  } catch (e) {
    if (e?.name === 'RenderingCancelledException') return;
    console.error('[AnnotaPDF] Page render error:', e);
  }
}

/**
 * Render an image (with optional rotation) onto the main canvas.
 * @param {TabState} tab
 */
function renderImagePage(tab) {
  const { imgElement: img, scale: sc, rotation: rot } = tab;
  const sw = img.naturalWidth;
  const sh = img.naturalHeight;

  const cw = (rot === 90 || rot === 270) ? sh * sc : sw * sc;
  const ch = (rot === 90 || rot === 270) ? sw * sc : sh * sc;

  setCanvasSize(cw, ch);
  ctx.clearRect(0, 0, cw, ch);
  ctx.save();
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate(rot * Math.PI / 180);
  ctx.drawImage(img, -sw * sc / 2, -sh * sc / 2, sw * sc, sh * sc);
  ctx.restore();
}

/**
 * Synchronise canvas element sizes and wrapper dimensions.
 * @param {number} w
 * @param {number} h
 */
function setCanvasSize(w, h) {
  [pdfCanvas, overlayCanvas, drawCanvas].forEach(c => {
    c.width  = w;
    c.height = h;
  });
  canvasWrapper.style.width  = w + 'px';
  canvasWrapper.style.height = h + 'px';
}

/** Clear all three canvases */
function clearCanvases() {
  ctx.clearRect(0, 0, pdfCanvas.width, pdfCanvas.height);
  octx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  dctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
}

/* ════════════════════════════════════════════
   HIGHLIGHT RENDERING
   ════════════════════════════════════════════ */

/**
 * Redraw all highlights for the current page onto the overlay canvas.
 * Uses multiply blend mode so text under highlights stays visible.
 */
function redrawHighlights() {
  const tab = getTab();
  if (!tab) return;

  octx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  tab.highlights
    .filter(h => h.page === tab.currentPage)
    .forEach(h => {
      const c = COLOR_MAP[h.color];
      octx.fillStyle = `rgba(${c.r},${c.g},${c.b},${h.opacity / 100})`;
      octx.fillRect(h.x, h.y, h.w, h.h);
    });
}

/* ════════════════════════════════════════════
   DRAWING INTERACTION
   ════════════════════════════════════════════ */

/**
 * Get the device-pixel ratio between CSS pixels and canvas pixels.
 * @returns {number}
 */
function getCanvasScaleRatio() {
  return pdfCanvas.width / pdfCanvas.getBoundingClientRect().width;
}

/**
 * Convert clientX/Y to canvas coordinates.
 * @param {number} clientX
 * @param {number} clientY
 * @returns {{x:number, y:number}}
 */
function clientToCanvas(clientX, clientY) {
  const rect = pdfCanvas.getBoundingClientRect();
  const ratio = getCanvasScaleRatio();
  return {
    x: (clientX - rect.left)  * ratio,
    y: (clientY - rect.top) * ratio,
  };
}

// Mouse events
canvasWrapper.addEventListener('mousedown',  onPointerDown);
canvasWrapper.addEventListener('mousemove',  onPointerMove);
canvasWrapper.addEventListener('mouseup',    onPointerUp);
canvasWrapper.addEventListener('mouseleave', () => {
  if (isDrawing) {
    isDrawing = false;
    dctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  }
});

// Touch events
canvasWrapper.addEventListener('touchstart', e => {
  e.preventDefault();
  const t = e.touches[0];
  onPointerDown({ clientX: t.clientX, clientY: t.clientY });
}, { passive: false });

canvasWrapper.addEventListener('touchmove', e => {
  e.preventDefault();
  const t = e.touches[0];
  onPointerMove({ clientX: t.clientX, clientY: t.clientY });
}, { passive: false });

canvasWrapper.addEventListener('touchend', e => {
  e.preventDefault();
  const t = e.changedTouches[0];
  onPointerUp({ clientX: t.clientX, clientY: t.clientY });
}, { passive: false });

function onPointerDown(e) {
  if (!activeTabId) return;
  const pos = clientToCanvas(e.clientX, e.clientY);
  startX    = pos.x;
  startY    = pos.y;
  isDrawing = true;

  if (drawMode === 'pan') {
    panStartX  = e.clientX;
    panStartY  = e.clientY;
    panScrollX = canvasArea.scrollLeft;
    panScrollY = canvasArea.scrollTop;
  }
  dctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
}

function onPointerMove(e) {
  if (!isDrawing) return;
  const pos = clientToCanvas(e.clientX, e.clientY);

  if (drawMode === 'pan') {
    canvasArea.scrollLeft = panScrollX - (e.clientX - panStartX);
    canvasArea.scrollTop  = panScrollY - (e.clientY - panStartY);
    return;
  }

  if (drawMode === 'highlight') {
    const x = Math.min(startX, pos.x);
    const y = Math.min(startY, pos.y);
    const w = Math.abs(pos.x - startX);
    const h = Math.abs(pos.y - startY);

    dctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);

    const c = COLOR_MAP[activeColor];
    dctx.fillStyle   = `rgba(${c.r},${c.g},${c.b},${activeOpacity / 100})`;
    dctx.fillRect(x, y, w, h);

    dctx.strokeStyle = c.hex;
    dctx.lineWidth   = 1.5;
    dctx.setLineDash([6, 3]);
    dctx.strokeRect(x, y, w, h);
    dctx.setLineDash([]);
  }

  if (drawMode === 'erase') {
    eraseAt(pos.x, pos.y);
  }
}

function onPointerUp(e) {
  if (!isDrawing) return;
  isDrawing = false;
  dctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);

  if (drawMode === 'pan' || drawMode === 'erase') return;

  const tab = getTab();
  if (!tab) return;

  const pos = clientToCanvas(e.clientX, e.clientY);
  const x   = Math.min(startX, pos.x);
  const y   = Math.min(startY, pos.y);
  const w   = Math.abs(pos.x - startX);
  const h   = Math.abs(pos.y - startY);

  if (w < MIN_HIGHLIGHT_PX || h < MIN_HIGHLIGHT_PX) return;

  pushHistory(tab);
  tab.highlights.push({
    id:      Date.now(),
    page:    tab.currentPage,
    x, y, w, h,
    color:   activeColor,
    opacity: activeOpacity,
  });

  redrawHighlights();
  updateSidebar();
  toast('<i class="fa-solid fa-highlighter"></i> হাইলাইট যোগ হয়েছে');
}

/**
 * Erase any highlight whose bounding box contains the given point.
 * @param {number} cx  Canvas X
 * @param {number} cy  Canvas Y
 */
function eraseAt(cx, cy) {
  const tab = getTab();
  if (!tab) return;

  const before = tab.highlights.length;
  tab.highlights = tab.highlights.filter(h => {
    if (h.page !== tab.currentPage) return true;
    return !(cx >= h.x && cx <= h.x + h.w && cy >= h.y && cy <= h.y + h.h);
  });

  if (tab.highlights.length < before) {
    redrawHighlights();
    updateSidebar();
  }
}

/**
 * Delete a specific highlight by its ID.
 * @param {number} id
 */
function deleteHighlight(id) {
  const tab = getTab();
  if (!tab) return;
  pushHistory(tab);
  tab.highlights = tab.highlights.filter(h => h.id !== id);
  redrawHighlights();
  updateSidebar();
  toast('<i class="fa-solid fa-trash-can"></i> হাইলাইট মুছা হয়েছে');
}

/* ════════════════════════════════════════════
   UNDO / REDO
   ════════════════════════════════════════════ */

/**
 * Push a deep clone of current highlights onto the undo stack.
 * @param {TabState} tab
 */
function pushHistory(tab) {
  tab.history.push(JSON.parse(JSON.stringify(tab.highlights)));
  tab.future = [];
  if (tab.history.length > MAX_HISTORY_STEPS) tab.history.shift();
}

function undo() {
  const tab = getTab();
  if (!tab || !tab.history.length) return;
  tab.future.push(JSON.parse(JSON.stringify(tab.highlights)));
  tab.highlights = tab.history.pop();
  redrawHighlights();
  updateSidebar();
  toast('<i class="fa-solid fa-rotate-left"></i> আনডু');
}

function redo() {
  const tab = getTab();
  if (!tab || !tab.future.length) return;
  tab.history.push(JSON.parse(JSON.stringify(tab.highlights)));
  tab.highlights = tab.future.pop();
  redrawHighlights();
  updateSidebar();
  toast('<i class="fa-solid fa-rotate-right"></i> রিডু');
}

/* ════════════════════════════════════════════
   ZOOM
   ════════════════════════════════════════════ */

/**
 * Change render scale, proportionally mapping existing highlight coords.
 * @param {number} newScale
 * @param {boolean} [rerender=true]
 */
function setScale(newScale, rerender = true) {
  const tab = getTab();
  if (!tab) return;

  const ratio = newScale / tab.scale;
  tab.highlights = tab.highlights.map(h => ({
    ...h,
    x: h.x * ratio,
    y: h.y * ratio,
    w: h.w * ratio,
    h: h.h * ratio,
  }));

  tab.scale = newScale;
  zoomLabel.textContent = Math.round(newScale / tab.baseScale * 100) + '%';
  if (rerender) renderPage();
}

document.getElementById('zoom-in').addEventListener('click', () => {
  const tab = getTab(); if (!tab) return;
  setScale(Math.min(tab.scale + 0.25, 5));
});

document.getElementById('zoom-out').addEventListener('click', () => {
  const tab = getTab(); if (!tab) return;
  setScale(Math.max(tab.scale - 0.25, 0.25));
});

document.getElementById('zoom-fit').addEventListener('click', async () => {
  const tab = getTab(); if (!tab) return;
  const areaW = canvasArea.clientWidth - 48;
  let naturalW;

  if (tab.type === 'pdf') {
    const page = await tab.pdfDoc.getPage(tab.currentPage);
    const vp   = page.getViewport({ scale: 1, rotation: tab.rotation });
    naturalW   = vp.width;
  } else {
    const r = tab.rotation;
    naturalW = (r === 90 || r === 270)
      ? tab.imgElement.naturalHeight
      : tab.imgElement.naturalWidth;
  }

  const fit = areaW / naturalW;
  tab.baseScale = fit;
  setScale(fit);
});

/* ════════════════════════════════════════════
   ROTATION
   ════════════════════════════════════════════ */

/**
 * Rotate the document and remap highlight coordinates.
 * @param {'cw'|'ccw'} dir
 */
async function rotate(dir) {
  const tab = getTab();
  if (!tab) return;

  const oldW = pdfCanvas.width;
  const oldH = pdfCanvas.height;
  tab.rotation = (tab.rotation + (dir === 'cw' ? 90 : -90) + 360) % 360;

  tab.highlights = tab.highlights.map(h => {
    let nx, ny, nw, nh;
    if (dir === 'cw') {
      nx = oldH - h.y - h.h;
      ny = h.x;
      nw = h.h;
      nh = h.w;
    } else {
      nx = h.y;
      ny = oldW - h.x - h.w;
      nw = h.h;
      nh = h.w;
    }
    return { ...h, x: nx, y: ny, w: nw, h: nh };
  });

  await renderPage();
  toast('<i class="fa-solid fa-rotate"></i> রোটেট করা হয়েছে');
}

document.getElementById('rot-cw').addEventListener('click',  () => rotate('cw'));
document.getElementById('rot-ccw').addEventListener('click', () => rotate('ccw'));

/* ════════════════════════════════════════════
   PAGE NAVIGATION
   ════════════════════════════════════════════ */

function updatePageLabel() {
  const tab = getTab();
  if (!tab) {
    pageLabel.textContent = '— / —';
    return;
  }
  pageLabel.textContent = `${tab.currentPage} / ${tab.totalPages}`;
  document.getElementById('prev-page').disabled = tab.currentPage <= 1;
  document.getElementById('next-page').disabled = tab.currentPage >= tab.totalPages;
}

// Click page label → jump to page dialog
pageLabel.addEventListener('click', () => {
  const tab = getTab();
  if (!tab || tab.totalPages <= 1) return;

  const input = prompt(`পেজ নম্বর লিখুন (১ – ${tab.totalPages}):`, tab.currentPage);
  if (input === null) return;

  const n = parseInt(input, 10);
  if (isNaN(n) || n < 1 || n > tab.totalPages) {
    toast('<i class="fa-solid fa-triangle-exclamation"></i> অবৈধ পেজ নম্বর', 'error');
    return;
  }
  tab.currentPage = n;
  setLoadBar(0);
  renderPage().then(() => setLoadBar(100));
});

document.getElementById('prev-page').addEventListener('click', async () => {
  const tab = getTab(); if (!tab || tab.currentPage <= 1) return;
  tab.currentPage--;
  setLoadBar(0);
  await renderPage();
  setLoadBar(100);
});

document.getElementById('next-page').addEventListener('click', async () => {
  const tab = getTab(); if (!tab || tab.currentPage >= tab.totalPages) return;
  tab.currentPage++;
  setLoadBar(0);
  await renderPage();
  setLoadBar(100);
});

/* ════════════════════════════════════════════
   SAVE / EXPORT
   ════════════════════════════════════════════ */

/** Entry point — route to PDF or image saver. */
async function saveFile() {
  const tab = getTab();
  if (!tab) {
    toast('<i class="fa-solid fa-triangle-exclamation"></i> কোনো ফাইল খোলা নেই', 'error');
    return;
  }
  if (tab.type === 'image') saveImageFile(tab);
  else                      await savePdfFile(tab);
}

/**
 * Export image file as a high-resolution PNG.
 * @param {TabState} tab
 */
function saveImageFile(tab) {
  const out  = document.createElement('canvas');
  out.width  = pdfCanvas.width;
  out.height = pdfCanvas.height;
  const mctx = out.getContext('2d');

  mctx.drawImage(pdfCanvas, 0, 0);
  mctx.globalCompositeOperation = 'multiply';

  tab.highlights
    .filter(h => h.page === tab.currentPage)
    .forEach(h => {
      const c = COLOR_MAP[h.color];
      mctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${h.opacity / 100})`;
      mctx.fillRect(h.x, h.y, h.w, h.h);
    });

  mctx.globalCompositeOperation = 'source-over';

  const a      = document.createElement('a');
  a.download   = tab.name.replace(/\.[^.]+$/, '') + '-highlighted.png';
  a.href       = out.toDataURL('image/png');
  a.click();

  toast('<i class="fa-solid fa-floppy-disk"></i> ইমেজ ডাউনলোড হচ্ছে...', 'success');
}

/**
 * Export PDF with all highlights baked in at high resolution.
 * @param {TabState} tab
 */
async function savePdfFile(tab) {
  toast('<i class="fa-solid fa-spinner fa-spin"></i> PDF তৈরি হচ্ছে...');
  setLoadBar(0);

  try {
    const { jsPDF } = window.jspdf;
    let pdf       = null;
    let firstPage = true;

    for (let pageNum = 1; pageNum <= tab.totalPages; pageNum++) {
      setLoadBar(Math.round((pageNum / tab.totalPages) * 90));

      const page = await tab.pdfDoc.getPage(pageNum);
      const vp   = page.getViewport({ scale: SAVE_RENDER_SCALE, rotation: tab.rotation });

      // Render page
      const tc   = document.createElement('canvas');
      tc.width   = vp.width;
      tc.height  = vp.height;
      const tctx = tc.getContext('2d');
      await page.render({ canvasContext: tctx, viewport: vp }).promise;

      // Bake highlights for this page
      tctx.globalCompositeOperation = 'multiply';
      const ratio = SAVE_RENDER_SCALE / tab.scale;

      tab.highlights
        .filter(h => h.page === pageNum)
        .forEach(h => {
          const c = COLOR_MAP[h.color];
          tctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${h.opacity / 100})`;
          tctx.fillRect(h.x * ratio, h.y * ratio, h.w * ratio, h.h * ratio);
        });

      tctx.globalCompositeOperation = 'source-over';

      // Convert to image and add to PDF
      const imgData = tc.toDataURL('image/jpeg', 0.97);
      const mmW     = vp.width  * 0.264583;  // px → mm at 96 dpi
      const mmH     = vp.height * 0.264583;

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
    toast('<i class="fa-solid fa-circle-check"></i> PDF সেভ হয়েছে', 'success');
  } catch (e) {
    setLoadBar(100);
    console.error('[AnnotaPDF] PDF save error:', e);
    toast('<i class="fa-solid fa-circle-xmark"></i> PDF সেভ ব্যর্থ: ' + e.message, 'error');
  }
}

/* ════════════════════════════════════════════
   SIDEBAR & INFO PANEL
   ════════════════════════════════════════════ */

/** Refresh the highlight list in the sidebar. */
function updateSidebar() {
  const tab    = getTab();
  const onPage = tab ? tab.highlights.filter(h => h.page === tab.currentPage) : [];

  hiCountBadge.textContent = tab ? tab.highlights.length : 0;

  if (!onPage.length) {
    hiList.innerHTML  = '';
    hiEmpty.style.display = 'block';
  } else {
    hiEmpty.style.display = 'none';
    hiList.innerHTML = onPage.map((h, i) => `
      <div class="hi-item" onclick="jumpToHighlight(${h.id})">
        <div class="hi-dot" style="background:${COLOR_MAP[h.color].hex}"></div>
        <div class="hi-meta">
          <div class="hi-label">হাইলাইট ${i + 1}</div>
          <div class="hi-sub">পেজ ${h.page} · ${Math.round(h.w)}×${Math.round(h.h)}px</div>
        </div>
        <button class="hi-del" onclick="event.stopPropagation(); deleteHighlight(${h.id})" title="মুছুন">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    `).join('');
  }

  updateMobileSidebar();
}

/**
 * Scroll the canvas to a specific highlight.
 * @param {number} id
 */
function jumpToHighlight(id) {
  const tab = getTab(); if (!tab) return;
  const h   = tab.highlights.find(x => x.id === id);
  if (!h) return;

  const ratio   = pdfCanvas.getBoundingClientRect().width / pdfCanvas.width;
  const scrollX = (h.x + h.w / 2) * ratio - canvasArea.clientWidth  / 2;
  const scrollY = (h.y + h.h / 2) * ratio - canvasArea.clientHeight / 2;

  canvasArea.scrollTo({ left: scrollX, top: scrollY, behavior: 'smooth' });
}

/** Refresh the info panel in the sidebar. */
function updateInfoPanel() {
  const tab = getTab();
  if (!tab) { infoContent.innerHTML = ''; return; }

  const zoomPct = Math.round(tab.scale / tab.baseScale * 100);
  const rows = [
    ['fa-file',          'নাম',      tab.name.length > 22 ? tab.name.slice(0, 20) + '…' : tab.name],
    ['fa-tag',           'ধরন',      tab.type === 'pdf' ? 'PDF' : 'ইমেজ'],
    ['fa-book-open',     'পেজ',      `${tab.currentPage} / ${tab.totalPages}`],
    ['fa-magnifying-glass','জুম',    zoomPct + '%'],
    ['fa-rotate',        'রোটেশন',  tab.rotation + '°'],
    ['fa-highlighter',   'হাইলাইট', tab.highlights.length + 'টি'],
    ['fa-layer-group',   'এই পেজে', tab.highlights.filter(h => h.page === tab.currentPage).length + 'টি'],
  ];

  infoContent.innerHTML = rows.map(([icon, k, v]) => `
    <div class="info-row">
      <span class="info-key"><i class="fa-solid ${icon}"></i>${k}</span>
      <span class="info-val">${v}</span>
    </div>
  `).join('');
}

/** Refresh the mobile sidebar sheet. */
function updateMobileSidebar() {
  const tab = getTab();
  const ms  = document.getElementById('mobile-sb-content');
  if (!ms) return;

  const onPage = tab ? tab.highlights.filter(h => h.page === tab.currentPage) : [];

  if (!onPage.length) {
    ms.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-highlighter empty-icon"></i>
        এখনো হাইলাইট নেই।
      </div>`;
    return;
  }

  ms.innerHTML = onPage.map((h, i) => `
    <div class="hi-item">
      <div class="hi-dot" style="background:${COLOR_MAP[h.color].hex}"></div>
      <div class="hi-meta">
        <div class="hi-label">হাইলাইট ${i + 1}</div>
        <div class="hi-sub">পেজ ${h.page}</div>
      </div>
      <button class="hi-del" onclick="deleteHighlight(${h.id}); closeMobileModal()">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>
  `).join('');
}

/* ════════════════════════════════════════════
   SIDEBAR TAB SWITCHING
   ════════════════════════════════════════════ */
document.querySelectorAll('.sb-tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.sb-tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.sb-panel').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById(t.dataset.panel).classList.add('active');
    if (t.dataset.panel === 'info-panel') updateInfoPanel();
  });
});

/* ════════════════════════════════════════════
   TOOLBAR CONTROLS
   ════════════════════════════════════════════ */

// Draw mode buttons
document.querySelectorAll('.mode-btn').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    drawMode = b.dataset.mode;

    canvasWrapper.classList.remove('tool-pan', 'tool-erase');
    if (drawMode === 'pan')   canvasWrapper.classList.add('tool-pan');
    if (drawMode === 'erase') canvasWrapper.classList.add('tool-erase');
  });
});

// Preset color swatches
document.querySelectorAll('.swatch:not(.custom-swatch)').forEach(s => {
  s.addEventListener('click', () => {
    document.querySelectorAll('.swatch').forEach(x => x.classList.remove('active'));
    s.classList.add('active');
    activeColor = s.dataset.color;
  });
});

// Custom color picker
document.getElementById('custom-color-picker').addEventListener('input', e => {
  const hex = e.target.value;
  const r   = parseInt(hex.slice(1, 3), 16);
  const g   = parseInt(hex.slice(3, 5), 16);
  const b   = parseInt(hex.slice(5, 7), 16);
  COLOR_MAP.custom = { r, g, b, hex };
  document.querySelector('.custom-swatch').style.background = hex;
  document.querySelectorAll('.swatch').forEach(x => x.classList.remove('active'));
  document.querySelector('.custom-swatch').classList.add('active');
  activeColor = 'custom';
  // Sync mobile grid
  const cpEl = document.querySelector('.cp-swatch[data-name="custom"]');
  if (cpEl) { cpEl.style.background = hex; cpEl.style.backgroundImage = 'none'; }
});

// Opacity slider
document.getElementById('op-slider').addEventListener('input', e => {
  activeOpacity = +e.target.value;
  document.getElementById('op-val').textContent = e.target.value + '%';
});

// Undo / Redo / Save / Clear
document.getElementById('undo-btn').addEventListener('click', undo);
document.getElementById('redo-btn').addEventListener('click', redo);
document.getElementById('save-btn').addEventListener('click', saveFile);
document.getElementById('clear-page-btn').addEventListener('click', () => {
  const tab = getTab(); if (!tab) return;
  pushHistory(tab);
  tab.highlights = tab.highlights.filter(h => h.page !== tab.currentPage);
  redrawHighlights();
  updateSidebar();
  toast('<i class="fa-solid fa-trash-can"></i> এই পেজের হাইলাইট মুছা হয়েছে');
});

/* ════════════════════════════════════════════
   FILE OPEN TRIGGERS
   ════════════════════════════════════════════ */
fileInput.addEventListener('change', e => {
  if (e.target.files.length) openFiles(e.target.files);
  e.target.value = '';
});

[
  document.getElementById('header-file-btn'),
  document.getElementById('dz-file-btn'),
  addTabBtn,
  document.getElementById('mb-file'),
].forEach(btn => {
  if (btn) btn.addEventListener('click', () => fileInput.click());
});

/* ════════════════════════════════════════════
   URL LOADING
   ════════════════════════════════════════════ */
document.getElementById('url-load-btn').addEventListener('click', () => {
  const inp = document.getElementById('header-url-input');
  loadFromUrl(inp.value, inp);
});
document.getElementById('header-url-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') loadFromUrl(e.target.value, e.target);
});

document.getElementById('dz-url-load-btn').addEventListener('click', () => {
  const inp = document.getElementById('dz-url-input');
  loadFromUrl(inp.value, inp);
});
document.getElementById('dz-url-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') loadFromUrl(e.target.value, e.target);
});

/* ════════════════════════════════════════════
   DRAG & DROP
   ════════════════════════════════════════════ */
dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('dragging');
});
dropZone.addEventListener('dragleave', e => {
  if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('dragging');
});
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragging');
  if (e.dataTransfer.files.length) openFiles(e.dataTransfer.files);
});

// Global drop
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  if (e.dataTransfer.files.length) openFiles(e.dataTransfer.files);
});

/* ════════════════════════════════════════════
   MOBILE CONTROLS
   ════════════════════════════════════════════ */
document.getElementById('mb-highlight').addEventListener('click', () => {
  const modes  = ['highlight', 'erase', 'pan'];
  const labels = { highlight: 'হাইলাইট', erase: 'ইরেজ', pan: 'প্যান' };
  const icons  = { highlight: 'fa-highlighter', erase: 'fa-eraser', pan: 'fa-hand' };
  const next   = modes[(modes.indexOf(drawMode) + 1) % modes.length];
  document.querySelector(`.mode-btn[data-mode="${next}"]`)?.click();
  const btn    = document.getElementById('mb-highlight');
  btn.querySelector('i').className = `fa-solid ${icons[next]}`;
  btn.querySelector('span').textContent = labels[next];
  toast(`<i class="fa-solid ${icons[next]}"></i> মোড: ${labels[next]}`);
});

document.getElementById('mb-rotate').addEventListener('click', () => rotate('cw'));
document.getElementById('mb-save').addEventListener('click', saveFile);

document.getElementById('mb-list').addEventListener('click', () => {
  updateMobileSidebar();
  document.getElementById('sidebar-modal').classList.add('open');
});

document.getElementById('sidebar-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('sidebar-modal')) closeMobileModal();
});

function closeMobileModal() {
  document.getElementById('sidebar-modal').classList.remove('open');
}

// Mobile color modal
document.getElementById('mb-color').addEventListener('click', () => {
  document.getElementById('color-modal').classList.add('open');
});
document.getElementById('close-color-modal').addEventListener('click', () => {
  document.getElementById('color-modal').classList.remove('open');
});
document.getElementById('color-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('color-modal'))
    document.getElementById('color-modal').classList.remove('open');
});

/* ════════════════════════════════════════════
   MOBILE COLOR GRID — build dynamically
   ════════════════════════════════════════════ */
const colorGrid = document.getElementById('color-grid');

Object.entries(COLOR_MAP).forEach(([name, c]) => {
  const div       = document.createElement('div');
  div.className   = 'cp-swatch' + (name === activeColor ? ' active' : '');
  div.dataset.name = name;

  if (name === 'custom') {
    div.style.backgroundImage = 'linear-gradient(135deg,#ff6b6b,#ffd93d,#6bcb77,#4d96ff)';
    div.title = 'কাস্টম রঙ';
    div.style.position = 'relative';

    const inp   = document.createElement('input');
    inp.type    = 'color';
    inp.value   = '#FFC107';
    inp.style.cssText = 'opacity:0;position:absolute;inset:0;width:100%;height:100%;cursor:pointer;border:none;padding:0;';
    inp.addEventListener('input', e => {
      const hex = e.target.value;
      const r   = parseInt(hex.slice(1, 3), 16);
      const g   = parseInt(hex.slice(3, 5), 16);
      const b   = parseInt(hex.slice(5, 7), 16);
      COLOR_MAP.custom = { r, g, b, hex };
      div.style.background = hex;
      div.style.backgroundImage = 'none';
      document.querySelector('.custom-swatch').style.background = hex;
      document.getElementById('custom-color-picker').value = hex;
      document.querySelectorAll('.cp-swatch, .swatch').forEach(x => x.classList.remove('active'));
      div.classList.add('active');
      document.querySelector('.custom-swatch')?.classList.add('active');
      activeColor = 'custom';
      document.getElementById('color-modal').classList.remove('open');
      toast(`<i class="fa-solid fa-palette"></i> কাস্টম রঙ: ${hex}`);
    });
    div.appendChild(inp);
  } else {
    div.style.background = c.hex;
    div.addEventListener('click', () => {
      document.querySelectorAll('.cp-swatch, .swatch').forEach(x => x.classList.remove('active'));
      div.classList.add('active');
      document.querySelector(`.swatch[data-color="${name}"]`)?.classList.add('active');
      activeColor = name;
      document.getElementById('color-modal').classList.remove('open');
      toast(`<i class="fa-solid fa-palette"></i> রঙ: ${name}`);
    });
  }

  colorGrid.appendChild(div);
});

/* ════════════════════════════════════════════
   KEYBOARD SHORTCUTS
   ════════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'z') { e.preventDefault(); undo(); return; }
    if (e.key === 'y') { e.preventDefault(); redo(); return; }
    if (e.key === 's') { e.preventDefault(); saveFile(); return; }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); document.getElementById('zoom-in').click(); return; }
    if (e.key === '-') { e.preventDefault(); document.getElementById('zoom-out').click(); return; }
  }

  if (!activeTabId) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') document.getElementById('next-page').click();
  if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   document.getElementById('prev-page').click();
  if (e.key === 'h' || e.key === 'H') document.querySelector('.mode-btn[data-mode="highlight"]')?.click();
  if (e.key === 'e' || e.key === 'E') document.querySelector('.mode-btn[data-mode="erase"]')?.click();
  if (e.key === 'p' || e.key === 'P') document.querySelector('.mode-btn[data-mode="pan"]')?.click();
  if (e.key === 'r' || e.key === 'R') rotate('cw');
});

/* ════════════════════════════════════════════
   INIT
   ════════════════════════════════════════════ */
updatePageLabel();
