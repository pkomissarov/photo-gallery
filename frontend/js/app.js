import PhotoSwipeLightbox from '../vendor/photoswipe/photoswipe-lightbox.esm.min.js';

const MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

const ORIGINALS_PREFIX = 'originals/';
const THUMB_SIZES = [256, 512, 1024, 2048];
const DEFAULT_THUMB = 512;
const LIGHTBOX_SIZES = [1024, 2048];
const LIGHTBOX_MAX = 2048;
const SCALES = ['small', 'medium', 'large'];
const SCALE_STORAGE_KEY = 'gallery.scale';

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

const state = {
  photos: [],
  filter: { album: '', year: '', month: '', search: '' },
};

const $ = (id) => document.getElementById(id);

async function init() {
  applyScale(loadScale());

  let manifest;
  try {
    const r = await fetch('manifest.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    manifest = await r.json();
  } catch (err) {
    $('empty').hidden = false;
    $('empty').textContent = `Не удалось загрузить manifest.json: ${err.message}`;
    return;
  }

  state.photos = manifest.photos || [];

  hydrateFromHash();
  bindEvents();
  renderAll();

  const lightbox = new PhotoSwipeLightbox({
    gallery: '#grid',
    children: 'a.grid__item',
    pswpModule: () => import('../vendor/photoswipe/photoswipe.esm.min.js'),
    bgOpacity: 0.95,
    showHideAnimationType: 'fade',
  });

  lightbox.addFilter('domItemData', (itemData, element) => {
    if (element.dataset.pswpType === 'video') {
      itemData.type = 'video';
      itemData.videoSrc = element.dataset.pswpVideoSrc;
    }
    return itemData;
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
    const v = e.content.element && e.content.element.querySelector && e.content.element.querySelector('video');
    if (v) v.pause();
  });

  lightbox.init();
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
    applyScale(btn.dataset.scale);
    saveScale(btn.dataset.scale);
  });

  document.body.addEventListener('click', (e) => {
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
}

function toggleDrawer() {
  $('sidebar').classList.toggle('sidebar--open');
  $('backdrop').classList.toggle('backdrop--open');
}

function closeDrawer() {
  $('sidebar').classList.remove('sidebar--open');
  $('backdrop').classList.remove('backdrop--open');
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
  const f = state.filter;
  if (f.album) {
    if (p.album !== f.album && !p.album.startsWith(f.album + '/')) return false;
  }
  if (f.search) {
    const q = f.search.toLowerCase();
    if (!p.filename.toLowerCase().includes(q) && !p.path.toLowerCase().includes(q)) return false;
  }
  if (f.year || f.month) {
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
  const albumRoot = buildHierarchy(state.photos, (p) => (p.album ? p.album.split('/') : []));
  const folderEl = $('folder-tree');
  folderEl.replaceChildren();
  folderEl.appendChild(treeItem('Все', '', albumRoot.count, 'album', state.filter.album === ''));
  appendTreeChildren(folderEl, albumRoot, 'album', state.filter.album, [], '/', false);

  const dateRoot = buildHierarchy(state.photos, (p) => {
    const d = new Date(p.date);
    return [String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0')];
  });
  const dateEl = $('date-tree');
  dateEl.replaceChildren();
  const activeDateKey = state.filter.month
    ? `${state.filter.year}-${state.filter.month}`
    : state.filter.year;
  dateEl.appendChild(treeItem('Все', '', dateRoot.count, 'date', !activeDateKey));
  appendTreeChildren(dateEl, dateRoot, 'date', activeDateKey, [], '-', true);
}

function appendTreeChildren(container, node, facet, activeKey, pathSoFar, sep, dateReverse) {
  const entries = [...node.children.entries()].sort((a, b) => {
    return dateReverse ? b[0].localeCompare(a[0]) : a[0].localeCompare(b[0]);
  });
  for (const [seg, child] of entries) {
    const path = [...pathSoFar, seg];
    const key = path.join(sep);
    const label = facet === 'date' && pathSoFar.length === 1 ? MONTHS[parseInt(seg, 10) - 1] : seg;
    container.appendChild(treeItem(label, key, child.count, facet, key === activeKey));
    if (child.children.size > 0) {
      const childContainer = document.createElement('div');
      childContainer.className = 'tree__children';
      appendTreeChildren(childContainer, child, facet, activeKey, path, sep, dateReverse);
      container.appendChild(childContainer);
    }
  }
}

function treeItem(label, key, count, facet, active) {
  const el = document.createElement('div');
  el.className = 'tree__item' + (active ? ' tree__item--active' : '');
  el.dataset.facet = facet;
  el.dataset.key = key;
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
        label: MONTHS[parseInt(f.month, 10) - 1],
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
  home.textContent = 'Все';
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
  const filtered = state.photos.filter(passes);
  const grid = $('grid');
  const empty = $('empty');

  $('count').textContent = filtered.length === state.photos.length
    ? `${state.photos.length}`
    : `${filtered.length} / ${state.photos.length}`;

  if (filtered.length === 0) {
    grid.replaceChildren();
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const frag = document.createDocumentFragment();
  for (const p of filtered) {
    const lbDims = clampDims(p.width, p.height, LIGHTBOX_MAX);
    const a = document.createElement('a');
    a.className = 'grid__item';
    a.dataset.pswpWidth = lbDims.width;
    a.dataset.pswpHeight = lbDims.height;
    a.target = '_blank';
    a.rel = 'noreferrer';

    if (p.kind === 'video') {
      a.classList.add('grid__item--video');
      a.href = `${ORIGINALS_PREFIX}${encodePath(p.path)}`;
      a.dataset.pswpType = 'video';
      a.dataset.pswpVideoSrc = `${ORIGINALS_PREFIX}${encodePath(p.path)}`;
    } else {
      a.href = thumbSrc(p, LIGHTBOX_MAX);
      a.dataset.pswpSrcset = thumbSrcset(p, LIGHTBOX_SIZES);
    }

    const img = document.createElement('img');
    img.src = thumbSrc(p, DEFAULT_THUMB);
    img.srcset = thumbSrcset(p, THUMB_SIZES);
    img.sizes = 'auto';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = p.filename;
    img.style.aspectRatio = `${p.width}/${p.height}`;
    a.appendChild(img);

    if (p.kind === 'video' && p.duration) {
      const dur = document.createElement('span');
      dur.className = 'grid__duration';
      dur.textContent = formatDuration(p.duration);
      a.appendChild(dur);
    }

    frag.appendChild(a);
  }
  grid.replaceChildren(frag);
}

init();
