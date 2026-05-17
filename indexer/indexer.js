#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const sharp = require('sharp');
const exifr = require('exifr');

const MEDIA_EXTS = {
  '.jpg':  { priority: 0, kind: 'photo' },
  '.jpeg': { priority: 0, kind: 'photo' },
  '.png':  { priority: 1, kind: 'photo' },
  '.webp': { priority: 2, kind: 'photo' },
  '.heic': { priority: 3, kind: 'photo' },
  '.heif': { priority: 3, kind: 'photo' },
  '.gif':  { priority: 4, kind: 'photo' },
  '.mov':  { priority: 5, kind: 'video' },
  '.mp4':  { priority: 5, kind: 'video' },
  '.m4v':  { priority: 5, kind: 'video' },
  '.3gp':  { priority: 5, kind: 'video' },
  '.dng':  { priority: 6, kind: 'raw' },
  '.cr2':  { priority: 6, kind: 'raw' },
  '.cr3':  { priority: 6, kind: 'raw' },
  '.crw':  { priority: 6, kind: 'raw' },
  '.nef':  { priority: 6, kind: 'raw' },
  '.arw':  { priority: 6, kind: 'raw' },
  '.raf':  { priority: 6, kind: 'raw' },
  '.orf':  { priority: 6, kind: 'raw' },
  '.rw2':  { priority: 6, kind: 'raw' },
};

const STATE_VERSION = 6;
const CONCURRENCY = 8;

const DEFAULTS = {
  thumbSizes: [256, 512, 1024, 2048],
  quality: 82,
  albumDepth: 1,
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS, input: null, output: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    switch (a) {
      case '--input': opts.input = path.resolve(v); i++; break;
      case '--output': opts.output = path.resolve(v); i++; break;
      case '--thumb-sizes':
        opts.thumbSizes = v.split(',').map((s) => parseInt(s.trim(), 10)).filter(Boolean);
        i++; break;
      case '--quality': opts.quality = parseInt(v, 10); i++; break;
      case '--album-depth': opts.albumDepth = parseInt(v, 10); i++; break;
      case '--help':
      case '-h':
        printUsage(); process.exit(0);
      default:
        if (a.startsWith('--')) {
          console.error(`Unknown flag: ${a}`);
          printUsage();
          process.exit(2);
        }
    }
  }
  if (!opts.input || !opts.output) { printUsage(); process.exit(2); }
  opts.thumbSizes = [...new Set(opts.thumbSizes)].sort((a, b) => a - b);
  return opts;
}

function printUsage() {
  console.error([
    'Usage: indexer.js --input <dir> --output <dir> [options]',
    '',
    'Options:',
    '  --thumb-sizes A,B,C  Comma-separated long-edge sizes (default 256,512,1024,2048)',
    '  --quality N          WebP quality 1-100 (default 82)',
    '  --album-depth N      Group scope for cross-format dedup. 1 = first path',
    '                       segment under input is an album (default, for runs',
    '                       on the full library). 0 = entire input is one album',
    '                       (use when indexing a single album).',
  ].join('\n'));
}

function getMediaInfo(filename) {
  return MEDIA_EXTS[path.extname(filename).toLowerCase()] || null;
}

function albumKey(rel, depth) {
  if (depth <= 0) return '';
  const parts = rel.split('/');
  // parts.length includes the filename; need at least depth+1 segments for an album
  if (parts.length <= depth) return '';
  return parts.slice(0, depth).join('/');
}

async function walk(root, albumDepth) {
  const all = [];
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
        continue;
      }
      if (!ent.isFile()) continue;
      const info = getMediaInfo(ent.name);
      if (!info) continue;
      all.push({ abs, rel: path.relative(root, abs), info });
    }
  }
  await visit(root);

  // Cross-format dedup: within each (album, basename) group, drop entries above
  // the min priority. Equal-priority entries are all kept (e.g., same-basename
  // JPGs in different sub-folders are distinct photos from camera counter wrap).
  // Album scope is controlled by albumDepth (0 = whole input is one album).
  const minPriority = new Map();
  for (const f of all) {
    const base = path.parse(f.rel).name.toLowerCase();
    const key = `${albumKey(f.rel, albumDepth)}\0${base}`;
    const p = f.info.priority;
    if (!minPriority.has(key) || minPriority.get(key) > p) {
      minPriority.set(key, p);
    }
  }

  const kept = [];
  let droppedDupes = 0;
  for (const f of all) {
    const base = path.parse(f.rel).name.toLowerCase();
    const key = `${albumKey(f.rel, albumDepth)}\0${base}`;
    if (f.info.priority === minPriority.get(key)) {
      kept.push(f);
    } else {
      droppedDupes++;
    }
  }
  return { files: kept, droppedDupes };
}

function stableId(relPath) {
  return crypto.createHash('sha256').update(relPath).digest('hex').slice(0, 16);
}

async function readStat(absPath) {
  const s = await fs.stat(absPath);
  return { mtime: Math.floor(s.mtimeMs), size: s.size };
}

async function readExif(buf) {
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

async function makeDerivativesFromBuffer(buf, id, opts) {
  const baseMeta = await sharp(buf, { failOn: 'none' }).metadata();
  const natural = (baseMeta.orientation && baseMeta.orientation >= 5)
    ? { width: baseMeta.height, height: baseMeta.width }
    : { width: baseMeta.width, height: baseMeta.height };

  await Promise.all(opts.thumbSizes.map((size) =>
    sharp(buf, { failOn: 'none' }).rotate()
      .resize(size, size, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: opts.quality })
      .toFile(path.join(opts.output, 'thumbs', String(size), `${id}.webp`))
  ));

  return { natural };
}

function ffmpegPoster(absPath) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let stderr = '';
    const proc = spawn('ffmpeg', [
      '-ss', '0.5',
      '-i', absPath,
      '-vframes', '1', '-an',
      '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '2',
      '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => stderr += c);
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-400)}`));
    });
  });
}

function runExiftool(args) {
  return new Promise((resolve) => {
    const proc = spawn('exiftool', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => {
      resolve(code === 0 ? Buffer.concat(chunks) : null);
    });
  });
}

async function extractRawPreview(absPath) {
  for (const tag of ['JpgFromRaw', 'PreviewImage', 'OtherImage']) {
    const buf = await runExiftool(['-b', `-${tag}`, absPath]);
    if (buf && buf.length > 1024) return buf;
  }
  return null;
}

function magickToJpeg(absPath) {
  // ImageMagick handles HEIC variants (HEVC Main Still Picture Profile,
  // newer iPhone encodings) that sharp's bundled libheif and macOS sips
  // both refuse. magick can't write binary to stdout cleanly either, so
  // we round-trip through a tmp file.
  const tmpPath = path.join(os.tmpdir(),
    `pg-heic-${process.pid}-${crypto.randomBytes(6).toString('hex')}.jpg`);
  return new Promise((resolve, reject) => {
    const proc = spawn('magick', [absPath, '-quality', '95', tmpPath],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (c) => stderr += c);
    proc.on('error', reject);
    proc.on('close', async (code) => {
      if (code !== 0) {
        await fs.rm(tmpPath, { force: true }).catch(() => {});
        return reject(new Error(`magick exit ${code}: ${stderr.slice(-200)}`));
      }
      try {
        const buf = await fs.readFile(tmpPath);
        resolve(buf);
      } catch (err) {
        reject(err);
      } finally {
        await fs.rm(tmpPath, { force: true }).catch(() => {});
      }
    });
  });
}

async function loadPhotoBuffer(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  if (ext === '.heic' || ext === '.heif') {
    return await magickToJpeg(absPath);
  }
  return await fs.readFile(absPath);
}

function ffprobeMeta(absPath) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=width,height:format=duration:format_tags=creation_time',
      '-of', 'json',
      absPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (c) => out += c);
    proc.on('error', () => resolve({}));
    proc.on('close', (code) => {
      if (code !== 0) return resolve({});
      try {
        const data = JSON.parse(out);
        const stream = (data.streams || []).find((s) => s.width && s.height) || {};
        const tags = (data.format && data.format.tags) || {};
        resolve({
          width: stream.width || null,
          height: stream.height || null,
          duration: data.format && parseFloat(data.format.duration) || null,
          creationTime: tags.creation_time || null,
        });
      } catch (_) { resolve({}); }
    });
  });
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

function dateFromVideo(probe, fallbackMtime) {
  if (probe.creationTime) {
    const d = new Date(probe.creationTime);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return new Date(fallbackMtime).toISOString();
}

async function processPhoto(file, stat, opts) {
  const id = stableId(file.rel);
  const buf = await loadPhotoBuffer(file.abs);
  const [exif, dims] = await Promise.all([readExif(buf), makeDerivativesFromBuffer(buf, id, opts)]);
  return {
    id,
    path: file.rel,
    filename: path.basename(file.rel),
    album: path.dirname(file.rel) === '.' ? '' : path.dirname(file.rel),
    kind: 'photo',
    width: dims.natural.width,
    height: dims.natural.height,
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
}

async function processRaw(file, stat, opts) {
  const id = stableId(file.rel);
  const previewBuf = await extractRawPreview(file.abs);
  if (!previewBuf) throw new Error('no embedded preview in RAW');
  const [exif, dims] = await Promise.all([
    readExif(previewBuf),
    makeDerivativesFromBuffer(previewBuf, id, opts),
  ]);
  return {
    id,
    path: file.rel,
    filename: path.basename(file.rel),
    album: path.dirname(file.rel) === '.' ? '' : path.dirname(file.rel),
    kind: 'photo',
    width: dims.natural.width,
    height: dims.natural.height,
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
}

async function processVideo(file, stat, opts) {
  const id = stableId(file.rel);
  const [posterBuf, probe] = await Promise.all([
    ffmpegPoster(file.abs),
    ffprobeMeta(file.abs),
  ]);
  const dims = await makeDerivativesFromBuffer(posterBuf, id, opts);
  return {
    id,
    path: file.rel,
    filename: path.basename(file.rel),
    album: path.dirname(file.rel) === '.' ? '' : path.dirname(file.rel),
    kind: 'video',
    width: dims.natural.width,
    height: dims.natural.height,
    size: stat.size,
    duration: probe.duration || null,
    date: dateFromVideo(probe, stat.mtime),
    camera: null, iso: null, aperture: null, shutter: null, focalLength: null, gps: null,
  };
}

async function processOne(file, state, opts) {
  const stat = await readStat(file.abs);
  const cached = state.entries[file.rel];
  if (cached && cached.mtime === stat.mtime && cached.size === stat.size) {
    return { ...cached.meta, _cached: true };
  }
  let meta;
  if (file.info.kind === 'video') meta = await processVideo(file, stat, opts);
  else if (file.info.kind === 'raw') meta = await processRaw(file, stat, opts);
  else meta = await processPhoto(file, stat, opts);
  state.entries[file.rel] = { mtime: stat.mtime, size: stat.size, meta };
  return meta;
}

async function pmap(arr, fn, concurrency, onProgress) {
  const result = new Array(arr.length);
  let idx = 0, done = 0;
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

function configFingerprint(opts) {
  return `${opts.thumbSizes.join(',')}@q${opts.quality}`;
}

async function loadState(opts) {
  const statePath = path.join(opts.output, '.cache', 'state.json');
  const fp = configFingerprint(opts);
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    const data = JSON.parse(raw);
    if (data.version === STATE_VERSION && data.config === fp) return data;
    console.log(`Config changed (${data.config || 'v' + data.version} → ${fp}); wiping derivatives`);
    await fs.rm(path.join(opts.output, 'thumbs'), { recursive: true, force: true });
    await fs.rm(path.join(opts.output, 'previews'), { recursive: true, force: true });
  } catch (_) { /* fall through */ }
  return { version: STATE_VERSION, config: fp, entries: {} };
}

async function saveState(state, opts) {
  const statePath = path.join(opts.output, '.cache', 'state.json');
  state.config = configFingerprint(opts);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state));
}

async function cleanupOrphans(seenPaths, state, opts) {
  let removed = 0;
  for (const rel of Object.keys(state.entries)) {
    if (seenPaths.has(rel)) continue;
    const id = state.entries[rel].meta.id;
    await Promise.all(opts.thumbSizes.map((size) =>
      fs.rm(path.join(opts.output, 'thumbs', String(size), `${id}.webp`), { force: true })
    ));
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

  const state = await loadState(opts);
  for (const size of opts.thumbSizes) {
    await fs.mkdir(path.join(opts.output, 'thumbs', String(size)), { recursive: true });
  }

  console.log(`Scanning ${opts.input} (sizes: ${opts.thumbSizes.join(', ')}, album-depth: ${opts.albumDepth})`);
  const { files, droppedDupes } = await walk(opts.input, opts.albumDepth);
  console.log(`Found ${files.length} media items` + (droppedDupes ? ` (${droppedDupes} dropped as dupes)` : ''));
  if (files.length === 0) return;

  const t0 = performance.now();
  let cachedCount = 0, newCount = 0, failCount = 0, videoCount = 0;

  const results = await pmap(files, async (file) => {
    try {
      const meta = await processOne(file, state, opts);
      if (meta._cached) cachedCount++; else newCount++;
      if (meta.kind === 'video') videoCount++;
      const { _cached, ...clean } = meta;
      return clean;
    } catch (err) {
      console.error(`\n! ${file.rel}: ${err.message}`);
      failCount++;
      return null;
    }
  }, CONCURRENCY, logProgress);

  const items = results.filter(Boolean).sort((a, b) => (b.date < a.date ? -1 : 1));
  const seen = new Set(files.map(f => f.rel));
  const orphans = await cleanupOrphans(seen, state, opts);

  const manifest = {
    generated: new Date().toISOString(),
    count: items.length,
    photos: items,
  };

  await fs.writeFile(path.join(opts.output, 'manifest.json'), JSON.stringify(manifest));
  await saveState(state, opts);

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(
    `Done in ${elapsed}s: ${newCount} new, ${cachedCount} cached, ` +
    `${failCount} failed, ${videoCount} videos, ${orphans} orphans cleaned`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
