# AniVerse

**Live:** https://rajsecure302-ux.github.io/aniverse/

A fast, dark, cinematic anime site — trending rows, official trailers, instant search, a personal watchlist, and a built-in player for local video files.

No build step, no framework, no tracking. Just `index.html`, `style.css`, `app.js`.

![stack](https://img.shields.io/badge/stack-vanilla%20JS-f7df1e) ![data](https://img.shields.io/badge/data-AniList%20GraphQL-02a9ff) ![license](https://img.shields.io/badge/license-MIT-green)

## What it does

- **Trending / This season / Top rated / Movies** rows, all live from [AniList](https://anilist.co).
- **Hero carousel** with banners, score, genres, synopsis and trailer button.
- **Search** (`/` shortcut) with debounced live results.
- **Detail sheet** — synopsis, facts, studios, genres, trailer, AniList link, Crunchyroll search link.
- **My list** — saved in `localStorage`, shows up as its own row.
- **Browse view** with paging ("Load more") for every row.
- **Local video player** — open any video file from the device; custom controls, keyboard shortcuts, resume where you left off.
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

The smoke test boots the real page in jsdom against the live AniList API and asserts rows, hero, detail sheet, watchlist, trailer, browse paging and search.

## Notes on content

AniVerse does **not** host or stream anime. It shows metadata and artwork from AniList, plays **official YouTube trailers**, links out to legal services, and plays **video files you already own** through the local player.

## License

MIT — data © AniList contributors, trailers © their respective owners.
