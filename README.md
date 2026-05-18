# NAS Gallery

A static photo gallery for old NAS boxes — the kind that can't run Immich, PhotoPrism, or even Piwigo well. The heavy work happens once on a fast machine; the NAS just serves the resulting static files. Designed for libraries that have outgrown plain SMB but where running a real photo app is impractical.

Tested at **50k photos / 2k videos / 100 albums** (mix of iPhone HEIC, DSLR JPG+RAW, video clips) served from a **WD My Cloud Gen 1** (Clean Debian Jessie).

Targets the same class of boxes that Immich/PhotoPrism won't touch:

- **WD My Cloud Gen 1** (Mindspeed Comcerto 2000 @ 650 MHz, 256 MB RAM)
- **Synology DS115j / DS120j** and other entry-level "j"-series (256–512 MB RAM, Marvell Armada)
- Anything with ≥256 MB RAM that runs Apache, nginx, or lighttpd

## Table of contents

- [Why this exists](#why-this-exists)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Source library access](#source-library-access)
- [Build](#build)
- [Deploy to the web host](#deploy-to-the-web-host)
- [Web server configuration](#web-server-configuration)
- [Running it: manual or scheduled](#running-it-manual-or-scheduled)
  - [Manual mode: a desktop launcher on macOS](#manual-mode-a-desktop-launcher-on-macos)
  - [Scheduled mode: macOS launchd](#scheduled-mode-macos-launchd)
- [CLI reference](#cli-reference)
- [What gets indexed](#what-gets-indexed)
- [Limitations](#limitations)
- [License](#license)

## Why this exists

Most photo-gallery software assumes a real server: Immich and PhotoPrism want 2+ GB of RAM, ship their own database, lean on the GPU for ML. They're great on a NUC. They don't fit on a **WD My Cloud Gen 1**, a **Synology DS115j / DS120j**, or anything with 256–512 MB of RAM and an ARM Cortex-A9 / Marvell Armada from a decade ago.

This project goes the other way — do every expensive thing on your laptop, then leave the NAS as a dumb static file server.

### vs Piwigo

Piwigo runs PHP + MySQL on every page request. On a NAS with 256 MB of RAM it lags even on browsing a folder. Modern Piwigo wants PHP 7.4+/8.x; old NAS distros are stuck on PHP 5.6 / 7.0 and apt has long since EOL'd. The gallery this project makes is plain HTML/CSS/JS/WebP — no PHP, no DB, no app server, no version drift.

### vs thumbsup

[thumbsup](https://thumbsup.github.io/) is the closest sibling — both produce static output. Where this project differs:

- **Modern viewer**. PhotoSwipe v5 with touch, pinch-zoom, video, swipe, fullscreen, share. thumbsup ships a 2015-era click-through gallery.
- **Scales to 100 k+ photos**. A row-justified layout with virtual scrolling keeps the DOM at a few hundred elements regardless of library size. thumbsup adds every photo to the DOM at once and chokes around 10 k.
- **Responsive thumbnails**. Four sizes (256 / 512 / 1024 / 2048) shipped via `srcset`, so the browser loads the right thumb for each tile and the lightbox picks the best for the viewport. thumbsup ships two sizes and one fixed grid.
- **HEIC, RAW, video out of the box**. HEIC variants that even sips and libheif refuse (recent iPhone HEVC Main Still profile) are handled via an ImageMagick fallback. RAW (DNG / CR2 / CR3 / NEF / ARW / RAF / ORF / RW2) uses the camera-embedded JPEG preview via exiftool — no full RAW decode. Videos get a frame extracted by ffmpeg and play natively in-lightbox.
- **Cross-format dedup**. A typical Lightroom workflow keeps JPGs at the album root and DNGs in `dng/<event>/` sub-folders. The indexer groups them within the album and surfaces just the JPG; same for HEIC+JPG pairs from iPhone export and Live Photo MOV+JPG pairs.
- **Faceted filtering**. The album tree and the date tree update each other's counts, so empty intersections (album + month where you took no photos) disappear from the navigation instead of teasing dead clicks.
- **Bilingual UI** out of the box (RU / EN, persisted in localStorage).

### Why it suits old NAS specifically

- **Zero runtime cost on the NAS.** `sendfile()` over plain HTTP is the cheapest thing a webserver does — CPU usage is essentially zero.
- **No mandatory daemon.** The NAS doesn't run Node, Python, ffmpeg, or anything project-specific. Just keep its web server alive.
- **Originals don't move.** The library stays where it is — the gallery surfaces it through an `Alias`, never copies. SMB/NFS access to the same photos keeps working as before.
- **Disk math is gentle.** ~400 KB of thumbnails per photo across all four sizes. 50 k photos = ~20 GB, which is rounding error on any modern NAS.

## Quick start

Tested on macOS 15+ with Node 22. Linux support is planned (the indexer is portable; only the wrapper scripts and the scheduler are macOS-specific today).

```bash
# 1. Install dependencies on your build machine
brew install node@22 ffmpeg exiftool imagemagick

# 2. Install Node deps
cd indexer && /opt/homebrew/opt/node@22/bin/npm install && cd ..

# 3. Mount your original photo library somewhere on the build machine (e.g. read-only NFS)
sudo mkdir -p /Volumes/photo
sudo mount -t nfs -o vers=3,ro,resvport nas.local:/srv/nfs/photo /Volumes/photo

# 4. Build all needed html/js/thumbs → ./dist)
./build.sh /Volumes/photo ./dist

# 5. Set up the web server on your NAS (Apache shown — see examples/webserver/ for nginx/lighttpd)
ssh root@nas
mkdir -p /var/www/html/gallery
cat > /etc/apache2/conf-available/gallery.conf <<'EOF'
Alias /gallery/originals /data/photo
<Directory /data/photo>
    Require all granted
    Options FollowSymLinks
</Directory>
EOF
a2enconf gallery && systemctl reload apache2

# 6. Ship the dist to the NAS
rsync -avh --delete --exclude='.cache/' --exclude='originals' ./dist/ root@nas:/var/www/html/gallery/

# 7. Open the gallery
open http://nas.local/gallery/
```

First build of a 50 k-photo library takes 2–3 hours (most of that is reading photos over the network). Every run after that is incremental: only new or changed photos do work, typical re-build is seconds.

## How it works

```
[build host = Mac/Linux laptop]               [web host = NAS / VPS]
indexer (Node)                                  Apache / nginx / lighttpd
  walks source tree                               serves /gallery/ as static
  sharp → thumbs (4 sizes)                        Alias /gallery/originals/ → photo lib
  ffmpeg → video poster + duration                no PHP, no DB, no Python
  exiftool → RAW preview                                ↑
  magick → HEIC fallback                          browser / PWA, PhotoSwipe v5
  emits manifest.json + thumbs/
       ↓
       sync (rsync over SSH, rsync daemon, or write to a mounted share)
       ↓
  /var/www/.../gallery/
```

Three constraints drove the design:

- **Generate everywhere, serve anywhere.** Heavy work runs on the build host. Output is plain static files; any web server in the world can serve them.
- **No rebuild on every visit.** Thumbnails are produced once and cached on disk. Re-indexing is incremental — only new or changed files do work.
- **Originals stay in place.** Nothing copies your library. The web server exposes the originals via an alias / symlink. Photos can keep living in whatever folder structure you already use.

## Source library access

The indexer reads files through the filesystem — it doesn't care how they got there. Pick whichever mounting style fits your environment.

| Method | When to use | Notes |
|---|---|---|
| Local path | Photos live on the build machine | Fastest. `./build.sh ~/Pictures ./dist` |
| **NFS** | NAS exports NFS to the LAN | Best for mass small-file reads on macOS / Linux. See `examples/mounts/nfs-macos.sh`. |
| **SMB / CIFS** | Synology, Windows share, anything that speaks SMB | Easier setup, slightly slower for tiny files. Finder auto-mounts work. |
| **sshfs** | Source is reachable only via SSH | Slowest but works through firewalls. |

The library may contain Cyrillic, Chinese, emoji, and spaces in folder names — paths are URL-encoded in the manifest so the front-end and web server handle UTF-8 cleanly.

## Build

The indexer is a single Node script. The wrapper `build.sh` invokes it and then rsyncs the static front-end into the same `--output` directory.

```bash
./build.sh /path/to/photos ./dist
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
├── originals → /path/to/photos    (local symlink for previewing — see below)
└── .cache/state.json              (incremental cache, do NOT ship)
```

`originals/` is a convenience symlink for local previewing via `python -m http.server`. On the real web host it gets replaced with an `Alias` so no files are duplicated.

Disk math, roughly: 0.5 KB per photo for the manifest entry, and `thumbs/256 + 512 + 1024 + 2048` come out to ~400 KB per photo combined for typical iPhone / DSLR JPEGs. A 50 k-photo library lands around 20 GB.

## Deploy to the web host

The build host produces `dist/`. Anything that can copy a directory tree across a network can deploy it. Trade-offs:

| Method | Pros | Cons |
|---|---|---|
| **rsync over SSH** | Encrypted, no daemon on target, atomic per file, resumable, incremental | Needs SSH access to the target |
| **rsync to rsync daemon** | Slightly faster (no SSH overhead), simpler auth | Have to run `rsyncd` on the target |
| **Copy to mounted share** (NFS / SMB) | No SSH needed, just write to a folder | Many tiny writes over NFS / SMB are slow; recovery from a half-finished copy is on you |

See `examples/deploy/` for ready-made scripts.

**Recommended**: rsync over SSH. The first deploy pushes ~20 GB; subsequent runs only ship the diff (a re-index of a week of new photos is typically a few MB).

```bash
rsync -avh --progress --delete \
  --exclude='.cache/' \
  --exclude='originals' \
  ./dist/ user@nas:/var/www/html/gallery/
```

If the target has no `rsync` (slim NAS images), the one-line install on a Debian Jessie / Ubuntu archive: `apt-get install --allow-unauthenticated rsync`.

## Web server configuration

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

Full configs (with gzip and cache-headers for thumbs) in `examples/webserver/`.

## Running it: manual or scheduled

The indexer is incremental — untouched files cost nothing on a second run. Pick whichever trigger fits how often you add photos.

| Trigger | Fits | Setup |
|---|---|---|
| **Manual** (one-click on Desktop) | You add photos a few times a month and remember to re-build | See [Manual mode](#manual-mode-a-desktop-launcher-on-macos) below. macOS only for now. |
| **Scheduled** (nightly, every N hours) | Photos arrive regularly and the build machine is mostly on | See [Scheduled mode](#scheduled-mode-macos-launchd) below. macOS launchd today; cron / systemd-timer planned. |
| **Reactive** (watch for new files) | You want the gallery updated minutes after a drop | macOS: `fswatch` + debounce. Linux: `inotifywait`. Out of scope here — the indexer's design supports it. |

"Build + deploy" is two commands; both modes wrap the same one-button script.

### Manual mode: a desktop launcher on macOS

The script `examples/manual/Update_gallery.command` runs `build.sh` and then `rsync`. Set up once, double-click whenever you want a fresh gallery.

```bash
# 1. Copy the launcher to your Desktop (or anywhere convenient)
cp ~/photo-gallery/examples/manual/Update_gallery.command ~/Desktop/

# 2. Make it executable
chmod +x ~/Desktop/Update_gallery.command

# 3. Edit the four paths at the top of the file
#       PROJECT_DIR  = where you cloned photo-gallery
#       INPUT        = the mounted source library
#       OUTPUT       = local build target on your SSD
#       DEPLOY_DEST  = the web host: user@host:/path
open -e ~/Desktop/Update_gallery.command
```

Then to use it:

1. Make sure the source library is mounted. If you use NFS like in the Quick Start above, the mount usually survives reboots; if it disappears after waking from sleep, re-run the `mount` command (or wrap it in a tiny launchd KeepAlive).
2. **Double-click `Update_gallery.command`** on the Desktop.
3. macOS opens a Terminal window, runs build + deploy, prints progress, and waits at the end with `Press any key to close...` so you can read the output.

What happens under the hood, every run:

```
build.sh
  ├─ indexer.js
  │    ├─ walks INPUT recursively
  │    ├─ for each file: checks cache by mtime+size
  │    │   ├─ already known → skip (0 work)
  │    │   └─ new or modified → generate 4 WebP thumbs + read metadata
  │    ├─ removes orphaned thumbs for photos you deleted
  │    └─ rewrites manifest.json
  └─ copies frontend (HTML/CSS/JS) into OUTPUT
rsync OUTPUT/ → DEPLOY_DEST     (ships only the diff)
```

**Typical timing**:

- First run (50 k-photo library, cold): 2–3 h indexing + ~50 min upload.
- Subsequent run after adding 10 new photos: 30 seconds end-to-end.

**What it does NOT do**:

- It doesn't pull anything from your iPhone, Photos.app, or iCloud. The library has to already be on the source storage. If your phone syncs to the NAS via Syncthing / PhotoSync / SMB-upload, those run separately.
- It doesn't manage the web server on the NAS. If something there breaks, the script won't notice — you'll see thumbnails 404.

### Scheduled mode: macOS launchd

If you'd rather have the gallery update itself nightly, point launchd at the same `Update_gallery.command`. See `examples/schedule/macos-launchd.plist` for a ready plist (calendar-based, defaults to 04:30 daily). Install:

```bash
cp examples/schedule/macos-launchd.plist \
   ~/Library/LaunchAgents/com.local.photo-gallery.plist
# edit the file: paths and time → save
launchctl load ~/Library/LaunchAgents/com.local.photo-gallery.plist
```

Logs go to `/tmp/photo-gallery.log` and `/tmp/photo-gallery.err`. If the Mac is asleep at the scheduled time, launchd will run the job at the next wake (provided Power Nap or AC power keeps it eligible).

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
- **Videos**: MOV / MP4 / M4V / 3GP — poster frame via ffmpeg, duration via ffprobe
- **RAW**: DNG / CR2 / CR3 / CRW / NEF / ARW / RAF / ORF / RW2 — embedded JPEG preview via exiftool. The full RAW bytes aren't decoded; the camera's baked-in preview is what's surfaced for browsing. Clicking "open original" downloads the raw file — your editor (Lightroom, Capture One, darktable) handles the rest.

Within each album (see `--album-depth`), files sharing a basename are deduplicated by priority: JPG/PNG/WebP/HEIC/GIF > video > RAW. So a Lightroom workflow that keeps `IMG_5144.JPG` next to `dng/Vatikan/IMG_5144.DNG` shows the JPG and quietly drops the DNG. Apple Live Photos (`IMG_X.JPG` + `IMG_X.MOV` pair) keep just the still. Equal-priority duplicates (two JPGs in different sub-folders with the same basename — common after camera counter wrap-around) are all kept.

## Limitations

- **macOS-only wrappers today.** The indexer code is portable; the launcher scripts (`.command`) and the launchd plist are not. Linux (cron + `.desktop`) and Windows (`.bat` + Task Scheduler) wrappers are planned.
- **iOS 12 and older are not supported** (iPad Air 1, iPad mini 2/3, iPhone 5s/6/6+). Thumbnails are WebP, which Safari only learned to decode in iOS 14. Originals delivered as HEIC don't render in `<img>` until Safari 17 / iOS 17. Older HEIC iPhone videos (HEVC/H.265) also won't play on pre-A9 hardware. iOS 13+ and modern Android browsers are fine.
- **No upscaling.** A 400 × 300 source produces a 400 × 300 file for every requested thumb size larger than 400. Browser still picks the right size from `srcset`.
- **No re-encode of originals.** HEIC originals open in browsers that support them (Safari 17+, iOS 17+) and download elsewhere. RAW always downloads. Videos use whatever codec they were shot with — HEVC clips need a hardware/software decoder on the playing device.
- **No face detection or semantic search.** The current build is a navigation + viewing tool. CLIP-based search and face clustering are feasible follow-ups (the indexer can be extended without changing the front-end's manifest shape).

## License

MIT — see [LICENSE](LICENSE). Fork it, ship it, sell it, no strings.

Third-party components retained at their own licenses inside `frontend/vendor/`:

- [PhotoSwipe v5](https://photoswipe.com) — MIT
