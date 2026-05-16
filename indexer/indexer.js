#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const sharp = require('sharp');
const exifr = require('exifr');

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp']);
const STATE_VERSION = 2;
const CONCURRENCY = 8;

const DEFAULTS = {
  thumbSize: 320,
  previewSize: 1600,
  quality: 78,
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS, input: null, output: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    switch (a) {
      case '--input': opts.input = path.resolve(v); i++; break;
      case '--output': opts.output = path.resolve(v); i++; break;
      case '--thumb-size': opts.thumbSize = parseInt(v, 10); i++; break;
      case '--preview-size': opts.previewSize = parseInt(v, 10); i++; break;
      case '--quality': opts.quality = parseInt(v, 10); i++; break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
      default:
        if (a.startsWith('--')) {
          console.error(`Unknown flag: ${a}`);
          printUsage();
          process.exit(2);
        }
    }
  }
  if (!opts.input || !opts.output) {
    printUsage();
    process.exit(2);
  }
  return opts;
}

function printUsage() {
  console.error([
    'Usage: indexer.js --input <dir> --output <dir> [options]',
    '',
    'Options:',
    '  --thumb-size N      Grid thumbnail long edge in px (default 320)',
    '  --preview-size N    Lightbox preview long edge in px (default 1600)',
    '  --quality N         WebP quality 1-100 (default 78)',
  ].join('\n'));
}

async function walk(root) {
  const results = [];
  async function visit(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      console.error(`! cannot read ${dir}: ${err.message}`);
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await visit(abs);
      } else if (ent.isFile() && PHOTO_EXTS.has(path.extname(ent.name).toLowerCase())) {
        results.push({ abs, rel: path.relative(root, abs) });
      }
    }
  }
  await visit(root);
  return results;
}

function stableId(relPath) {
  return crypto.createHash('sha256').update(relPath).digest('hex').slice(0, 16);
}

async function readStat(absPath) {
  const s = await fs.stat(absPath);
  return { mtime: Math.floor(s.mtimeMs), size: s.size };
}

async function readMeta(buf) {
  try {
    return await exifr.parse(buf, {
      pick: ['DateTimeOriginal', 'CreateDate', 'GPSLatitude', 'GPSLongitude',
        'Make', 'Model', 'ISO', 'FNumber', 'ExposureTime',
        'FocalLength', 'Orientation'],
    }) || {};
  } catch (_) {
    return {};
  }
}

async function generateDerivatives(buf, id, opts) {
  const thumbPath = path.join(opts.output, 'thumbs', `${id}.webp`);
  const previewPath = path.join(opts.output, 'previews', `${id}.webp`);
  const baseMeta = await sharp(buf, { failOn: 'none' }).metadata();
  const rotatedDims = (baseMeta.orientation && baseMeta.orientation >= 5)
    ? { width: baseMeta.height, height: baseMeta.width }
    : { width: baseMeta.width, height: baseMeta.height };

  await Promise.all([
    sharp(buf, { failOn: 'none' }).rotate()
      .resize(opts.thumbSize, opts.thumbSize, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: opts.quality })
      .toFile(thumbPath),
    sharp(buf, { failOn: 'none' }).rotate()
      .resize(opts.previewSize, opts.previewSize, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: opts.quality })
      .toFile(previewPath),
  ]);

  return rotatedDims;
}

function formatShutter(sec) {
  if (sec >= 1) return `${sec}s`;
  return `1/${Math.round(1 / sec)}`;
}

function dateFromExif(exif, fallbackMtime) {
  const d = exif.DateTimeOriginal || exif.CreateDate;
  if (d instanceof Date && !isNaN(d.getTime())) return d.toISOString();
  return new Date(fallbackMtime).toISOString();
}

async function processOne(file, state, opts) {
  const stat = await readStat(file.abs);
  const cached = state.entries[file.rel];

  if (cached && cached.mtime === stat.mtime && cached.size === stat.size) {
    return { ...cached.meta, _cached: true };
  }

  const id = stableId(file.rel);
  const buf = await fs.readFile(file.abs);
  const [exif, dims] = await Promise.all([
    readMeta(buf),
    generateDerivatives(buf, id, opts),
  ]);

  const meta = {
    id,
    path: file.rel,
    filename: path.basename(file.rel),
    album: path.dirname(file.rel) === '.' ? '' : path.dirname(file.rel),
    width: dims.width,
    height: dims.height,
    size: stat.size,
    date: dateFromExif(exif, stat.mtime),
    camera: [exif.Make, exif.Model].filter(Boolean).join(' ').trim() || null,
    iso: exif.ISO || null,
    aperture: exif.FNumber || null,
    shutter: exif.ExposureTime ? formatShutter(exif.ExposureTime) : null,
    focalLength: exif.FocalLength || null,
    gps: (exif.GPSLatitude != null && exif.GPSLongitude != null)
      ? [exif.GPSLatitude, exif.GPSLongitude] : null,
  };

  state.entries[file.rel] = { mtime: stat.mtime, size: stat.size, meta };
  return meta;
}

async function pmap(arr, fn, concurrency, onProgress) {
  const result = new Array(arr.length);
  let idx = 0;
  let done = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= arr.length) return;
      result[i] = await fn(arr[i], i);
      done++;
      if (onProgress) onProgress(done, arr.length);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return result;
}

async function loadState(opts) {
  const statePath = path.join(opts.output, '.cache', 'state.json');
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    const data = JSON.parse(raw);
    if (data.version === STATE_VERSION) return data;
  } catch (_) { /* fall through */ }
  return { version: STATE_VERSION, entries: {} };
}

async function saveState(state, opts) {
  const statePath = path.join(opts.output, '.cache', 'state.json');
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state));
}

async function cleanupOrphans(seenPaths, state, opts) {
  let removed = 0;
  for (const rel of Object.keys(state.entries)) {
    if (seenPaths.has(rel)) continue;
    const id = state.entries[rel].meta.id;
    await fs.rm(path.join(opts.output, 'thumbs', `${id}.webp`), { force: true });
    await fs.rm(path.join(opts.output, 'previews', `${id}.webp`), { force: true });
    delete state.entries[rel];
    removed++;
  }
  return removed;
}

function logProgress(done, total) {
  if (done === total || done % 25 === 0) {
    const pct = ((done / total) * 100).toFixed(0);
    process.stdout.write(`\r  ${done}/${total} (${pct}%)`);
    if (done === total) process.stdout.write('\n');
  }
}

async function main() {
  const opts = parseArgs(process.argv);

  await fs.mkdir(path.join(opts.output, 'thumbs'), { recursive: true });
  await fs.mkdir(path.join(opts.output, 'previews'), { recursive: true });

  console.log(`Scanning ${opts.input}`);
  const files = await walk(opts.input);
  console.log(`Found ${files.length} media files`);
  if (files.length === 0) return;

  const state = await loadState(opts);

  const t0 = performance.now();
  let cachedCount = 0, newCount = 0, failCount = 0;

  const results = await pmap(files, async (file) => {
    try {
      const meta = await processOne(file, state, opts);
      if (meta._cached) cachedCount++; else newCount++;
      const { _cached, ...clean } = meta;
      return clean;
    } catch (err) {
      console.error(`\n! ${file.rel}: ${err.message}`);
      failCount++;
      return null;
    }
  }, CONCURRENCY, logProgress);

  const photos = results.filter(Boolean).sort((a, b) => (b.date < a.date ? -1 : 1));

  const seen = new Set(files.map(f => f.rel));
  const orphans = await cleanupOrphans(seen, state, opts);

  const manifest = {
    generated: new Date().toISOString(),
    count: photos.length,
    photos,
  };

  await fs.writeFile(
    path.join(opts.output, 'manifest.json'),
    JSON.stringify(manifest)
  );
  await saveState(state, opts);

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(
    `Done in ${elapsed}s: ${newCount} new, ${cachedCount} cached, ` +
    `${failCount} failed, ${orphans} orphans cleaned`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
