# photo-gallery

A static photo gallery generator. It scans a directory tree of photos and videos, produces a manifest plus WebP thumbnails in four sizes, and ships a single-page front-end you can serve from any HTTP server — including underpowered NAS boxes that can't run Immich, PhotoPrism, or Nextcloud.

```
[build host]                                  [web host]
indexer (Node)                                  Apache / nginx / lighttpd
  walks source tree                               serves /gallery/ as static
  sharp → thumbs (4 sizes)                        Alias /gallery/originals/ → photo lib
  ffmpeg → video poster + duration                no PHP, no Python, no database
  exiftool → RAW preview                                ↑
  magick → HEIC fallback                          browser / PWA, PhotoSwipe v5
  emits manifest.json + thumbs/
       ↓
       sync (rsync over SSH, rsync daemon, or copy to mounted share)
       ↓
  /var/www/.../gallery/
```

Designed around three constraints:

- **Generate everywhere, serve anywhere.** Heavy work runs on a fast machine (your laptop). Output is plain static files; any web server in the world can serve them.
- **No rebuild on every visit.** Thumbnails are produced once and cached on disk. Re-indexing is incremental — only new or changed files do work.
- **Originals stay in place.** Nothing copies your library. The web server exposes the originals via an alias / symlink. Photos can keep living in whatever folder structure you already use.

## Quick start

Tested on macOS 15+ with Node 22. Linux support is planned (the indexer is portable, only the wrapper scripts and the launch daemon are macOS-specific today).

```bash
# 1. Install runtime deps
brew install node@22 ffmpeg exiftool imagemagick

# 2. Install Node deps
cd indexer && /opt/homebrew/opt/node@22/bin/npm install && cd ..

# 3. Build (point --input at your library, --output anywhere local + fast)
./build.sh /path/to/photos ./dist

# 4. Ship dist/ to your web host (see “Deploy” below)
# 5. Configure your web server (see “Web server config” below)
# 6. Open http://your-host/gallery/
```

## How the source library is accessed

The indexer reads files through the filesystem — it doesn't care how they got there. Pick whichever mounting style fits your environment.

| Method | When to use | Notes |
|---|---|---|
| Local path | Photos live on the build machine | Fastest. `./build.sh ~/Pictures ./dist` |
| **NFS** | NAS exports NFS to the LAN | Best for mass small-file reads on macOS/Linux. See `examples/mounts/nfs-macos.sh`. |
| **SMB / CIFS** | Synology, Windows share, anything that speaks SMB | Easier setup, slightly slower for tiny files. Finder auto-mounts work. |
| **sshfs** | Source is reachable only via SSH | Slowest but works through firewalls. |

The library may contain Cyrillic, Chinese, emoji, and spaces in folder names — the indexer URL-encodes paths in the manifest so the front-end and web servers handle UTF-8 cleanly. The "open original" button hits the alias path under `/gallery/originals/...` which means your web server has to be configured to handle the same characters (Apache and nginx both do by default).

## Build

The indexer is a single Node script. The wrapper `build.sh` invokes it and then rsyncs the static front-end into the same `--output` directory.

```bash
./build.sh /path/to/photos ./dist [thumb-sizes] [quality]
```

After the run, `./dist/` looks like this:

```
dist/
├── index.html
├── css/style.css
├── js/app.js
├── vendor/photoswipe/
├── manifest.json
├── thumbs/
│   ├── 256/<id>.webp
│   ├── 512/<id>.webp
│   ├── 1024/<id>.webp
│   └── 2048/<id>.webp
├── originals → /path/to/photos    (symlink — see below)
└── .cache/state.json              (incremental cache, do NOT ship)
```

`originals/` is a convenience symlink for local previewing via `python -m http.server`. On the real web host you replace it with an `Alias` (see below) so no files get copied.

Disk math, roughly: 0.5 KB per photo for the manifest entry, and `thumbs/256` + `512` + `1024` + `2048` come out to ~400 KB per photo combined for typical iPhone/DSLR JPEGs. A 50 k photo library lands at around 20 GB.

## Deploy

The build host produces `dist/`. Anything that can copy a directory tree across a network can deploy it. Trade-offs:

| Method | Pros | Cons |
|---|---|---|
| **rsync over SSH** | Encrypted, no daemon on target, atomic per file, resumable, incremental | Needs SSH access to the target |
| **rsync to rsync daemon** | Slightly faster (no SSH overhead), simpler auth | Have to run `rsyncd` on the target |
| **Copy to mounted share** (NFS/SMB) | No SSH needed, just write to a folder | Many tiny writes over NFS/SMB are slow; recoverability from a half-finished copy is on you |

See `examples/deploy/` for ready scripts.

**Recommended**: rsync over SSH. The first deploy pushes ~20 GB; subsequent runs only ship the diff (a re-indexed week of new photos is typically a few MB).

```bash
rsync -avh --progress --delete \
  --exclude='.cache/' \
  --exclude='originals' \
  ./dist/ user@nas:/var/www/html/gallery/
```

If the target has no `rsync` (slim NAS images), one-line install on Debian / Jessie / Ubuntu: `apt-get install --allow-unauthenticated rsync`.

## Web server config

Two URL paths need to resolve:

- `/gallery/` → the static `dist/` directory
- `/gallery/originals/` → your photo library root (no copying — direct alias)

### Apache

```apache
# /etc/apache2/conf-available/gallery.conf

Alias /gallery/originals /data/photo
<Directory /data/photo>
    Require all granted
    Options FollowSymLinks
</Directory>
```

Enable: `a2enconf gallery && systemctl reload apache2`. The `/gallery/` route is served from the document root by default once you rsync the build into `DocumentRoot/gallery/`.

### nginx

```nginx
location /gallery/ {
    alias /var/www/html/gallery/;
}

location /gallery/originals/ {
    alias /data/photo/;
}
```

### lighttpd

```lighttpd
alias.url += (
    "/gallery/originals/" => "/data/photo/",
    "/gallery/"           => "/var/www/html/gallery/",
)
```

Full configs in `examples/webserver/`.

## When to re-index

The indexer is incremental: untouched files cost nothing on a second run. Three reasonable triggers:

| Trigger | When it fits | Setup |
|---|---|---|
| **Manual** | You add photos a few times a month and remember to run a script | Save `./build.sh ... && rsync ...` as a `.command` on macOS or a `.sh` on Linux, double-click. See `examples/manual/Update_gallery.command`. |
| **Scheduled** | You add photos regularly, build machine is always on | macOS: `launchd` plist (see `examples/schedule/macos-launchd.plist`). Linux: cron. |
| **Reactive** | You want the gallery to update minutes after you drop new photos | macOS: `fswatch` + debounce. Linux: `inotifywait`. Out of scope for now, but the indexer's design supports it. |

Whichever you pick, "build + deploy" is two commands you can wrap in one shell script.

## CLI reference

```
indexer.js --input <dir> --output <dir> [options]

Options:
  --thumb-sizes A,B,C   Comma-separated long-edge sizes in px.
                        Default: 256,512,1024,2048
  --quality N           WebP quality 1–100. Default: 82.
  --album-depth N       Cross-format dedup scope. 1 (default) treats
                        the first path segment under input as an album,
                        which is right when --input points at the photo
                        library root. 0 makes the whole input one album
                        (use this when testing on a single album).
```

The state cache lives in `<output>/.cache/state.json`. Changing `--thumb-sizes` or `--quality` invalidates the cache automatically and re-encodes all thumbnails.

## What gets indexed

- **Photos**: JPG / JPEG / PNG / WebP / HEIC / HEIF / GIF
- **Videos**: MOV / MP4 / M4V / 3GP — poster frame extracted via ffmpeg, duration via ffprobe
- **RAW**: DNG / CR2 / CR3 / CRW / NEF / ARW / RAF / ORF / RW2 — embedded JPEG preview extracted via exiftool. The full RAW bytes aren't decoded; the camera's baked-in preview is what's surfaced for browsing. Clicking "open original" downloads the raw file — your editor (Lightroom, Capture One, darktable) handles the rest.

Within each album (see `--album-depth`), files sharing a basename are deduplicated by priority: JPG/PNG/WebP/HEIC/GIF > video > RAW. So a Lightroom workflow that keeps `IMG_5144.JPG` next to `dng/Vatikan/IMG_5144.DNG` shows the JPG and quietly drops the DNG. Apple Live Photos (`IMG_X.JPG` + `IMG_X.MOV` pair) keep just the still. Equal-priority duplicates (two JPGs in different sub-folders with the same basename — common after camera counter wrap-around) are all kept.

## Limitations

- **macOS today.** The indexer code is portable; the wrappers and scheduler examples are not. Linux & Windows wrappers are planned.
- **No upscaling.** A 400 × 300 source produces a 400 × 300 file for every requested thumb size larger than 400. Browser still picks the right size from `srcset`.
- **No re-encode of originals.** HEIC originals open in browsers that support them (Safari, iOS) and download elsewhere (desktop Chrome / Firefox). RAW always downloads.
- **No face detection or semantic search.** The current build is a navigation + viewing tool. CLIP-based search and face clustering are feasible follow-ups (the indexer can be extended without changing the front-end's manifest shape).

## License

(add when you decide)
