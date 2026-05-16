# photo-gallery

Static photo gallery generator. Lightweight SPA designed to be served from anemic hardware (e.g. an old NAS) where any dynamic backend is impractical.

## Architecture

```
[Mac / build host]                          [NAS / web server]
  indexer (Node)                              Apache / lighttpd
    sharp → thumbnails                         serves static files
    exifr → metadata                           (no runtime cost)
    writes manifest.json + thumbs/    →    /var/www/gallery/
                                             ├── index.html
                                             ├── manifest.json
                                             ├── thumbs/
                                             └── previews/
                                                    ↑
                                             client browser / PWA
```

Indexer runs anywhere with Node; output is pure static. No database, no server-side code at runtime.

## Components

- `indexer/` — Node script that scans a source directory, generates thumbnails (sharp), reads EXIF (exifr), produces a JSON manifest. Incremental.
- `frontend/` — Single-page app: HTML + CSS + vanilla JS + PhotoSwipe v5 for the lightbox.
