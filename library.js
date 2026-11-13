/* =========================================================
   AniVerse Library
   A MovieBox-style local library: folder scan, AniList poster
   matching, season/episode list, subtitles, auto-next, resume.
   Everything stays on the device — no uploads, no servers.
   ========================================================= */
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  const fmtTime = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  };
  const fmtSize = (b) => {
    if (!b) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (b < 10 && i > 0 ? b.toFixed(1) : Math.round(b)) + ' ' + u[i];
  };
  const pad2 = (n) => String(n).padStart(2, '0');
  const hash = (s) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  };

  const VIDEO_RE = /\.(mp4|m4v|webm|ogv|mov|mkv|avi|ts|m2ts|flv|3gp|wmv)$/i;
  const SUB_RE = /\.(srt|vtt|ass|ssa)$/i;

  /* =========================================================
     storage
     ========================================================= */
  const IDX_KEY = 'av:libidx';      // series index (no file data)
  const POS_KEY = 'av:libpos';      // watch progress
  const META_KEY = 'av:lmeta:';     // AniList match cache

  const readJSON = (k, def) => {
    try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? def : v; }
    catch (e) { return def; }
  };
  const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  const getPos = () => readJSON(POS_KEY, {});
  function savePos(seriesId, epIdx, t, d) {
    const all = getPos();
    const k = seriesId + '|' + epIdx;
    if (!d) return;
    if (t > d - 15) delete all[k];
    else all[k] = { t: Math.round(t), d: Math.round(d), at: Date.now() };
    // keep it small
    const keys = Object.keys(all);
    if (keys.length > 200) {
      keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
      keys.slice(0, keys.length - 200).forEach((x) => delete all[x]);
    }
    writeJSON(POS_KEY, all);
  }

  /* IndexedDB: keep directory / file handles so the library survives reloads */
  const DB = 'av-library', ST = 'kv';
  function openDB() {
    return new Promise((res, rej) => {
      let req;
      try { req = indexedDB.open(DB, 1); } catch (e) { return rej(e); }
      req.onupgradeneeded = () => { try { req.result.createObjectStore(ST); } catch (e) {} };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }
  async function idbSet(k, v) {
    try {
      const db = await openDB();
      await new Promise((res, rej) => {
        const tx = db.transaction(ST, 'readwrite');
        tx.objectStore(ST).put(v, k);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
      db.close();
    } catch (e) { /* private mode — ignore */ }
  }
  async function idbGet(k) {
    try {
      const db = await openDB();
      const v = await new Promise((res, rej) => {
        const tx = db.transaction(ST, 'readonly');
        const rq = tx.objectStore(ST).get(k);
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
      });
      db.close();
      return v;
    } catch (e) { return null; }
  }

  /* =========================================================
     filename parsing
     ========================================================= */
  const NOISE = /\b(\d{3,4}p|4k|8k|uhd|x264|x265|h\.?264|h\.?265|hevc|avc|10bit|8bit|hdr10|hdr|web[- ]?dl|webrip|web|bluray|blu-ray|bdrip|brrip|dvdrip|hdtv|remux|proper|repack|extended|uncensored|dual[- ]?audio|multi[- ]?subs?|softsubs?|hardsubs?|eng(?:lish)?[- ]?subs?|jap(?:anese)?|hindi|tamil|telugu|dub(?:bed)?|sub(?:bed|s)?|aac|ac3|eac3|dts|flac|opus|5\.1|2\.0)\b/gi;

  function cleanTitle(t) {
    return t
      .replace(/[\[\]\(\)\{\}]/g, ' ')
      .replace(/[_.]+/g, ' ')
      .replace(/[-–—]+\s*$/g, ' ')
      .replace(/^[\s\-–—.,]+/g, ' ')
      .replace(NOISE, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s\-–—.,]+|[\s\-–—.,]+$/g, '')
      .trim();
  }

  function parseName(fileName) {
    let base = String(fileName).replace(/\.[^.]+$/, '');
    // drop bracketed/parenthesised tags like [1080p], (x265), [Group]
    base = base.replace(/[\[\(\{][^\]\)\}]*[\]\)\}]/g, ' ');
    base = base.replace(/[_.]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

    let season = null, ep = null, title = base, m;

    if ((m = base.match(/\bS(\d{1,2})\s*E(?:P)?\s*(\d{1,4})\b/i))) {
      season = +m[1]; ep = +m[2]; title = base.replace(m[0], ' ');
    } else if ((m = base.match(/\b(\d{1,2})\s*x\s*(\d{1,4})\b/))) {
      season = +m[1]; ep = +m[2]; title = base.replace(m[0], ' ');
    } else if ((m = base.match(/\bSeason\s*(\d{1,2})\b/i))) {
      season = +m[1];
      title = base.replace(m[0], ' ');
      const m2 = title.match(/\b(?:Episode|Ep|E)\s*[.\-:]?\s*(\d{1,4})\b/i) || title.match(/(\d{1,4})\s*$/);
      if (m2) { ep = +m2[1]; title = title.replace(m2[0], ' '); }
    } else if ((m = base.match(/\b(?:Episode|Ep)\s*[.\-:]?\s*(\d{1,4})\b/i))) {
      ep = +m[1]; title = base.replace(m[0], ' ');
    } else if ((m = base.match(/\bE\s*(\d{1,4})\b/))) {
      ep = +m[1]; title = base.replace(m[0], ' ');
    } else if ((m = base.match(/第\s*(\d{1,4})\s*[话話集]/))) {
      ep = +m[1]; title = base.replace(m[0], ' ');
    } else if ((m = base.match(/(?:^|[\s\-–—])(\d{1,4})(?:v\d)?\s*$/))) {
      ep = +m[1];
      title = base.slice(0, m.index);
    }

    title = cleanTitle(title);
    if (!title || /^\d+$/.test(title)) title = cleanTitle(base) || 'Untitled';
    return { title, season, ep };
  }

  const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  function seriesIdFor(p) {
    return slug(p.title) + (p.season ? '-' + p.season : '');
  }
  function displayTitle(p) {
    return p.title + (p.season && p.season > 1 ? ' · Season ' + p.season : '');
  }

  /* =========================================================
     state
     ========================================================= */
  let series = [];            // loaded series objects
  let fileMap = new Map();    // "seriesId|epIdx" -> File
  let subMap = new Map();     // "seriesId|epIdx" -> { name, text }
  let currentSeries = null;
  let view = 'grid';
  let scanBusy = false;

  const seriesById = (id) => series.find((s) => s.id === id);

  /* =========================================================
     AniList poster matching (background, cached)
     ========================================================= */
  const MATCH_Q = `query($q:String){Page(page:1,perPage:4){media(type:ANIME,isAdult:false,search:$q,sort:SEARCH_MATCH){
    id title{romaji english} coverImage{extraLarge large color} bannerImage
    averageScore episodes seasonYear format genres
  }}}`;

  const matchCache = new Map();
  const matchQueue = [];
  let matching = false;

  function metaKey(t) { return META_KEY + hash(t.toLowerCase()); }

  function readMeta(t) {
    if (matchCache.has(t)) return matchCache.get(t);
    const raw = readJSON(metaKey(t), null);
    if (raw && Date.now() - raw.t < 7 * 864e5) {
      matchCache.set(t, raw.d);
      return raw.d;
    }
    return undefined;
  }
  function writeMeta(t, d) {
    matchCache.set(t, d);
    writeJSON(metaKey(t), { t: Date.now(), d });
  }

  /* strip season/part suffixes so "Jujutsu Kaisen Season 2" matches the show */
  function searchTerm(title) {
    return title
      .replace(/\b(season|part|cour)\s*\d+\b/gi, ' ')
      .replace(/\b(s\d+|part\s*[ivx]+)\b/gi, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim() || title;
  }

  async function fetchMatch(title) {
    const body = {
      query: MATCH_Q,
      variables: { q: searchTerm(title) }
    };
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (json.errors && json.errors.length) throw new Error(json.errors[0].message);
    const list = (json.data && json.data.Page && json.data.Page.media) || [];
    if (!list.length) return null;
    // prefer the entry whose title best overlaps the filename title
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const want = norm(searchTerm(title));
    let best = list[0], bestScore = -1;
    list.forEach((m) => {
      const a = norm(m.title.english), b = norm(m.title.romaji);
      let sc = 0;
      if (a === want || b === want) sc = 3;
      else if (want && (a.includes(want) || want.includes(a) || b.includes(want) || want.includes(b))) sc = 2;
      if (!sc) {
        // token overlap
        const toks = searchTerm(title).toLowerCase().split(/\s+/).filter((x) => x.length > 2);
        const hay = (a + ' ' + b);
        sc = toks.filter((x) => hay.includes(x)).length / Math.max(1, toks.length);
      }
      if (sc > bestScore) { bestScore = sc; best = m; }
    });
    if (bestScore < 0.34) return null;
    return {
      id: best.id,
      title: best.title.english || best.title.romaji,
      cover: best.coverImage && (best.coverImage.extraLarge || best.coverImage.large),
      color: best.coverImage && best.coverImage.color,
      banner: best.bannerImage,
      score: best.averageScore,
      episodes: best.episodes,
      year: best.seasonYear,
      format: best.format,
      genres: (best.genres || []).slice(0, 3)
    };
  }

  function queueMatch(s) {
    const cached = readMeta(s.title);
    if (cached !== undefined) {
      if (cached) Object.assign(s, metaFields(cached));
      return;
    }
    if (s._queued) return;
    s._queued = true;
    matchQueue.push(s);
    pumpMatch();
  }

  const metaFields = (m) => ({
    alId: m.id, cover: m.cover, color: m.color, banner: m.banner,
    score: m.score, alEpisodes: m.episodes, year: m.year, genres: m.genres
  });

  async function pumpMatch() {
    if (matching) return;
    matching = true;
    while (matchQueue.length) {
      const s = matchQueue.shift();
      try {
        const m = await fetchMatch(s.title);
        writeMeta(s.title, m);
        if (m) {
          Object.assign(s, metaFields(m));
          const card = document.querySelector('.lib-card[data-id="' + s.id + '"]');
          if (card) {
            const oldPoster = card.querySelector('.lib-poster');
            const fresh = posterNode(s);
            if (oldPoster && fresh) oldPoster.replaceWith(fresh);
          }
          if (currentSeries === s) renderSeries();
        }
      } catch (e) { /* offline — keep placeholder */ }
      await new Promise((r) => setTimeout(r, 900));
    }
    matching = false;
    persistIndex();
  }

  /* =========================================================
     indexing files
     ========================================================= */
  function indexFiles(entries) {
    // entries: [{ file, handle? }]
    const vids = [];
    const subs = [];
    entries.forEach((e) => {
      const name = e.file.name;
      if (VIDEO_RE.test(name)) vids.push(e);
      else if (SUB_RE.test(name)) subs.push(e);
    });

    if (!vids.length) {
      toast(subCount(entries) ? 'Sirf subtitles mile — video files bhi chahiye' : 'Koi video file nahi mili');
      return 0;
    }

    const groups = new Map();
    vids.forEach((e) => {
      const p = parseName(e.file.name);
      const id = seriesIdFor(p);
      if (!groups.has(id)) {
        groups.set(id, {
          id,
          title: p.title,
          season: p.season,
          episodes: [],
          addedAt: Date.now()
        });
      }
      groups.get(id).episodes.push({
        name: e.file.name,
        size: e.file.size,
        file: e.file,
        handle: e.handle || null,
        label: e.file.name.replace(/\.[^.]+$/, '')
      });
    });

    // merge with existing series (reconnect / add more)
    let added = 0;
    groups.forEach((g) => {
      g.episodes.sort((a, b) => {
        const pa = parseName(a.name).ep, pb = parseName(b.name).ep;
        if (pa != null && pb != null && pa !== pb) return pa - pb;
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      });
      g.episodes.forEach((ep, i) => { ep.idx = i; ep.num = parseName(ep.name).ep; });

      const existing = seriesById(g.id);
      if (existing) {
        // replace episodes, keep metadata
        existing.episodes = g.episodes;
        existing.addedAt = g.addedAt;
        existing.offline = false;
        g.episodes.forEach((ep) => fileMap.set(g.id + '|' + ep.idx, ep.file));
        added += g.episodes.length;
      } else {
        const s = { ...g, epCount: g.episodes.length };
        series.push(s);
        g.episodes.forEach((ep) => fileMap.set(g.id + '|' + ep.idx, ep.file));
        added += g.episodes.length;
        queueMatch(s);
      }
    });

    // attach subtitle files
    subs.forEach((e) => {
      const p = parseName(e.file.name);
      const target = series.find((s) => s.id === seriesIdFor(p)) ||
                     series.find((s) => slug(s.title) === slug(p.title));
      if (!target) return;
      let epIdx = 0;
      if (p.ep != null) {
        const hit = target.episodes.findIndex((ep) => ep.num === p.ep);
        epIdx = hit >= 0 ? hit : 0;
      }
      const key = target.id + '|' + epIdx;
      if (!subMap.has(key)) subMap.set(key, { name: e.file.name, file: e.file });
    });

    series.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
    indexOnly = series.some((s) => !!s.offline);
    persistIndex();
    return added;
  }

  const subCount = (entries) => entries.some((e) => SUB_RE.test(e.file.name));

  function persistIndex() {
    const idx = series.map((s) => ({
      id: s.id, title: s.title, season: s.season, addedAt: s.addedAt,
      alId: s.alId, cover: s.cover, color: s.color, banner: s.banner,
      score: s.score, year: s.year, genres: s.genres,
      episodes: s.episodes.map((e) => ({ name: e.name, size: e.size, num: e.num, idx: e.idx }))
    }));
    writeJSON(IDX_KEY, idx);
  }

  /* =========================================================
     picking files
     ========================================================= */
  async function walkDir(dir, depth, out, prefix) {
    if (depth > 3) return out;
    try {
      for await (const [name, h] of dir.entries()) {
        if (name.startsWith('.')) continue;
        if (h.kind === 'directory') {
          await walkDir(h, depth + 1, out, prefix + name + '/');
        } else if (VIDEO_RE.test(name) || SUB_RE.test(name)) {
          try { out.push({ file: await h.getFile(), handle: h, path: prefix + name }); }
          catch (e) { /* unreadable */ }
        }
      }
    } catch (e) { /* permission */ }
    return out;
  }

  async function pickFolder() {
    if (scanBusy) return;
    if (typeof window.showDirectoryPicker === 'function') {
      let dir;
      try { dir = await window.showDirectoryPicker({ mode: 'read' }); }
      catch (e) { return; } // user cancelled
      scanBusy = true;
      toast('Scanning folder…', 4000);
      try {
        const out = await walkDir(dir, 0, [], '');
        const n = indexFiles(out);
        const prev = (await idbGet('dirs')) || [];
        const same = prev.some((d) => d && d.name === dir.name);
        if (!same) await idbSet('dirs', prev.concat([dir]));
        toast(n ? n + ' episode' + (n > 1 ? 's' : '') + ' added' : 'Folder already in library');
      } finally {
        scanBusy = false;
        renderAll();
      }
      return;
    }
    // fallback: directory input (Android / older browsers)
    $('#libDirInput').click();
  }

  function pickFiles() {
    $('#libFileInput').click();
  }

  async function handleFileList(fileList) {
    const entries = Array.from(fileList || []).map((f) => ({ file: f }));
    if (!entries.length) return;
    scanBusy = true;
    toast('Adding ' + entries.length + ' file' + (entries.length > 1 ? 's' : '') + '…');
    try {
      const n = indexFiles(entries);
      if (n) toast(n + ' episode' + (n > 1 ? 's' : '') + ' added');
    } finally {
      scanBusy = false;
      renderAll();
    }
  }

  /* restore handles from IndexedDB (needs a user gesture on most browsers) */
  async function reconnect(interactive) {
    const dirs = (await idbGet('dirs')) || [];
    if (!dirs.length) {
      // nothing stored — fall back to saved index (read-only view)
      if (!interactive) restoreIndexOnly();
      return false;
    }

    let granted = 0;
    const out = [];
    for (const h of dirs) {
      if (!h) continue;
      try {
        let perm = 'granted';
        if (h.queryPermission) perm = await h.queryPermission({ mode: 'read' });
        if (perm !== 'granted' && interactive && h.requestPermission) {
          perm = await h.requestPermission({ mode: 'read' });
        }
        if (perm === 'granted') {
          granted++;
          await walkDir(h, 0, out, '');
        }
      } catch (e) { /* skip */ }
    }
    if (!granted) {
      if (!interactive) restoreIndexOnly();
      return false;
    }
    if (out.length) {
      scanBusy = true;
      try { indexFiles(out); } finally { scanBusy = false; }
      renderAll();
      return true;
    }
    restoreIndexOnly();
    return false;
  }

  let indexOnly = false;
  function restoreIndexOnly() {
    const idx = readJSON(IDX_KEY, []);
    if (!idx.length || series.length) return;
    series = idx.map((s) => ({ ...s, offline: true }));
    indexOnly = true;
    renderAll();
  }

  /* =========================================================
     UI: toast
     ========================================================= */
  let toastTimer = null;
  function toast(msg, ms) {
    const box = $('#toasts');
    if (!box) return;
    const t = el('div', 'toast');
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => {
      t.style.transition = 'opacity .25s, transform .25s';
      t.style.opacity = '0';
      t.style.transform = 'translateY(8px)';
      setTimeout(() => t.remove(), 260);
    }, ms || 2600);
  }

  /* =========================================================
     UI: library screen
     ========================================================= */
  const lib = () => $('#library');

  function openLibrary(skipHash) {
    lib().hidden = false;
    document.documentElement.style.overflow = 'hidden';
    view = 'grid';
    currentSeries = null;
    renderLibrary();
    if (!skipHash) setHash('#/library');
  }
  function closeLibrary(fromHash) {
    lib().hidden = true;
    document.documentElement.style.overflow = '';
    closePlayer();
    if (!fromHash && /^#\/library/.test(location.hash)) setHash('#/', true);
  }

  function setHash(h, replace) {
    if (location.hash === h) return;
    if (replace) history.replaceState(null, '', h);
    else location.hash = h;
  }

  function renderLibrary() {
    const t = $('#libTitle');
    if (t) t.textContent = 'My library';
    const sub = $('#libSub');
    if (sub) {
      const eps = series.reduce((n, s) => n + s.episodes.length, 0);
      sub.textContent = series.length ? series.length + ' title' + (series.length > 1 ? 's' : '') + ' · ' + eps + ' episodes' : '';
    }
    renderGrid();
  }

  function renderAll() {
    renderGrid();
    renderContinueRow();
    if (currentSeries) renderSeries();
  }

  function progressOf(s, ep) {
    const p = getPos()[s.id + '|' + ep.idx];
    return p && p.d ? Math.min(1, p.t / p.d) : 0;
  }
  function seriesProgress(s) {
    if (!s.episodes.length) return 0;
    const done = s.episodes.filter((e) => progressOf(s, e) > 0.92).length;
    return done / s.episodes.length;
  }
  function nextEp(s) {
    const pos = getPos();
    for (const ep of s.episodes) {
      const p = pos[s.id + '|' + ep.idx];
      if (!p || (p.d && p.t < p.d * 0.92)) return ep;
    }
    return null;
  }

  function gradientFor(s) {
    const h = parseInt(hash(s.title).slice(0, 6), 36) % 360;
    return 'linear-gradient(150deg,hsl(' + h + ' 45% 26%),hsl(' + ((h + 48) % 360) + ' 55% 14%))';
  }

  function posterNode(s, cls) {
    const p = el('div', cls || 'lib-poster');
    if (s.color) p.style.background = s.color;
    else p.style.background = gradientFor(s);

    if (s.cover) {
      const img = el('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.onload = () => img.classList.add('loaded');
      img.onerror = () => img.remove();
      img.src = s.cover;
      p.appendChild(img);
    } else {
      const ini = el('span', 'lib-ini');
      ini.textContent = (s.title || '?').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
      p.appendChild(ini);
    }

    const badge = el('span', 'lib-count');
    badge.textContent = s.episodes.length + ' EP';
    p.appendChild(badge);

    const pr = seriesProgress(s);
    if (pr > 0) {
      const bar = el('div', 'lib-progress', '<i></i>');
      bar.firstChild.style.width = Math.round(pr * 100) + '%';
      p.appendChild(bar);
    }
    return p;
  }

  function renderGrid() {
    const body = $('#libBody');
    if (!body || view !== 'grid') return;
    body.innerHTML = '';

    if (!series.length) {
      body.appendChild(emptyState());
      return;
    }

    const q = ($('#libSearch') && $('#libSearch').value || '').trim().toLowerCase();
    const list = q ? series.filter((s) => s.title.toLowerCase().includes(q)) : series.slice();

    if (indexOnly) {
      const bar = el('div', 'lib-banner',
        '<b>Files reconnect karo</b><span>Library index saved hai — video files dobara pick karo to chalega.</span>');
      const b = el('button', 'btn small primary', 'Reconnect');
      b.type = 'button';
      b.addEventListener('click', async () => {
        const ok = await reconnect(true);
        if (!ok) toast('Folder permission nahi mili — dobara try karo');
        else renderAll();
      });
      bar.appendChild(b);
      body.appendChild(bar);
    }

    if (!list.length) {
      body.appendChild(el('div', 'empty', 'Kuch nahi mila “' + esc(q) + '” ke liye.'));
      return;
    }

    const grid = el('div', 'lib-grid');
    list.forEach((s) => {
      const card = el('button', 'lib-card');
      card.type = 'button';
      card.dataset.id = s.id;
      card.setAttribute('aria-label', s.title);
      card.appendChild(posterNode(s));
      card.appendChild(el('div', 'lib-name', esc(s.title)));
      const meta = [s.year && s.year, s.episodes.length + ' episodes'].filter(Boolean).join(' · ');
      card.appendChild(el('div', 'lib-meta', esc(meta)));
      card.addEventListener('click', () => openSeries(s));
      grid.appendChild(card);
    });
    body.appendChild(grid);
  }

  function emptyState() {
    const box = el('div', 'lib-empty');
    box.innerHTML =
      '<div class="lib-empty-ico">▣</div>' +
      '<h3>Apni anime library banao</h3>' +
      '<p>Phone ya PC ka folder chuno jisme episodes hain. AniVerse unhe MovieBox jaisa library bana dega — poster, season, episode list, subtitles, resume.</p>' +
      '<div class="lib-empty-btns"></div>' +
      '<p class="tiny">Sab kuch device par rehta hai. Koi upload nahi, koi server nahi.</p>' +
      '<p class="tiny lib-legal">Files nahi hain? Free legal platforms: ' +
      '<a href="https://www.justwatch.com/in" target="_blank" rel="noopener">JustWatch</a> · ' +
      '<a href="https://www.crunchyroll.com/videos/alphabetical" target="_blank" rel="noopener">Crunchyroll</a> · ' +
      '<a href="https://www.jiocinema.com/" target="_blank" rel="noopener">JioCinema</a></p>';
    const btns = $('.lib-empty-btns', box);
    const b1 = el('button', 'btn primary', '📁 Folder chuno');
    b1.type = 'button';
    b1.addEventListener('click', pickFolder);
    const b2 = el('button', 'btn glass', '🎬 Files chuno');
    b2.type = 'button';
    b2.addEventListener('click', pickFiles);
    btns.appendChild(b1);
    btns.appendChild(b2);
    return box;
  }

  /* =========================================================
     UI: series detail
     ========================================================= */
  function openSeries(s, skipHash) {
    currentSeries = s;
    view = 'series';
    renderSeries();
    if (!skipHash) setHash('#/library/' + s.id);
    lib().scrollTop = 0;
  }

  function renderSeries() {
    const body = $('#libBody');
    const s = currentSeries;
    if (!body || !s || view !== 'series') return;
    body.innerHTML = '';

    const head = el('div', 'lib-series');

    const back = el('div', 'lib-series-top');
    const bBtn = el('button', 'icon-btn', '←');
    bBtn.type = 'button';
    bBtn.setAttribute('aria-label', 'Back to library');
    bBtn.addEventListener('click', () => {
      view = 'grid';
      currentSeries = null;
      renderLibrary();
      setHash('#/library');
    });
    back.appendChild(bBtn);
    head.appendChild(back);

    const hero = el('div', 'lib-hero');
    if (s.banner) {
      hero.style.backgroundImage = 'url("' + s.banner + '")';
      hero.classList.add('has-banner');
    }
    const fade = el('div', 'lib-hero-fade');
    hero.appendChild(fade);

    const inner = el('div', 'lib-hero-in');
    const cover = posterNode(s, 'lib-hero-cover');
    cover.removeAttribute('style');
    const coverImg = cover.querySelector('img');
    if (coverImg) coverImg.onerror = () => { coverImg.remove(); cover.style.background = gradientFor(s); };
    else cover.style.background = gradientFor(s);
    const b0 = cover.querySelector('.lib-count');
    if (b0) b0.remove();
    const p0 = cover.querySelector('.lib-progress');
    if (p0) p0.remove();

    const info = el('div', 'lib-hero-info');
    info.appendChild(el('h2', null, esc(s.title)));
    const chips = [];
    if (s.year) chips.push(s.year);
    if (s.score) chips.push('★ ' + (s.score / 10).toFixed(1));
    chips.push(s.episodes.length + ' episodes');
    (s.genres || []).forEach((g) => chips.push(g));
    const chipBox = el('div', 'chips');
    chips.forEach((c) => chipBox.appendChild(el('span', 'chip', esc(c))));
    info.appendChild(chipBox);

    const acts = el('div', 'actions');
    const resumeEp = nextEp(s) || s.episodes[0];
    const pos = getPos()[s.id + '|' + (resumeEp ? resumeEp.idx : 0)];
    const playBtn = el('button', 'btn primary',
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>' +
      (pos && pos.t > 20 ? 'Resume · ' + fmtTime(pos.t) : 'Play'));
    playBtn.type = 'button';
    playBtn.addEventListener('click', () => {
      if (resumeEp) playEpisode(s, resumeEp.idx, { resume: true });
    });
    acts.appendChild(playBtn);

    if (s.alId) {
      const a = el('a', 'btn glass', 'AniList ↗');
      a.href = 'https://anilist.co/anime/' + s.alId;
      a.target = '_blank';
      a.rel = 'noopener';
      acts.appendChild(a);
    }
    if (s.offline) {
      const r = el('button', 'btn glass', 'Reconnect files');
      r.type = 'button';
      r.addEventListener('click', async () => {
        const ok = await reconnect(true);
        if (ok) { currentSeries = seriesById(s.id) || s; renderAll(); }
        else toast('Permission nahi mila');
      });
      acts.appendChild(r);
    }
    info.appendChild(acts);

    inner.appendChild(cover);
    inner.appendChild(info);
    hero.appendChild(inner);
    head.appendChild(hero);

    /* episode list */
    const listWrap = el('div', 'lib-eplist');
    const sorted = s.episodes.slice().sort((a, b) => {
      if (a.num != null && b.num != null && a.num !== b.num) return a.num - b.num;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });

    sorted.forEach((ep, i) => {
      const p = getPos()[s.id + '|' + ep.idx];
      const pct = p && p.d ? Math.min(100, Math.round((p.t / p.d) * 100)) : 0;
      const row = el('button', 'lib-ep');
      row.type = 'button';
      row.setAttribute('aria-label', 'Play ' + ep.name);
      const numTxt = ep.num != null ? pad2(ep.num) : pad2(i + 1);
      row.innerHTML =
        '<span class="lib-epn">' + numTxt + '</span>' +
        '<span class="lib-ept"><b>' + esc(ep.num != null ? 'Episode ' + ep.num : ep.label) + '</b>' +
        '<small>' + esc(ep.label) + (ep.size ? ' · ' + fmtSize(ep.size) : '') + '</small></span>' +
        '<span class="lib-epp">' + (pct ? pct + '%' : '▶') + '</span>';
      if (pct) {
        const bar = el('span', 'lib-epbar');
        bar.style.width = pct + '%';
        row.appendChild(bar);
      }
      row.addEventListener('click', () => {
        if (s.offline) { toast('Files reconnect karo pehle'); return; }
        playEpisode(s, ep.idx, { resume: true });
      });
      listWrap.appendChild(row);
    });

    head.appendChild(el('h3', 'lib-sec-title', 'Episodes'));
    head.appendChild(listWrap);
    body.appendChild(head);
  }

  /* =========================================================
     player
     ========================================================= */
  const P = () => $('#libPlayer');
  const V = () => $('#lvVideo');
  let queue = [];       // [{series, epIdx}]
  let qi = 0;
  let hideT = null;
  let saveT = 0;
  let nextTimer = null;
  let curSubUrl = null;

  function subKey(s, idx) { return s.id + '|' + idx; }

  function srtToVtt(text) {
    let t = String(text).replace(/\r/g, '').replace(/^\uFEFF/, '');
    if (/^WEBVTT/.test(t)) return t;
    t = t.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    t = t.replace(/(\d{1,2}:\d{2}:\d{2})\.(\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2})\.(\d{3})/g,
      (m, a, b, c, d) => {
        const fix = (x) => (x.split(':')[0].length === 1 ? '0' + x : x);
        return fix(a) + '.' + b + ' --> ' + fix(c) + '.' + d;
      });
    // strip ass/ssa-ish style blocks
    t = t.replace(/\{[^}]*\}/g, '');
    return 'WEBVTT\n\n' + t.trim() + '\n';
  }

  async function attachSubs(s, epIdx) {
    const v = V();
    $$('track', v).forEach((t) => t.remove());
    if (curSubUrl) { URL.revokeObjectURL(curSubUrl); curSubUrl = null; }
    const entry = subMap.get(subKey(s, epIdx));
    const btn = $('#lvSub');
    btn.disabled = !entry;
    btn.classList.toggle('on', false);
    if (!entry) return;
    try {
      const text = await entry.file.text();
      const blob = new Blob([srtToVtt(text)], { type: 'text/vtt' });
      curSubUrl = URL.createObjectURL(blob);
      const track = el('track');
      track.kind = 'subtitles';
      track.label = 'Subtitles';
      track.srclang = 'en';
      track.src = curSubUrl;
      track.default = true;
      v.appendChild(track);
      btn.disabled = false;
      btn.dataset.ready = '1';
    } catch (e) { /* ignore */ }
  }

  function toggleSubs() {
    const v = V();
    const tracks = v.textTracks;
    if (!tracks || !tracks.length) return;
    const on = tracks[0].mode === 'showing';
    for (let i = 0; i < tracks.length; i++) tracks[i].mode = on ? 'hidden' : 'showing';
    $('#lvSub').classList.toggle('on', !on);
    pToast(on ? 'Subtitles off' : 'Subtitles on');
  }

  function playEpisode(s, idx, opts) {
    opts = opts || {};
    const eps = s.episodes.slice().sort((a, b) => {
      if (a.num != null && b.num != null && a.num !== b.num) return a.num - b.num;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    queue = eps.map((ep) => ({ series: s, epIdx: ep.idx }));
    qi = Math.max(0, queue.findIndex((q) => q.epIdx === idx));
    openPlayer();
    if (opts.resume !== false) pToast('Resuming…');
  }

  function openPlayer() {
    const p = P();
    p.hidden = false;
    document.documentElement.style.overflow = 'hidden';
    loadCurrent();
    wake();
  }

  function closePlayer() {
    const p = P();
    if (!p || p.hidden) return;
    const v = V();
    clearTimeout(nextTimer);
    $('#lvNext').hidden = true;
    saveNow();
    v.pause();
    if (v.src) { URL.revokeObjectURL(v.src); v.removeAttribute('src'); v.load(); }
    if (curSubUrl) { URL.revokeObjectURL(curSubUrl); curSubUrl = null; }
    p.hidden = true;
    document.title = 'AniVerse — anime, trailers & your list';
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (lib().hidden) document.documentElement.style.overflow = '';
  }

  let curCtx = null;

  function loadCurrent() {
    const item = queue[qi];
    if (!item) return;
    const { series: s, epIdx } = item;
    const ep = s.episodes.find((e) => e.idx === epIdx) || s.episodes[0];
    const file = fileMap.get(s.id + '|' + epIdx) || ep.file;
    if (!file) { toast('Ye file available nahi hai'); return; }

    const v = V();
    curCtx = { s: s, ep: ep, epIdx: epIdx };
    if (v.src) URL.revokeObjectURL(v.src);
    v.src = URL.createObjectURL(file);
    $('#lvName').textContent = (s.title || '') + ' · ' + (ep.num != null ? 'E' + pad2(ep.num) : ep.label);

    const pos = getPos()[s.id + '|' + epIdx] || {};
    v.onloadedmetadata = () => {
      $('#lvDur').textContent = fmtTime(v.duration);
      if (pos.t > 8 && v.duration && pos.t < v.duration - 15) {
        v.currentTime = pos.t;
        pToast('Resumed at ' + fmtTime(pos.t));
      }
      v.play().catch(() => { syncPlayIcon(); });
    };
    attachSubs(s, epIdx);
    $('#lvNext').hidden = true;
    clearTimeout(nextTimer);
    try { v.load(); } catch (e) {}
    syncPlayIcon();
    document.title = (s.title || 'AniVerse') + ' · ' + (ep.num != null ? 'E' + pad2(ep.num) : ep.label);
  }

  function playNext() {
    if (qi + 1 < queue.length) {
      qi++;
      $('#lvNext').hidden = true;
      clearTimeout(nextTimer);
      loadCurrent();
      wake();
    }
  }

  function hasNext() { return qi + 1 < queue.length; }

  /* controls */
  function togglePlay() {
    const v = V();
    if (v.paused) v.play().catch(() => {}); else v.pause();
  }
  function syncPlayIcon() {
    const v = V();
    const icon = v.paused ? '▶' : '⏸';
    $('#lvPlay').textContent = icon;
    $('#lvBig').textContent = icon;
    P().classList.toggle('playing', !v.paused);
  }
  function wake() {
    const p = P();
    p.classList.remove('idle');
    clearTimeout(hideT);
    if (!p.hidden && !V().paused) {
      hideT = setTimeout(() => p.classList.add('idle'), 2800);
    }
  }
  let pToastT = null;
  function pToast(msg) {
    const t = $('#lvToast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(pToastT);
    pToastT = setTimeout(() => t.classList.remove('show'), 1500);
  }
  function saveNow() {
    if (!curCtx) return;
    const v = V();
    savePos(curCtx.s.id, curCtx.epIdx, v.currentTime || 0, v.duration || 0);
  }

  function toggleFull() {
    const p = P();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (p.requestFullscreen) p.requestFullscreen().catch(() => {});
    else if (V().webkitEnterFullscreen) V().webkitEnterFullscreen();
  }

  function initPlayer() {
    const v = V();
    const p = P();

    v.addEventListener('play', () => { syncPlayIcon(); wake(); });
    v.addEventListener('pause', () => { syncPlayIcon(); p.classList.remove('idle'); clearTimeout(hideT); });
    v.addEventListener('timeupdate', () => {
      const d = v.duration || 0;
      const pct = d ? (v.currentTime / d) * 100 : 0;
      const seek = $('#lvSeek');
      if (!seek.matches(':active')) seek.value = String(Math.round(pct * 10));
      seek.style.setProperty('--fill', pct.toFixed(2) + '%');
      $('#lvCur').textContent = fmtTime(v.currentTime);
      if (d) $('#lvDur').textContent = fmtTime(d);
      if (Date.now() - saveT > 5000) { saveT = Date.now(); saveNow(); }
    });
    v.addEventListener('ended', () => {
      saveNow();
      syncPlayIcon();
      if (hasNext()) {
        let n = 6;
        const box = $('#lvNext');
        box.hidden = false;
        const label = $('#lvNextIn');
        const tick = () => {
          label.textContent = 'Next episode in ' + n + 's';
          if (n-- <= 0) { playNext(); }
        };
        tick();
        clearInterval(nextTimer);
        nextTimer = setInterval(() => {
          if (box.hidden) { clearInterval(nextTimer); return; }
          tick();
        }, 1000);
      } else {
        pToast('Series complete');
        $('#lvNext').hidden = true;
      }
    });
    v.addEventListener('error', () => {
      if (P().hidden || !v.src) return;
      pToast('Ye format browser me nahi chalta — MP4/WebM try karo');
    });
    v.addEventListener('click', () => { togglePlay(); wake(); });
    v.addEventListener('dblclick', toggleFull);

    $('#lvPlay').addEventListener('click', togglePlay);
    $('#lvBig').addEventListener('click', togglePlay);
    $('#lvSeek').addEventListener('input', (e) => {
      const d = v.duration || 0;
      if (d) v.currentTime = (Number(e.target.value) / 1000) * d;
    });
    $('#lvBack10').addEventListener('click', () => { v.currentTime = Math.max(0, v.currentTime - 10); pToast('−10s'); wake(); });
    $('#lvFwd10').addEventListener('click', () => { v.currentTime = Math.min(v.duration || 0, v.currentTime + 10); pToast('+10s'); wake(); });
    $('#lvMute').addEventListener('click', () => {
      v.muted = !v.muted;
      $('#lvMute').textContent = v.muted ? '🔇' : '🔊';
    });
    $('#lvVol').addEventListener('input', (e) => {
      v.volume = Number(e.target.value);
      v.muted = v.volume === 0;
      $('#lvMute').textContent = v.muted ? '🔇' : '🔊';
    });
    const SPEEDS = [1, 1.25, 1.5, 2, 0.75];
    let si = 0;
    $('#lvSpeed').addEventListener('click', () => {
      si = (si + 1) % SPEEDS.length;
      v.playbackRate = SPEEDS[si];
      $('#lvSpeed').textContent = SPEEDS[si] + '×';
      pToast('Speed ' + SPEEDS[si] + '×');
    });
    $('#lvSub').addEventListener('click', toggleSubs);
    $('#lvPip').addEventListener('click', async () => {
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await v.requestPictureInPicture();
      } catch (e) { pToast('PiP available nahi'); }
    });
    $('#lvFull').addEventListener('click', toggleFull);
    $('#lvClose').addEventListener('click', () => {
      closePlayer();
      renderAll();
    });
    $('#lvNextBtn').addEventListener('click', playNext);
    $('#lvNextCancel').addEventListener('click', () => {
      $('#lvNext').hidden = true;
      clearInterval(nextTimer);
    });

    ['mousemove', 'pointerdown', 'touchstart', 'wheel'].forEach((ev) => {
      p.addEventListener(ev, wake, { passive: true });
    });

    document.addEventListener('keydown', (e) => {
      if (P().hidden) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
      if (typing) return;
      if (e.key === 'Escape') { e.stopPropagation(); closePlayer(); return; }
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); wake(); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 10); pToast('−10s'); wake(); }
      if (e.key === 'ArrowRight') { e.preventDefault(); v.currentTime = Math.min(v.duration || 0, v.currentTime + 10); pToast('+10s'); wake(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); v.volume = Math.min(1, v.volume + 0.1); $('#lvVol').value = String(v.volume); pToast('Volume ' + Math.round(v.volume * 100) + '%'); wake(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); v.volume = Math.max(0, v.volume - 0.1); $('#lvVol').value = String(v.volume); pToast('Volume ' + Math.round(v.volume * 100) + '%'); wake(); }
      if (e.key === 'm' || e.key === 'M') { v.muted = !v.muted; $('#lvMute').textContent = v.muted ? '🔇' : '🔊'; pToast(v.muted ? 'Muted' : 'Unmuted'); wake(); }
      if (e.key === 'f' || e.key === 'F') toggleFull();
      if (e.key === 'n' || e.key === 'N') playNext();
    }, true);
  }

  /* =========================================================
     continue watching row on home
     ========================================================= */
  function continueItems() {
    const pos = getPos();
    const out = [];
    Object.keys(pos).forEach((k) => {
      const [sid, idxs] = k.split('|');
      const s = seriesById(sid);
      if (!s) return;
      const ep = s.episodes.find((e) => String(e.idx) === String(idxs));
      if (!ep) return;
      const p = pos[k];
      if (!p || !p.d || p.t < 20 || p.t > p.d - 15) return;
      out.push({ s, ep, p });
    });
    out.sort((a, b) => (b.p.at || 0) - (a.p.at || 0));
    return out.slice(0, 12);
  }

  function renderContinueRow() {
    let row = $('#libRow');
    const items = continueItems();
    if (!items.length) {
      if (row) row.remove();
      return;
    }
    const rows = $('#rows');
    if (!rows) return;
    if (!row) {
      row = el('section', 'row');
      row.id = 'libRow';
      row.dataset.kind = 'library';
      rows.prepend(row);
    }
    row.innerHTML = '';
    const head = el('div', 'row-head');
    const left = el('div', 'row-title', 'Continue watching <span class="row-sub">from your library</span>');
    head.appendChild(left);
    const link = el('button', 'row-link', 'Library →');
    link.type = 'button';
    link.addEventListener('click', () => openLibrary());
    head.appendChild(link);
    row.appendChild(head);

    const wrap = el('div', 'row-wrap');
    const scroll = el('div', 'row-scroll');
    items.forEach(({ s, ep, p }) => {
      const c = el('button', 'card lib-cont');
      c.type = 'button';
      c.setAttribute('aria-label', s.title + ' episode ' + (ep.num != null ? ep.num : ep.idx + 1));
      const poster = posterNode(s, 'poster');
      const pl = el('div', 'lib-cont-play', '<i>▶</i>');
      poster.appendChild(pl);
      c.appendChild(poster);
      c.appendChild(el('div', 'card-title', esc(s.title)));
      const pct = Math.min(100, Math.round((p.t / p.d) * 100));
      c.appendChild(el('div', 'card-meta',
        esc(ep.num != null ? 'Episode ' + ep.num : ep.label) + ' · ' + pct + '%'));
      c.addEventListener('click', () => playEpisode(s, ep.idx));
      scroll.appendChild(c);
    });
    wrap.appendChild(scroll);
    row.appendChild(wrap);
  }

  /* =========================================================
     wiring
     ========================================================= */
  function applyLibHash() {
    const h = location.hash || '#/';
    if (h.indexOf('#/library') !== 0) return;
    const id = h.split('/')[2];
    if (!id) {
      if (lib().hidden) openLibrary(true);
      else if (view !== 'grid') { view = 'grid'; currentSeries = null; renderLibrary(); }
      return;
    }
    const s = seriesById(decodeURIComponent(id));
    if (s) {
      if (lib().hidden) openLibrary(true);
      if (!currentSeries || currentSeries.id !== s.id) openSeries(s, true);
    } else if (lib().hidden) {
      openLibrary(true);
    }
  }

  function boot() {
    // pickers
    $('#libAddFolder').addEventListener('click', pickFolder);
    $('#libAddFiles').addEventListener('click', pickFiles);
    $('#libSearch').addEventListener('input', () => { view = 'grid'; renderGrid(); });
    $('#libClose').addEventListener('click', () => closeLibrary());
    $('#libDirInput').addEventListener('change', (e) => {
      handleFileList(e.target.files);
      e.target.value = '';
    });
    $('#libFileInput').addEventListener('change', (e) => {
      handleFileList(e.target.files);
      e.target.value = '';
    });

    // topbar button
    document.addEventListener('av:library', () => openLibrary());

    // hash routing for #/library and #/library/<id>
    window.addEventListener('hashchange', applyLibHash);

    initPlayer();

    // restore saved index immediately so the UI is never empty
    restoreIndexOnly();
    applyLibHash();
    reconnect(false).then(() => {
      applyLibHash();
      renderAll();
    }).catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
