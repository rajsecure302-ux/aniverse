# AniVerse

**Live:** https://rajsecure302-ux.github.io/aniverse/

A fast, dark, cinematic anime site — trending rows, official trailers, instant search, a personal watchlist, and **My library**: a MovieBox-style local player for the episodes you own.

No build step, no framework, no tracking. Just `index.html`, `style.css`, `app.js`, `library.js`.

![stack](https://img.shields.io/badge/stack-vanilla%20JS-f7df1e) ![data](https://img.shields.io/badge/data-AniList%20GraphQL-02a9ff) ![license](https://img.shields.io/badge/license-MIT-green)

## What it does

- **Trending / This season / Top rated / Movies** rows, all live from [AniList](https://anilist.co).
- **Hero carousel** with banners, score, genres, synopsis and trailer button.
- **Search** (`/` shortcut) with debounced live results.
- **Detail sheet** — synopsis, facts, studios, genres, trailer, AniList link, Crunchyroll search link, and **official per-episode links** straight from AniList (`streamingEpisodes`).
- **My list** — saved in `localStorage`, shows up as its own row.
- **Browse view** with paging ("Load more") for every row.
- **My library** — point it at a folder of episodes and it builds a poster grid, matched to AniList artwork. Series → episode list → player, with subtitles, auto-next, resume and a *Continue watching* row.
- **Built-in player** — custom controls, ±10s, speed, volume, PiP, fullscreen, external `.srt`/`.vtt` subtitles, keyboard shortcuts, resume where you left off.
- **Deep links** — `#/anime/<id>`, `#/browse/top`, `#/browse/movies`, `#/mylist`.
- **Smart caching** — API responses cached for 45 min (also serves as an offline-ish fallback).
- Responsive down to small phones, keyboard accessible, respects `prefers-reduced-motion`.

## Run it

Any static server works:

```bash
cd animesite
python3 -m http.server 8080
# open http://127.0.0.1:8080
```

or just open `index.html` in a browser (needs internet for AniList images/API).

## Install as an app (PWA)

AniVerse is installable and works offline.

- **Android / Chrome** — tap **⤓** in the top bar (or the browser's *Add to Home screen*). It opens standalone, fullscreen, with its own icon.
- **Desktop** — the same ⤓ button, or the install icon in the address bar.
- **Offline** — a service worker (`sw.js`) caches the app shell (`index.html`, CSS, JS, icons) network-first. AniList data falls back to the 45-minute cache and artwork stays in the browser cache, so browsing still works without a connection. Episodes play from local files anyway.

Files: `manifest.webmanifest`, `sw.js`, `icons/`.

## My library

Tap **Library** in the top bar (or open `#/library`).

1. **Folder chuno** — scans the folder (3 levels deep) for video + subtitle files. On desktop and Android Chrome it uses the File System Access API, so the folder stays linked after a reload.
2. Filenames are parsed automatically — `Show - 05.mkv`, `Show.S02E05.1080p.mkv`, `Show 1x05.mp4`, `Show Episode 5.mp4`, `第05话` all group correctly.
3. Each series is matched to **AniList** for its poster, banner, year and score (cached 7 days, runs in the background).
4. Play an episode and you get subtitles (`.srt` next to the video is picked up automatically), resume, speed, PiP, fullscreen and **auto-next** with an 8-second countdown.

Everything stays on the device: files are read locally with `File`/`FileSystemHandle`, progress lives in `localStorage`, and only the *title* is sent to AniList to fetch artwork.

Supported containers depend on the browser — **MP4/H.264 and WebM** play everywhere; MKV plays when the codecs inside are supported.

## Keyboard

| Key | Action |
| --- | --- |
| `/` | focus search |
| `Esc` | close sheet / overlay / player |
| `Space` | play-pause (player) |
| `←` `→` | seek ±10s |
| `↑` `↓` | volume |
| `M` | mute |
| `F` | fullscreen |

## Tests

```bash
cd animesite/test
npm install
python3 -m http.server 8080 &   # from animesite/
node smoke.mjs
```

`smoke.mjs` boots the real page in jsdom against the live AniList API and asserts rows, hero, detail sheet, watchlist, trailer, browse paging and search.

`pwa.mjs` checks the manifest, icons, service worker and the install wiring.

`library.mjs` feeds fake files into the library input and asserts filename parsing (season/episode/number), grouping, the series view, subtitle matching, playback, auto-next and the continue-watching row.

## Notes on content

AniVerse does **not** host or stream anime. It shows metadata and artwork from AniList, plays **official YouTube trailers**, links out to legal services (JustWatch, Crunchyroll, JioCinema), and plays **video files you already own** through My library.

No pirated streams, no scrapers, no third-party stream APIs — by design.

## License

MIT — data © AniList contributors, trailers © their respective owners.
