import PhotoSwipeLightbox from '../vendor/photoswipe/photoswipe-lightbox.esm.min.js';

const I18N = {
  ru: {
    title: 'Photos',
    search: 'Поиск',
    menu: 'Меню',
    scaleLabel: 'Размер плиток',
    scaleSmall: 'Мелкие плитки',
    scaleMedium: 'Средние плитки',
    scaleLarge: 'Крупные плитки',
    facetAlbums: 'Папки',
    facetDates: 'По дате',
    all: 'Все',
    empty: 'Ничего не найдено',
    openOriginal: 'Открыть оригинал в новой вкладке',
    manifestError: 'Не удалось загрузить manifest.json',
    langLabel: 'Язык',
    months: [
      'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
      'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
    ],
  },
  en: {
    title: 'Photos',
    search: 'Search',
    menu: 'Menu',
    scaleLabel: 'Tile size',
    scaleSmall: 'Small tiles',
    scaleMedium: 'Medium tiles',
    scaleLarge: 'Large tiles',
    facetAlbums: 'Folders',
    facetDates: 'By date',
    all: 'All',
    empty: 'Nothing found',
    openOriginal: 'Open original in a new tab',
    manifestError: 'Could not load manifest.json',
    langLabel: 'Language',
    months: [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ],
  },
};
const LANGS = ['ru', 'en'];
const LANG_STORAGE_KEY = 'gallery.lang';
let currentLang = 'ru';

function t(key) {
  return (I18N[currentLang] && I18N[currentLang][key])
      ?? (I18N.ru[key] ?? key);
}

function monthName(monthNumber) {
  return I18N[currentLang].months[monthNumber - 1] || String(monthNumber);
}

const ORIGINALS_PREFIX = 'originals/';
const THUMB_SIZES = [256, 512, 1024, 2048];
const DEFAULT_THUMB = 512;
const LIGHTBOX_SIZES = [1024, 2048];
const LIGHTBOX_MAX = 2048;
const SCALES = ['small', 'medium', 'large'];
const SCALE_STORAGE_KEY = 'gallery.scale';
const EXPANDED_STORAGE_KEY = 'gallery.expanded';

const SCALE_PARAMS = {
  small:  { rowHeight: 130, maxPerRow: 12 },
  medium: { rowHeight: 220, maxPerRow: 8 },
  large:  { rowHeight: 450, maxPerRow: 4 },
};
const GAP = 6;
const ROW_BUFFER = 4;

const state = {
  photos: [],
  filtered: [],
  rows: [],
  totalHeight: 0,
  filter: { album: '', year: '', month: '', search: '' },
  expanded: new Set(),
};

const $ = (id) => document.getElementById(id);

let lightbox = null;
let scrollRaf = null;
let resizeObserver = null;
let currentScale = 'medium';

function formatDuration(sec) {
  if (sec == null) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

function clampDims(w, h, max) {
  if (w <= max && h <= max) return { width: w, height: h };
  const ratio = w / h;
  return ratio > 1
    ? { width: max, height: Math.round(max / ratio) }
    : { width: Math.round(max * ratio), height: max };
}

function thumbSrc(p, size) {
  return `thumbs/${size}/${p.id}.webp`;
}

function thumbSrcset(p, sizes) {
  return sizes.map((s) => `${thumbSrc(p, s)} ${s}w`).join(', ');
}

async function init() {
  applyLang(loadLang());
  currentScale = loadScale();
  applyScale(currentScale);
  state.expanded = loadExpanded();

  let manifest;
  try {
    const r = await fetch('manifest.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    manifest = await r.json();
  } catch (err) {
    $('empty').hidden = false;
    $('empty').textContent = `${t('manifestError')}: ${err.message}`;
    return;
  }

  state.photos = manifest.photos || [];

  hydrateFromHash();
  bindEvents();
  initLightbox();
  observeLayoutChanges();
  renderAll();
}

function initLightbox() {
  lightbox = new PhotoSwipeLightbox({
    dataSource: [],
    pswpModule: () => import('../vendor/photoswipe/photoswipe.esm.min.js'),
    bgOpacity: 0.95,
    showHideAnimationType: 'fade',
  });

  lightbox.on('contentLoad', (e) => {
    const { content } = e;
    if (content.type !== 'video') return;
    e.preventDefault();
    const wrap = document.createElement('div');
    wrap.className = 'pswp__video';
    const video = document.createElement('video');
    video.src = content.data.videoSrc;
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    wrap.appendChild(video);
    content.element = wrap;
  });

  lightbox.on('contentDeactivate', (e) => {
    const v = e.content.element && e.content.element.querySelector
      && e.content.element.querySelector('video');
    if (v) v.pause();
  });

  lightbox.on('uiRegister', () => {
    lightbox.pswp.ui.registerElement({
      name: 'open-original',
      order: 9,
      isButton: true,
      tagName: 'a',
      html: {
        isCustomSVG: true,
        inner: '<path d="M22 12V8h-4M22 8l-7 7M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
        outlineID: 'pswp__icn-open-original',
      },
      onInit: (el, pswp) => {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noreferrer');
        el.setAttribute('title', t('openOriginal'));
        pswp.on('change', () => {
          const url = pswp.currSlide && pswp.currSlide.data && pswp.currSlide.data.originalUrl;
          el.href = url || '#';
        });
      },
    });
  });

  lightbox.init();
}

function toSlide(p) {
  const lbDims = clampDims(p.width, p.height, LIGHTBOX_MAX);
  const original = `${ORIGINALS_PREFIX}${encodePath(p.path)}`;
  if (p.kind === 'video') {
    return {
      type: 'video',
      videoSrc: original,
      originalUrl: original,
      width: lbDims.width,
      height: lbDims.height,
    };
  }
  return {
    src: thumbSrc(p, LIGHTBOX_MAX),
    srcset: thumbSrcset(p, LIGHTBOX_SIZES),
    originalUrl: original,
    width: lbDims.width,
    height: lbDims.height,
  };
}

function bindEvents() {
  $('search-input').addEventListener('input', (e) => {
    state.filter.search = e.target.value;
    updateHash();
    renderGrid();
  });

  $('menu-toggle').addEventListener('click', toggleDrawer);
  $('backdrop').addEventListener('click', () => closeDrawer());

  $('title-home').addEventListener('click', resetAll);
  $('title-home').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      resetAll();
    }
  });

  document.querySelector('.topbar__scale').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-scale]');
    if (!btn) return;
    currentScale = btn.dataset.scale;
    applyScale(currentScale);
    saveScale(currentScale);
    buildLayout();
  });

  document.querySelector('.topbar__lang').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-lang]');
    if (!btn || btn.dataset.lang === currentLang) return;
    applyLang(btn.dataset.lang);
    saveLang(btn.dataset.lang);
    renderAll();
  });

  $('grid').addEventListener('click', (e) => {
    const a = e.target.closest('a.grid__item');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    const idx = parseInt(a.dataset.index, 10);
    if (Number.isNaN(idx)) return;
    lightbox.loadAndOpen(idx, state.filtered.map(toSlide));
  });

  document.body.addEventListener('click', (e) => {
    const toggle = e.target.closest('.tree__toggle');
    if (toggle && !toggle.classList.contains('tree__toggle--empty')) {
      const item = toggle.closest('.tree__item');
      if (item) toggleExpanded(item.dataset.facet, item.dataset.key);
      return;
    }
    const treeItem = e.target.closest('.tree__item');
    if (treeItem) {
      applyFacet(treeItem.dataset.facet, treeItem.dataset.key);
      if (window.matchMedia('(max-width: 768px)').matches) closeDrawer();
      return;
    }
    const crumb = e.target.closest('.breadcrumb a');
    if (crumb && crumb.dataset.facet) {
      applyFacet(crumb.dataset.facet, crumb.dataset.key || '');
    }
  });

  window.addEventListener('hashchange', () => {
    hydrateFromHash();
    renderAll();
  });

  window.addEventListener('scroll', onScroll, { passive: true });
}

function observeLayoutChanges() {
  if (resizeObserver) return;
  resizeObserver = new ResizeObserver(() => buildLayout());
  resizeObserver.observe($('grid'));
}

function onScroll() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = null;
    renderVisibleRows();
  });
}

function toggleDrawer() {
  $('sidebar').classList.toggle('sidebar--open');
  $('backdrop').classList.toggle('backdrop--open');
}

function closeDrawer() {
  $('sidebar').classList.remove('sidebar--open');
  $('backdrop').classList.remove('backdrop--open');
}

function loadLang() {
  try {
    const v = localStorage.getItem(LANG_STORAGE_KEY);
    if (LANGS.includes(v)) return v;
  } catch (_) { /* ignore */ }
  const browser = (navigator.language || 'ru').slice(0, 2).toLowerCase();
  return browser === 'en' ? 'en' : 'ru';
}

function saveLang(lang) {
  try { localStorage.setItem(LANG_STORAGE_KEY, lang); } catch (_) { /* ignore */ }
}

function applyLang(lang) {
  if (!LANGS.includes(lang)) lang = 'ru';
  currentLang = lang;
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  for (const el of document.querySelectorAll('[data-i18n-aria]')) {
    const v = t(el.dataset.i18nAria);
    el.setAttribute('aria-label', v);
    el.setAttribute('title', v);
  }
  document.querySelectorAll('.topbar__lang button').forEach((b) => {
    b.setAttribute('aria-pressed', b.dataset.lang === lang ? 'true' : 'false');
  });
}

function loadScale() {
  try {
    const v = localStorage.getItem(SCALE_STORAGE_KEY);
    return SCALES.includes(v) ? v : 'medium';
  } catch (_) { return 'medium'; }
}

function saveScale(scale) {
  try { localStorage.setItem(SCALE_STORAGE_KEY, scale); } catch (_) {}
}

function loadExpanded() {
  try {
    const raw = localStorage.getItem(EXPANDED_STORAGE_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch (_) { /* ignore */ }
  return new Set();
}

function saveExpanded() {
  try {
    localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify([...state.expanded]));
  } catch (_) { /* ignore */ }
}

function expandKey(facet, key) {
  return `${facet}:${key}`;
}

function isExpanded(facet, key) {
  return state.expanded.has(expandKey(facet, key));
}

function toggleExpanded(facet, key) {
  const k = expandKey(facet, key);
  if (state.expanded.has(k)) state.expanded.delete(k);
  else state.expanded.add(k);
  saveExpanded();
  renderFacets();
}

function applyScale(scale) {
  if (!SCALES.includes(scale)) scale = 'medium';
  document.documentElement.dataset.scale = scale;
  document.querySelectorAll('.topbar__scale button').forEach((btn) => {
    btn.setAttribute('aria-pressed', btn.dataset.scale === scale ? 'true' : 'false');
  });
}

function resetAll() {
  state.filter = { album: '', year: '', month: '', search: '' };
  $('search-input').value = '';
  updateHash();
  renderAll();
}

function applyFacet(facet, key) {
  if (facet === 'album') {
    state.filter.album = key;
  } else if (facet === 'date') {
    if (!key) {
      state.filter.year = '';
      state.filter.month = '';
    } else if (key.includes('-')) {
      const [y, m] = key.split('-');
      state.filter.year = y;
      state.filter.month = m;
    } else {
      state.filter.year = key;
      state.filter.month = '';
    }
  }
  updateHash();
  renderAll();
}

function updateHash() {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(state.filter)) {
    if (v) params.set(k, v);
  }
  const h = params.toString();
  history.replaceState(null, '', h ? `#${h}` : window.location.pathname);
}

function hydrateFromHash() {
  const h = window.location.hash.slice(1);
  if (!h) {
    state.filter = { album: '', year: '', month: '', search: '' };
    $('search-input').value = '';
    return;
  }
  const params = new URLSearchParams(h);
  state.filter = {
    album: params.get('album') || '',
    year: params.get('year') || '',
    month: params.get('month') || '',
    search: params.get('search') || '',
  };
  $('search-input').value = state.filter.search;
}

function passes(p) {
  return passesExcept(p, null);
}

// Same as passes() but skips the check for `exceptFacet` ('album' or 'date').
// Used by the facet trees so each tree shows counts within the OTHER filters'
// current state — clicking _iPhone_Pavel collapses the date tree to only the
// years that album actually contains, etc.
function passesExcept(p, exceptFacet) {
  const f = state.filter;
  if (exceptFacet !== 'album' && f.album) {
    if (p.album !== f.album && !p.album.startsWith(f.album + '/')) return false;
  }
  if (f.search) {
    const q = f.search.toLowerCase();
    if (!p.filename.toLowerCase().includes(q) && !p.path.toLowerCase().includes(q)) return false;
  }
  if (exceptFacet !== 'date' && (f.year || f.month)) {
    const d = new Date(p.date);
    if (f.year && String(d.getUTCFullYear()) !== f.year) return false;
    if (f.month && String(d.getUTCMonth() + 1).padStart(2, '0') !== f.month) return false;
  }
  return true;
}

function buildHierarchy(items, getPath) {
  const root = { count: 0, children: new Map() };
  for (const item of items) {
    const segments = getPath(item);
    root.count++;
    let node = root;
    for (const seg of segments) {
      if (!node.children.has(seg)) {
        node.children.set(seg, { count: 0, children: new Map() });
      }
      node = node.children.get(seg);
      node.count++;
    }
  }
  return root;
}

function renderAll() {
  renderFacets();
  renderBreadcrumb();
  renderGrid();
}

function renderFacets() {
  // Each tree is built from photos that pass every OTHER filter — the
  // album tree narrows under the current date/search, and vice versa.
  // Counts and visible nodes therefore reflect what's actually
  // reachable from the current state.
  const albumScope = state.photos.filter((p) => passesExcept(p, 'album'));
  const albumRoot = buildHierarchy(albumScope, (p) => (p.album ? p.album.split('/') : []));
  const folderEl = $('folder-tree');
  folderEl.replaceChildren();
  folderEl.appendChild(treeItem(t('all'), '', albumRoot.count, 'album', state.filter.album === '', false, false));
  appendTreeChildren(folderEl, albumRoot, 'album', state.filter.album, [], '/', false);

  const dateScope = state.photos.filter((p) => passesExcept(p, 'date'));
  const dateRoot = buildHierarchy(dateScope, (p) => {
    const d = new Date(p.date);
    return [String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0')];
  });
  const dateEl = $('date-tree');
  dateEl.replaceChildren();
  const activeDateKey = state.filter.month
    ? `${state.filter.year}-${state.filter.month}`
    : state.filter.year;
  dateEl.appendChild(treeItem(t('all'), '', dateRoot.count, 'date', !activeDateKey, false, false));
  appendTreeChildren(dateEl, dateRoot, 'date', activeDateKey, [], '-', true);
}

function appendTreeChildren(container, node, facet, activeKey, pathSoFar, sep, dateReverse) {
  const entries = [...node.children.entries()].sort((a, b) => {
    return dateReverse ? b[0].localeCompare(a[0]) : a[0].localeCompare(b[0]);
  });
  for (const [seg, child] of entries) {
    const path = [...pathSoFar, seg];
    const key = path.join(sep);
    const label = facet === 'date' && pathSoFar.length === 1 ? monthName(parseInt(seg, 10)) : seg;
    const hasChildren = child.children.size > 0;
    const expanded = hasChildren && isExpanded(facet, key);
    container.appendChild(treeItem(label, key, child.count, facet, key === activeKey, hasChildren, expanded));
    if (hasChildren) {
      const childContainer = document.createElement('div');
      childContainer.className = 'tree__children' + (expanded ? ' tree__children--expanded' : '');
      appendTreeChildren(childContainer, child, facet, activeKey, path, sep, dateReverse);
      container.appendChild(childContainer);
    }
  }
}

function treeItem(label, key, count, facet, active, hasChildren, expanded) {
  const el = document.createElement('div');
  el.className = 'tree__item' + (active ? ' tree__item--active' : '');
  el.dataset.facet = facet;
  el.dataset.key = key;

  const toggle = document.createElement('span');
  if (hasChildren) {
    toggle.className = 'tree__toggle' + (expanded ? ' tree__toggle--open' : '');
    toggle.innerHTML = '<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  } else {
    toggle.className = 'tree__toggle tree__toggle--empty';
  }
  el.appendChild(toggle);

  const labelEl = document.createElement('span');
  labelEl.className = 'tree__label';
  labelEl.textContent = label;
  const countEl = document.createElement('span');
  countEl.className = 'tree__count';
  countEl.textContent = count;
  el.append(labelEl, countEl);
  return el;
}

function renderBreadcrumb() {
  const parts = [];
  const f = state.filter;
  if (f.album) {
    let acc = '';
    for (const seg of f.album.split('/')) {
      acc = acc ? `${acc}/${seg}` : seg;
      parts.push({ label: seg, facet: 'album', key: acc });
    }
  }
  if (f.year) {
    parts.push({ label: f.year, facet: 'date', key: f.year });
    if (f.month) {
      parts.push({
        label: monthName(parseInt(f.month, 10)),
        facet: 'date',
        key: `${f.year}-${f.month}`,
      });
    }
  }

  const el = $('breadcrumb');
  el.replaceChildren();
  if (parts.length === 0) return;

  const home = document.createElement('a');
  home.dataset.facet = 'album';
  home.dataset.key = '';
  home.textContent = t('all');
  el.appendChild(home);
  parts.forEach((p) => {
    const sep = document.createElement('span');
    sep.className = 'breadcrumb__sep';
    sep.textContent = '/';
    el.appendChild(sep);
    const a = document.createElement('a');
    a.dataset.facet = p.facet;
    a.dataset.key = p.key;
    a.textContent = p.label;
    el.appendChild(a);
  });
}

function renderGrid() {
  state.filtered = state.photos.filter(passes);

  $('count').textContent = state.filtered.length === state.photos.length
    ? `${state.photos.length}`
    : `${state.filtered.length} / ${state.photos.length}`;

  if (state.filtered.length === 0) {
    state.rows = [];
    state.totalHeight = 0;
    const grid = $('grid');
    grid.replaceChildren();
    grid.style.height = '0px';
    $('empty').textContent = t('empty');
    $('empty').hidden = false;
    window.scrollTo(0, 0);
    return;
  }
  $('empty').hidden = true;
  window.scrollTo(0, 0);
  buildLayout();
}

function buildLayout() {
  const grid = $('grid');
  const W = grid.clientWidth;
  if (W === 0 || state.filtered.length === 0) return;

  const params = SCALE_PARAMS[currentScale] || SCALE_PARAMS.medium;
  const target = params.rowHeight;
  const maxPerRow = params.maxPerRow;

  const rows = [];
  let cur = [];
  let curAspect = 0;

  for (let i = 0; i < state.filtered.length; i++) {
    const p = state.filtered[i];
    const aspect = (p.width && p.height) ? p.width / p.height : 1;
    cur.push({ photo: p, aspect, idx: i });
    curAspect += aspect;
    const widthAtTarget = curAspect * target + (cur.length - 1) * GAP;
    if (widthAtTarget >= W || cur.length >= maxPerRow) {
      rows.push(closeRow(cur, W, false, target));
      cur = [];
      curAspect = 0;
    }
  }
  if (cur.length) rows.push(closeRow(cur, W, true, target));

  let y = 0;
  for (const row of rows) {
    row.y = y;
    y += row.height + GAP;
  }

  state.rows = rows;
  state.totalHeight = Math.max(0, y - GAP);
  grid.style.height = `${state.totalHeight}px`;

  renderVisibleRows();
}

function closeRow(items, W, isLast, target) {
  const totalAspect = items.reduce((s, i) => s + i.aspect, 0);
  const gaps = (items.length - 1) * GAP;
  const h = isLast ? target : Math.max(40, Math.floor((W - gaps) / totalAspect));
  return { items, totalAspect, height: h, isLast, gaps };
}

function findRowIndex(y) {
  const rows = state.rows;
  if (rows.length === 0 || y <= 0) return 0;
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rows[mid].y <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function renderVisibleRows() {
  const grid = $('grid');
  if (state.rows.length === 0) {
    grid.replaceChildren();
    return;
  }

  const gridTop = grid.getBoundingClientRect().top + window.scrollY;
  const viewTop = Math.max(0, window.scrollY - gridTop);
  const viewBottom = Math.max(0, window.scrollY + window.innerHeight - gridTop);

  const start = Math.max(0, findRowIndex(viewTop) - ROW_BUFFER);
  const end = Math.min(state.rows.length - 1, findRowIndex(viewBottom) + ROW_BUFFER);

  const frag = document.createDocumentFragment();
  for (let r = start; r <= end; r++) {
    const row = state.rows[r];
    let x = 0;
    for (const item of row.items) {
      const w = Math.round(item.aspect * row.height);
      frag.appendChild(makeItem(item.photo, item.idx, x, row.y, w, row.height));
      x += w + GAP;
    }
  }
  grid.replaceChildren(frag);
}

function makeItem(p, indexInFiltered, x, y, w, h) {
  const lbDims = clampDims(p.width, p.height, LIGHTBOX_MAX);
  const a = document.createElement('a');
  a.className = 'grid__item';
  a.dataset.index = indexInFiltered;
  a.dataset.pswpWidth = lbDims.width;
  a.dataset.pswpHeight = lbDims.height;
  a.target = '_blank';
  a.rel = 'noreferrer';
  a.style.left = `${x}px`;
  a.style.top = `${y}px`;
  a.style.width = `${w}px`;
  a.style.height = `${h}px`;

  if (p.kind === 'video') {
    a.classList.add('grid__item--video');
    a.href = `${ORIGINALS_PREFIX}${encodePath(p.path)}`;
  } else {
    a.href = thumbSrc(p, LIGHTBOX_MAX);
  }

  const img = document.createElement('img');
  img.src = thumbSrc(p, DEFAULT_THUMB);
  img.srcset = thumbSrcset(p, THUMB_SIZES);
  img.sizes = `${w}px`;
  img.width = w;
  img.height = h;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = p.filename;
  a.appendChild(img);

  if (p.kind === 'video' && p.duration) {
    const dur = document.createElement('span');
    dur.className = 'grid__duration';
    dur.textContent = formatDuration(p.duration);
    a.appendChild(dur);
  }
  return a;
}

init();
