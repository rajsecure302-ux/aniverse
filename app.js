/* =========================================================
   AniVerse
   Data: AniList GraphQL (public, no key) · Trailers: YouTube
   No build step. Everything runs in the browser.
   ========================================================= */
(function () {
  'use strict';

  /* ---------------- tiny helpers ---------------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const API = 'https://graphql.anilist.co';

  const FIELDS = `
    id
    title { romaji english }
    coverImage { extraLarge large color }
    bannerImage
    averageScore
    popularity
    episodes
    duration
    status
    format
    season
    seasonYear
    genres
    description(asHtml: false)
    trailer { site id }
    studios(isMain: true) { nodes { name } }
    siteUrl
  `;

  const Q = {
    trending: `query($page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){media(type:ANIME,isAdult:false,sort:TRENDING_DESC){${FIELDS}}}}`,
    top: `query($page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){media(type:ANIME,isAdult:false,sort:SCORE_DESC){${FIELDS}}}}`,
    movies: `query($page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){media(type:ANIME,isAdult:false,format:MOVIE,sort:POPULARITY_DESC){${FIELDS}}}}`,
    seasonal: `query($season:MediaSeason,$year:Int,$page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){media(type:ANIME,isAdult:false,season:$season,seasonYear:$year,sort:POPULARITY_DESC){${FIELDS}}}}`,
    search: `query($q:String,$page:Int,$perPage:Int){Page(page:$page,perPage:$perPage){media(type:ANIME,isAdult:false,search:$q,sort:SEARCH_MATCH){${FIELDS}}}}`,
    byId: `query($id:Int){Media(id:$id,type:ANIME){${FIELDS}}}`,
    stream: `query($id:Int){Media(id:$id,type:ANIME){streamingEpisodes{title thumbnail url site}}}`
  };

  /* ---------------- pretty labels ---------------- */
  const FORMATS = {
    TV: 'TV', TV_SHORT: 'TV Short', MOVIE: 'Movie', SPECIAL: 'Special',
    OVA: 'OVA', ONA: 'ONA', MUSIC: 'Music'
  };
  const STATUS = {
    FINISHED: 'Finished', RELEASING: 'Airing', NOT_YET_RELEASED: 'Upcoming',
    CANCELLED: 'Cancelled', HIATUS: 'Hiatus'
  };
  const SEASONS = { WINTER: 'Winter', SPRING: 'Spring', SUMMER: 'Summer', FALL: 'Fall' };

  function seasonNow() {
    const m = new Date().getMonth();
    if (m <= 1 || m === 11) return 'WINTER';
    if (m <= 4) return 'SPRING';
    if (m <= 7) return 'SUMMER';
    return 'FALL';
  }
  function seasonLabel() {
    const s = seasonNow();
    const y = new Date().getFullYear();
    if (s === 'WINTER') return 'Winter ' + y;
    return SEASONS[s] + ' ' + y;
  }

  const titleOf = (m) => (m && (m.title.english || m.title.romaji)) || 'Untitled';
  const coverOf = (m) => (m && m.coverImage && (m.coverImage.extraLarge || m.coverImage.large)) || '';
  const bannerOf = (m) => (m && (m.bannerImage || coverOf(m))) || '';
  const scoreOf = (m) => (m && m.averageScore ? m.averageScore : null);
  const stripHtml = (html) => {
    if (!html) return '';
    const d = document.createElement('div');
    d.innerHTML = String(html).replace(/<br\s*\/?>/gi, '\n');
    return d.textContent.replace(/\n{3,}/g, '\n\n').trim();
  };
  function metaLine(m) {
    const bits = [];
    if (m.format) bits.push(FORMATS[m.format] || m.format);
    if (m.seasonYear) bits.push(m.seasonYear);
    if (m.episodes) bits.push(m.episodes + ' ep');
    else if (m.duration) bits.push(m.duration + ' min');
    return bits.join(' · ') || 'Anime';
  }

  /* ---------------- fetch + cache ---------------- */
  const TTL = 45 * 60 * 1000;
  const CACHE_MAX = 70;
  let pending = 0;
  let lastReq = 0;

  function hashKey(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return 'k' + (h >>> 0);
  }
  function readCache(key) {
    try {
      const raw = localStorage.getItem('av:c:' + key);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || Date.now() - o.t > TTL) { localStorage.removeItem('av:c:' + key); return null; }
      return o.d;
    } catch (e) { return null; }
  }
  function writeCache(key, data) {
    try {
      const keys = Object.keys(localStorage).filter((k) => k.indexOf('av:c:') === 0);
      if (keys.length > CACHE_MAX) {
        keys.sort((a, b) => {
          const ta = (JSON.parse(localStorage.getItem(a) || '{}').t) || 0;
          const tb = (JSON.parse(localStorage.getItem(b) || '{}').t) || 0;
          return ta - tb;
        });
        keys.slice(0, keys.length - CACHE_MAX).forEach((k) => localStorage.removeItem(k));
      }
      localStorage.setItem('av:c:' + key, JSON.stringify({ t: Date.now(), d: data }));
    } catch (e) { /* quota — ignore */ }
  }

  function loadStart() {
    pending++;
    $('#loadbar').classList.add('on');
  }
  function loadEnd() {
    pending = Math.max(0, pending - 1);
    if (!pending) $('#loadbar').classList.remove('on');
  }

  async function gql(query, vars) {
    const key = hashKey(query + JSON.stringify(vars || {}));
    const cached = readCache(key);
    if (cached) return cached;

    const gap = 750 - (Date.now() - lastReq);
    if (gap > 0) await sleep(gap);
    lastReq = Date.now();

    loadStart();
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, variables: vars || {} })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (json.errors && json.errors.length) throw new Error(json.errors[0].message || 'API error');
      writeCache(key, json.data);
      return json.data;
    } finally {
      loadEnd();
    }
  }

  function remember(list) {
    (list || []).forEach((m) => { if (m && m.id) store.set(m.id, m); });
    return list || [];
  }

  /* ---------------- state ---------------- */
  const store = new Map();
  let heroList = [];
  let heroIdx = 0;
  let heroTimer = null;
  let currentDetail = null;
  let searchTimer = null;
  let searchSeq = 0;
  let browseState = null;

  /* ---------------- row data ---------------- */
  const KINDS = {
    trending: { title: 'Trending now', sub: 'What everyone is watching', load: (p) => gql(Q.trending, { page: p, perPage: 24 }) },
    seasonal: { title: 'This season', sub: seasonLabel(), load: (p) => gql(Q.seasonal, { season: seasonNow(), year: new Date().getFullYear(), page: p, perPage: 24 }) },
    top: { title: 'Top rated of all time', sub: 'Highest scores on AniList', load: (p) => gql(Q.top, { page: p, perPage: 24 }) },
    movies: { title: 'Anime movies', sub: 'Feature films', load: (p) => gql(Q.movies, { page: p, perPage: 24 }) }
  };

  async function loadKind(kind, page) {
    const k = KINDS[kind];
    if (!k) return [];
    const data = await k.load(page || 1);
    return remember((data && data.Page && data.Page.media) || []);
  }

  /* ---------------- toast ---------------- */
  function toast(msg, ms) {
    const t = el('div', 'toast');
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => {
      t.style.transition = 'opacity .25s, transform .25s';
      t.style.opacity = '0';
      t.style.transform = 'translateY(8px)';
      setTimeout(() => t.remove(), 260);
    }, ms || 2400);
  }

  /* ---------------- card ---------------- */
  function card(m) {
    const b = el('button', 'card');
    b.type = 'button';
    b.setAttribute('aria-label', titleOf(m));

    const poster = el('div', 'poster');
    if (m.coverImage && m.coverImage.color) poster.style.background = m.coverImage.color;
    const s = scoreOf(m);
    if (s) poster.appendChild(el('span', 'score', String(s)));

    const img = el('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.onload = () => img.classList.add('loaded');
    img.onerror = () => { img.remove(); };
    const src = coverOf(m);
    if (src) img.src = src;
    poster.appendChild(img);
    poster.appendChild(el('div', 'card-play', '<i>▶</i>'));
    b.appendChild(poster);

    const t = el('div', 'card-title');
    t.textContent = titleOf(m);
    b.appendChild(t);

    const mm = el('div', 'card-meta');
    mm.textContent = metaLine(m);
    b.appendChild(mm);

    b.addEventListener('click', () => openDetail(m));
    return b;
  }

  function skeletonCards(n) {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const c = el('div', 'card sk', '<div class="poster"></div><div class="b1"></div><div class="b2"></div>');
      frag.appendChild(c);
    }
    return frag;
  }

  /* ---------------- hero ---------------- */
  function renderHero() {
    const m = heroList[heroIdx];
    if (!m) { $('#hero').dataset.empty = '1'; return; }
    $('#hero').dataset.empty = '0';

    const img = $('#heroImg');
    const src = bannerOf(m);
    img.style.transition = 'opacity .45s';
    if (img.getAttribute('src') !== src) {
      img.style.opacity = '0';
      img.onload = () => { img.style.opacity = '1'; };
      img.onerror = () => { img.style.opacity = '1'; };
      img.src = src;
    } else {
      img.style.opacity = '1';
    }

    $('#heroBadge').textContent = 'Trending #' + (heroIdx + 1);
    $('#heroTitle').textContent = titleOf(m);

    const meta = [];
    const s = scoreOf(m);
    if (s) meta.push('<span class="pill score">★ ' + (s / 10).toFixed(1) + '</span>');
    if (m.seasonYear) meta.push('<span class="pill">' + m.seasonYear + '</span>');
    if (m.episodes) meta.push('<span class="pill">' + m.episodes + ' episodes</span>');
    if (m.format) meta.push('<span class="tag">' + esc(FORMATS[m.format] || m.format) + '</span>');
    if (m.status) meta.push('<span class="tag">' + esc(STATUS[m.status] || m.status) + '</span>');
    $('#heroMeta').innerHTML = meta.join('<span class="sep"></span>');

    const desc = stripHtml(m.description);
    $('#heroDesc').textContent = desc.length > 260 ? desc.slice(0, 260).replace(/\s+\S*$/, '') + '…' : desc;

    syncListButtons();
    renderDots();
  }

  function renderDots() {
    const box = $('#heroDots');
    box.innerHTML = '';
    heroList.slice(0, 6).forEach((m, i) => {
      const b = el('button');
      b.type = 'button';
      b.setAttribute('aria-label', 'Featured ' + (i + 1));
      if (i === heroIdx) b.className = 'on';
      b.addEventListener('click', () => { heroIdx = i; renderHero(); restartHeroTimer(); });
      box.appendChild(b);
    });
  }

  function restartHeroTimer() {
    clearInterval(heroTimer);
    heroTimer = setInterval(() => {
      if (!heroList.length) return;
      heroIdx = (heroIdx + 1) % Math.min(heroList.length, 6);
      renderHero();
    }, 9000);
  }

  /* ---------------- rows ---------------- */
  function rowHead(title, sub, viewAll) {
    const head = el('div', 'row-head');
    const left = el('div', 'row-title');
    left.innerHTML = esc(title) + (sub ? ' <span class="row-sub">' + esc(sub) + '</span>' : '');
    head.appendChild(left);
    if (viewAll) {
      const link = el('button', 'row-link', 'View all →');
      link.type = 'button';
      link.addEventListener('click', viewAll);
      head.appendChild(link);
    }
    return head;
  }

  function buildRow(kind) {
    const k = KINDS[kind];
    const row = el('section', 'row');
    row.dataset.kind = kind;
    row.appendChild(rowHead(k.title, k.sub, () => openBrowse(kind)));

    const wrap = el('div', 'row-wrap');
    const scroll = el('div', 'row-scroll');
    scroll.appendChild(skeletonCards(7));
    wrap.appendChild(scroll);

    const left = el('button', 'row-nav left', '‹');
    const right = el('button', 'row-nav right', '›');
    left.type = right.type = 'button';
    left.setAttribute('aria-label', 'Scroll left');
    right.setAttribute('aria-label', 'Scroll right');
    left.addEventListener('click', () => scroll.scrollBy({ left: -scroll.clientWidth * 0.8, behavior: 'smooth' }));
    right.addEventListener('click', () => scroll.scrollBy({ left: scroll.clientWidth * 0.8, behavior: 'smooth' }));
    wrap.appendChild(left);
    wrap.appendChild(right);

    row.appendChild(wrap);
    $('#rows').appendChild(row);

    loadKind(kind, 1).then((items) => {
      scroll.innerHTML = '';
      if (!items.length) { scroll.appendChild(el('div', 'sp-empty', 'Nothing here yet.')); return; }
      const frag = document.createDocumentFragment();
      items.forEach((m) => frag.appendChild(card(m)));
      scroll.appendChild(frag);
      if (kind === 'trending') {
        heroList = items.slice(0, 6);
        heroIdx = 0;
        renderHero();
        restartHeroTimer();
      }
    }).catch((err) => {
      scroll.innerHTML = '';
      const box = el('div', 'sp-empty');
      box.innerHTML = 'Could not load this row. ';
      const retry = el('button', 'row-link', 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', () => { row.remove(); buildRow(kind); });
      box.appendChild(retry);
      scroll.appendChild(box);
      console.warn('[AniVerse] row failed:', kind, err);
    });
  }

  function renderHome() {
    $('#rows').innerHTML = '';
    myRow = null;
    renderMyRow();
    ['trending', 'seasonal', 'top', 'movies'].forEach(buildRow);
  }

  /* ---------------- my list ---------------- */
  const LIST_KEY = 'av:list';
  let myRow = null;

  function getList() {
    try { return JSON.parse(localStorage.getItem(LIST_KEY)) || []; } catch (e) { return []; }
  }
  function saveList(list) {
    try { localStorage.setItem(LIST_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
  }
  function slim(m) {
    return {
      id: m.id, title: m.title, coverImage: m.coverImage, bannerImage: m.bannerImage,
      averageScore: m.averageScore, episodes: m.episodes, format: m.format,
      seasonYear: m.seasonYear, status: m.status, description: m.description,
      trailer: m.trailer, genres: (m.genres || []).slice(0, 4), siteUrl: m.siteUrl,
      duration: m.duration, season: m.season, studios: m.studios, popularity: m.popularity
    };
  }
  const inList = (id) => getList().some((x) => x.id === id);

  function toggleList(m) {
    let list = getList();
    if (list.some((x) => x.id === m.id)) {
      list = list.filter((x) => x.id !== m.id);
      toast('Removed from My list');
    } else {
      list.unshift(slim(m));
      toast('Added to My list');
    }
    saveList(list);
    renderMyRow();
    syncListButtons();
  }

  function syncListButtons() {
    const m = heroList[heroIdx];
    const hb = $('#heroList');
    if (hb) {
      const on = m && inList(m.id);
      hb.querySelector('span').textContent = on ? 'In my list' : 'My list';
      hb.classList.toggle('primary', !!on);
      hb.classList.toggle('glass', !on);
    }
    const mb = $('#mList');
    if (mb && currentDetail) {
      const on = inList(currentDetail.id);
      mb.querySelector('span').textContent = on ? '✓ In my list' : '+ My list';
    }
  }

  function renderMyRow() {
    const list = getList();
    if (!list.length) {
      if (myRow) { myRow.remove(); myRow = null; }
      return;
    }
    if (!myRow) {
      myRow = el('section', 'row');
      myRow.dataset.kind = 'list';
      $('#rows').prepend(myRow);
    }
    myRow.innerHTML = '';
    myRow.appendChild(rowHead('My list', list.length + ' saved', () => openBrowse('list')));

    const wrap = el('div', 'row-wrap');
    const scroll = el('div', 'row-scroll');
    list.forEach((m) => { store.set(m.id, m); scroll.appendChild(card(m)); });
    wrap.appendChild(scroll);
    myRow.appendChild(wrap);
  }

  /* ---------------- detail modal ---------------- */
  function factsFor(m) {
    const rows = [];
    if (m.format) rows.push(['Format', FORMATS[m.format] || m.format]);
    if (m.episodes) rows.push(['Episodes', m.episodes]);
    if (m.duration) rows.push(['Duration', m.duration + ' min']);
    if (m.status) rows.push(['Status', STATUS[m.status] || m.status]);
    if (m.season && m.seasonYear) rows.push(['Season', SEASONS[m.season] + ' ' + m.seasonYear]);
    else if (m.seasonYear) rows.push(['Year', m.seasonYear]);
    const studio = m.studios && m.studios.nodes && m.studios.nodes[0];
    if (studio && studio.name) rows.push(['Studio', studio.name]);
    if (m.popularity) rows.push(['Popularity', m.popularity.toLocaleString()]);
    return rows.map((r) => '<div><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>').join('');
  }

  function openDetail(m, skipHash) {
    if (!m) return;
    remember([m]);
    currentDetail = m;

    const banner = $('#mBanner');
    banner.src = bannerOf(m);
    banner.onerror = () => { banner.style.display = 'none'; };
    banner.style.display = '';

    const cover = $('#mCover');
    cover.src = coverOf(m);
    cover.onerror = () => { cover.style.display = 'none'; };
    cover.style.display = '';

    $('#mTitle').textContent = titleOf(m);

    const chips = [];
    const s = scoreOf(m);
    if (s) chips.push('<span class="chip gold">★ ' + (s / 10).toFixed(1) + '</span>');
    if (m.format) chips.push('<span class="chip acc">' + esc(FORMATS[m.format] || m.format) + '</span>');
    if (m.seasonYear) chips.push('<span class="chip">' + m.seasonYear + '</span>');
    (m.genres || []).slice(0, 5).forEach((g) => chips.push('<span class="chip">' + esc(g) + '</span>'));
    $('#mChips').innerHTML = chips.join('');

    $('#mDesc').textContent = stripHtml(m.description) || 'No synopsis available yet.';
    $('#mFacts').innerHTML = factsFor(m);
    renderSheetEpisodes(m);
    loadStreamingEpisodes(m);

    const cr = $('#mCrunchy');
    cr.href = 'https://www.crunchyroll.com/search?q=' + encodeURIComponent(titleOf(m));
    $('#mFree').href = 'https://www.justwatch.com/in/search?q=' + encodeURIComponent(titleOf(m));
    $('#mAniList').href = m.siteUrl || ('https://anilist.co/anime/' + m.id);

    const trBtn = $('#mTrailer');
    trBtn.style.display = (m.trailer && m.trailer.site === 'youtube' && m.trailer.id) ? '' : 'none';

    hideSearch();
    syncListButtons();
    $('#modal').hidden = false;
    $('#modal').scrollTop = 0;
    $('.sheet', $('#modal')).scrollTop = 0;
    syncScrollLock();

    if (!skipHash) setHash('#/anime/' + m.id);
    $('#modalClose').focus({ preventScroll: true });
  }

  /* ---------------- episodes inside the detail sheet ---------------- */
  const pad2 = (n) => String(n).padStart(2, '0');

  /* Legal per-episode links come from AniList's streamingEpisodes field.
     They open the official platform (Crunchyroll etc.) — AniVerse never
     hosts or proxies the video itself. */
  function loadStreamingEpisodes(m) {
    if (!m || m._streamLoading || (m.streamingEpisodes && m.streamingEpisodes.length)) return;
    m._streamLoading = true;
    gql(Q.stream, { id: m.id }).then((d) => {
      const list = (d && d.Media && d.Media.streamingEpisodes) || [];
      m.streamingEpisodes = list;
      m._streamLoading = false;
      if (currentDetail === m && !$('#modal').hidden) renderSheetEpisodes(m);
    }).catch(() => { m._streamLoading = false; });
  }

  function epNumber(title, i) {
    const m = String(title || '').match(/(?:episode|ep\.?|#)\s*(\d{1,4})/i);
    return m ? Number(m[1]) : i + 1;
  }

  function legalEpisodesBlock(list) {
    const wrap = el('div', 'se-legal-wrap');
    const note = el('p', 'se-legal-note',
      'Yeh official platform pe khulenge — playback wahan hoga, AniVerse stream host nahi karta.');
    wrap.appendChild(note);
    const rows = el('div', 'se-list se-legal-list');
    list.slice(0, 40).forEach((x, i) => {
      const a = el('a', 'se-ep se-legal');
      a.href = x.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      const n = epNumber(x.title, i);
      a.innerHTML =
        '<span class="se-n">' + pad2(n) + '</span>' +
        '<span class="se-t">' + esc(x.title || ('Episode ' + n)) + '</span>' +
        '<span class="se-p se-site">' + esc(x.site || 'Watch') + ' ↗</span>';
      rows.appendChild(a);
    });
    wrap.appendChild(rows);
    if (list.length > 40) {
      const a = el('a', 'se-more', '+' + (list.length - 40) + ' more on ' + (list[0].site || 'the platform') + ' ↗');
      a.href = list[0].url || '#';
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      wrap.appendChild(a);
    }
    return wrap;
  }

  function renderSheetEpisodes(m) {
    const box = $('#mEps');
    if (!box) return;
    box.innerHTML = '';
    const L = window.AniVerseLib;
    if (!L) return;

    const s = L.matchFor(m);
    const legal = (m.streamingEpisodes || []).filter((x) => x && x.url);
    const head = el('div', 'se-head');
    head.appendChild(el('h3', null, 'Episodes'));
    head.appendChild(el('span', 'se-sub',
      s ? s.episodes.length + ' episodes in your library'
        : legal.length ? legal.length + ' official episodes · ' + (legal[0].site || 'legal stream')
        : (m._streamLoading ? 'loading official links…' : 'not in your library yet')));
    box.appendChild(head);

    if (!s) {
      if (legal.length) box.appendChild(legalEpisodesBlock(legal));
      const empty = el('div', 'se-empty');
      empty.innerHTML =
        '<b>' + (legal.length ? 'Site ke andar play karne ke liye apni file chahiye' : 'Yahan se episode chalane ke liye files chahiye') + '</b>' +
        '<p>' + (legal.length
          ? 'Upar wale links official platform pe kholenge. AniVerse ke player me chalane ke liye apne episodes ka folder chuno — ' +
            'phir isi card se direct play hoga, subtitles + resume + auto-next ke saath.'
          : 'AniVerse koi stream host nahi karta. Apne episodes ka folder chuno — phir isi card se direct play hoga, ' +
            'subtitles + resume + auto-next ke saath.') + '</p>';
      const btns = el('div', 'se-btns');
      const b1 = el('button', 'btn small primary', '📁 Folder chuno');
      b1.type = 'button';
      b1.addEventListener('click', () => L.pickFolder());
      const b2 = el('button', 'btn small glass', '🎬 Files chuno');
      b2.type = 'button';
      b2.addEventListener('click', () => L.pickFiles());
      const b3 = el('button', 'btn small ghost', 'Library kholo');
      b3.type = 'button';
      b3.addEventListener('click', () => { closeDetail(true); L.open(); });
      btns.appendChild(b1);
      btns.appendChild(b2);
      btns.appendChild(b3);
      empty.appendChild(btns);
      box.appendChild(empty);
      return;
    }

    const eps = s.episodes.slice().sort((a, b) => {
      if (a.num != null && b.num != null && a.num !== b.num) return a.num - b.num;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });

    // resume target
    let resume = null;
    for (const ep of eps) {
      const p = L.progressFor(s.id, ep.idx);
      if (!p || !p.d || p.t < p.d * 0.92) { resume = ep; break; }
    }
    const pos = L.progressFor(s.id, (resume || eps[0]).idx);

    const top = el('div', 'se-top');
    const play = el('button', 'btn small primary',
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>' +
      (pos && pos.t > 20 ? 'Resume · ' + fmtTimeSpring(pos.t) : 'Play'));
    play.type = 'button';
    play.addEventListener('click', () => L.playEpisodeById(s.id, (resume || eps[0]).idx));
    top.appendChild(play);

    const open = el('button', 'btn small glass', 'Series page →');
    open.type = 'button';
    open.addEventListener('click', () => { closeDetail(true); L.openSeries(s.id); });
    top.appendChild(open);
    box.appendChild(top);

    const list = el('div', 'se-list');
    eps.slice(0, 40).forEach((ep, i) => {
      const p = L.progressFor(s.id, ep.idx);
      const pct = p && p.d ? Math.min(100, Math.round((p.t / p.d) * 100)) : 0;
      const row = el('button', 'se-ep');
      row.type = 'button';
      row.innerHTML =
        '<span class="se-n">' + pad2(ep.num != null ? ep.num : i + 1) + '</span>' +
        '<span class="se-t">' + esc(ep.num != null ? 'Episode ' + ep.num : ep.label) + '</span>' +
        '<span class="se-p">' + (pct ? pct + '%' : '▶') + '</span>';
      if (pct) {
        const bar = el('span', 'se-bar');
        bar.style.width = pct + '%';
        row.appendChild(bar);
      }
      row.addEventListener('click', () => L.playEpisodeById(s.id, ep.idx));
      list.appendChild(row);
    });
    box.appendChild(list);

    if (eps.length > 40) {
      box.appendChild(el('p', 'se-more', '+' + (eps.length - 40) + ' more on the series page'));
    }
  }

  function fmtTimeSpring(t) {
    t = Math.max(0, Math.floor(t || 0));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  }

  function closeDetail(fromHash) {
    if ($('#modal').hidden) return;
    $('#modal').hidden = true;
    currentDetail = null;
    syncScrollLock();
    if (!fromHash && location.hash.indexOf('#/anime/') === 0) {
      if (browseState) setHash(browseState.kind === 'list' ? '#/mylist' : '#/browse/' + browseState.kind, true);
      else setHash('#/', true);
    }
  }

  /* ---------------- trailer ---------------- */
  function openTrailer(m) {
    if (!m || !m.trailer || m.trailer.site !== 'youtube' || !m.trailer.id) {
      toast('No trailer available for this title');
      return;
    }
    $('#trailerFrame').innerHTML =
      '<iframe src="https://www.youtube.com/embed/' + encodeURIComponent(m.trailer.id) +
      '?autoplay=1&rel=0&modestbranding=1&playsinline=1" allow="autoplay; encrypted-media; picture-in-picture" ' +
      'allowfullscreen title="Trailer"></iframe>';
    $('#trailer').hidden = false;
    syncScrollLock();
  }
  function closeTrailer() {
    $('#trailer').hidden = true;
    $('#trailerFrame').innerHTML = '';
    syncScrollLock();
  }

  /* ---------------- browse ---------------- */
  async function openBrowse(kind, skipHash) {
    browseState = { kind: kind, page: 0, loading: false, items: [], title: '', sub: '' };
    $('#browseGrid').innerHTML = '';
    $('#browseGrid').appendChild(skeletonsGrid(12));
    $('#browse').hidden = false;
    $('#browse').scrollTop = 0;
    syncScrollLock();

    if (kind === 'list') {
      const list = getList();
      browseState.title = 'My list';
      browseState.sub = list.length + ' saved';
      $('#browseTitle').textContent = 'My list';
      $('#browseSub').textContent = browseState.sub;
      $('#browseGrid').innerHTML = '';
      if (!list.length) {
        $('#browseGrid').appendChild(el('div', 'empty', 'Your list is empty. Add something with “+ My list”.'));
        $('#browseMore').hidden = true;
        return;
      }
      list.forEach((m) => { store.set(m.id, m); $('#browseGrid').appendChild(card(m)); });
      $('#browseMore').hidden = true;
      if (!skipHash) setHash('#/mylist');
      return;
    }

    const k = KINDS[kind];
    browseState.title = k.title;
    browseState.sub = 'AniList · sorted by popularity/score';
    $('#browseTitle').textContent = k.title;
    $('#browseSub').textContent = k.sub || '';
    $('#browseMore').hidden = false;

    await browseMore();
    if (!skipHash) setHash('#/browse/' + kind);
  }

  function skeletonsGrid(n) {
    const wrap = el('div', 'grid');
    for (let i = 0; i < n; i++) wrap.appendChild(el('div', 'card sk', '<div class="poster"></div><div class="b1"></div><div class="b2"></div>'));
    return wrap;
  }

  async function browseMore() {
    if (!browseState || browseState.loading) return;
    if (browseState.kind === 'list') return;
    browseState.loading = true;
    $('#browseMore').disabled = true;
    $('#browseMore').textContent = 'Loading…';

    if (browseState.page === 0) $('#browseGrid').innerHTML = '';

    try {
      const items = await loadKind(browseState.kind, browseState.page + 1);
      browseState.page++;
      browseState.items = browseState.items.concat(items);
      const frag = document.createDocumentFragment();
      items.forEach((m) => frag.appendChild(card(m)));
      $('#browseGrid').appendChild(frag);
      if (!browseState.items.length) {
        $('#browseGrid').appendChild(el('div', 'empty', 'Nothing found.'));
      }
      $('#browseMore').hidden = items.length < 20;
    } catch (e) {
      toast('Could not load more — check your connection');
      $('#browseGrid').appendChild(el('div', 'empty', 'Load failed. Try again.'));
    } finally {
      browseState.loading = false;
      $('#browseMore').disabled = false;
      $('#browseMore').textContent = 'Load more';
    }
  }

  function closeBrowse(fromHash) {
    $('#browse').hidden = true;
    browseState = null;
    syncScrollLock();
    if (!fromHash && location.hash.indexOf('#/browse') === 0) setHash('#/', true);
    if (!fromHash && location.hash === '#/mylist') setHash('#/', true);
  }

  /* ---------------- search ---------------- */
  const searchInput = $('#searchInput');
  const searchPanel = $('#searchPanel');

  function runSearch(q) {
    const seq = ++searchSeq;
    searchPanel.hidden = false;
    searchPanel.innerHTML = '<div class="sp-head"><h3>Searching for “' + esc(q) + '”</h3></div>';
    const grid = el('div', 'grid');
    grid.appendChild(skeletonCards(8));
    searchPanel.appendChild(grid);

    gql(Q.search, { q: q, page: 1, perPage: 24 }).then((data) => {
      if (seq !== searchSeq) return;
      const items = remember((data && data.Page && data.Page.media) || []);
      searchPanel.innerHTML = '<div class="sp-head"><h3>' +
        (items.length ? items.length + ' results' : 'No results') + ' for “' + esc(q) + '”</h3></div>';
      if (!items.length) {
        searchPanel.appendChild(el('div', 'sp-empty', 'Try another spelling, or a romaji / English title.'));
        return;
      }
      const g = el('div', 'grid');
      items.forEach((m) => g.appendChild(card(m)));
      searchPanel.appendChild(g);
    }).catch(() => {
      if (seq !== searchSeq) return;
      searchPanel.innerHTML = '<div class="sp-empty">Search failed. Check the connection and try again.</div>';
    });
  }

  function hideSearch() {
    searchPanel.hidden = true;
    searchPanel.innerHTML = '';
    $('#searchClear').hidden = !searchInput.value;
  }

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    $('#searchClear').hidden = !q;
    clearTimeout(searchTimer);
    if (!q) { hideSearch(); return; }
    searchTimer = setTimeout(() => runSearch(q), 320);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = $('.card', searchPanel);
      if (first) { first.click(); hideSearch(); }
    }
    if (e.key === 'Escape') { searchInput.blur(); hideSearch(); }
  });

  $('#searchClear').addEventListener('click', () => {
    searchInput.value = '';
    $('#searchClear').hidden = true;
    hideSearch();
    searchInput.focus();
  });

  document.addEventListener('click', (e) => {
    if (!searchPanel.hidden && !searchPanel.contains(e.target) && !e.target.closest('.search')) {
      hideSearch();
    }
  });

  /* ---------------- scroll lock ---------------- */
  function syncScrollLock() {
    const anyOpen = !$('#modal').hidden || !$('#browse').hidden || !$('#trailer').hidden || !$('#player').hidden;
    document.body.style.overflow = anyOpen ? 'hidden' : '';
  }

  /* ---------------- hash routing ---------------- */
  function setHash(h, replace) {
    if (location.hash === h) return;
    if (replace) history.replaceState(null, '', h);
    else location.hash = h;
  }

  function navActive(which) {
    $$('.nav-link').forEach((a) => a.classList.toggle('active', a.dataset.nav === which));
  }

  async function applyHash() {
    const h = location.hash || '#/';

    if (h.indexOf('#/anime/') === 0) {
      const id = parseInt(h.split('/')[2], 10);
      if (!id) return;
      if (currentDetail && currentDetail.id === id && !$('#modal').hidden) return;
      let m = store.get(id);
      if (!m) {
        try {
          const data = await gql(Q.byId, { id: id });
          m = data && data.Media;
          if (m) remember([m]);
        } catch (e) { toast('Could not open that title'); }
      }
      if (m) openDetail(m, true);
      return;
    }

    if (h === '#/mylist') {
      navActive('list');
      if (!browseState || browseState.kind !== 'list' || $('#browse').hidden) openBrowse('list', true);
      return;
    }

    if (h.indexOf('#/browse/') === 0) {
      const kind = h.split('/')[2];
      if (KINDS[kind]) {
        navActive(kind === 'top' ? 'top' : kind === 'movies' ? 'movies' : 'home');
        if (!browseState || browseState.kind !== kind || $('#browse').hidden) openBrowse(kind, true);
      }
      return;
    }

    // home
    navActive('home');
    closeDetail(true);
    closeBrowse(true);
    $('#browse').hidden = true;
    browseState = null;
    syncScrollLock();
  }

  document.addEventListener('av:library-changed', () => {
    if (currentDetail && !$('#modal').hidden) renderSheetEpisodes(currentDetail);
  });

  window.addEventListener('hashchange', () => applyHash().catch(() => {}));

  /* ---------------- hero buttons ---------------- */
  $('#heroTrailer').addEventListener('click', () => openTrailer(heroList[heroIdx]));
  $('#heroMore').addEventListener('click', () => openDetail(heroList[heroIdx]));
  $('#heroList').addEventListener('click', () => {
    const m = heroList[heroIdx];
    if (m) toggleList(m);
  });

  /* ---------------- modal buttons ---------------- */
  $('#modalClose').addEventListener('click', () => closeDetail());
  $('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeDetail(); });
  $('#mTrailer').addEventListener('click', () => openTrailer(currentDetail));
  $('#mList').addEventListener('click', () => { if (currentDetail) toggleList(currentDetail); });

  /* ---------------- browse buttons ---------------- */
  $('#browseBack').addEventListener('click', () => {
    if (location.hash.indexOf('#/browse') === 0 || location.hash === '#/mylist') setHash('#/', true);
    else if (history.length > 1) history.back();
    else closeBrowse();
  });
  $('#browseMore').addEventListener('click', browseMore);

  /* ---------------- trailer ---------------- */
  $('#trailerClose').addEventListener('click', closeTrailer);
  $('#trailer').addEventListener('click', (e) => { if (e.target === $('#trailer')) closeTrailer(); });

  /* ---------------- random ---------------- */
  $('#btnRandom').addEventListener('click', async () => {
    try {
      const page = 1 + Math.floor(Math.random() * 8);
      const items = await loadKind('top', page);
      if (!items.length) throw new Error('empty');
      openDetail(items[Math.floor(Math.random() * items.length)]);
    } catch (e) { toast('Could not pick a random title'); }
  });

  /* =========================================================
     LOCAL PLAYER
     ========================================================= */
  const video = $('#video');
  const player = $('#player');
  let playlist = [];
  let plIndex = 0;
  let hideTimer = null;
  let lastSave = 0;

  const POS_KEY = 'av:pos';
  const readPos = () => { try { return JSON.parse(localStorage.getItem(POS_KEY)) || {}; } catch (e) { return {}; } };
  const fileKey = (f) => f.name + ':' + f.size;
  function savePos(t, d) {
    try {
      const all = readPos();
      const k = playlist[plIndex] ? fileKey(playlist[plIndex]) : null;
      if (!k) return;
      if (d && t > d - 12) delete all[k]; else all[k] = { t: t, d: d };
      localStorage.setItem(POS_KEY, JSON.stringify(all));
    } catch (e) { /* ignore */ }
  }

  function fmtTime(s) {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  }

  let pToastTimer = null;
  function pToast(msg) {
    const t = $('#pToast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(pToastTimer);
    pToastTimer = setTimeout(() => t.classList.remove('show'), 1400);
  }

  function loadFile(i) {
    if (!playlist.length) return;
    plIndex = clamp(i, 0, playlist.length - 1);
    const f = playlist[plIndex];
    if (video.src) URL.revokeObjectURL(video.src);
    video.src = URL.createObjectURL(f);
    $('#pName').textContent = f.name;
    $('#pPlay').textContent = '⏸';
    $('#pBig').textContent = '⏸';
    player.classList.add('playing');

    video.onloadedmetadata = () => {
      $('#pDur').textContent = fmtTime(video.duration);
      const saved = readPos()[fileKey(f)];
      if (saved && saved.t > 8 && video.duration && saved.t < video.duration - 10) {
        video.currentTime = saved.t;
        pToast('Resumed at ' + fmtTime(saved.t));
      }
      video.play().catch(() => {});
    };
  }

  function openPlayer(files) {
    playlist = files.slice();
    if (!playlist.length) return;
    player.hidden = false;
    player.classList.add('playing');
    syncScrollLock();
    loadFile(0);
    wake();
  }

  function closePlayer() {
    if (player.hidden) return;
    savePos(video.currentTime, video.duration);
    video.pause();
    if (video.src) { URL.revokeObjectURL(video.src); video.removeAttribute('src'); video.load(); }
    player.hidden = true;
    playlist = [];
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    syncScrollLock();
  }

  function togglePlay() {
    if (video.paused) video.play().catch(() => {}); else video.pause();
  }
  function syncPlayIcon() {
    const icon = video.paused ? '▶' : '⏸';
    $('#pPlay').textContent = icon;
    $('#pBig').textContent = icon;
    player.classList.toggle('playing', !video.paused);
  }

  function wake() {
    player.classList.remove('idle');
    clearTimeout(hideTimer);
    if (!player.hidden && !video.paused) {
      hideTimer = setTimeout(() => player.classList.add('idle'), 2800);
    }
  }

  video.addEventListener('play', () => { syncPlayIcon(); wake(); });
  video.addEventListener('pause', () => { syncPlayIcon(); player.classList.remove('idle'); clearTimeout(hideTimer); });
  video.addEventListener('timeupdate', () => {
    const d = video.duration || 0;
    const pct = d ? (video.currentTime / d) * 100 : 0;
    const seek = $('#pSeek');
    if (!seek.matches(':active')) seek.value = String(Math.round(pct * 10));
    seek.style.setProperty('--fill', pct.toFixed(2) + '%');
    $('#pCur').textContent = fmtTime(video.currentTime);
    if (d) $('#pDur').textContent = fmtTime(d);
    if (Date.now() - lastSave > 5000) { lastSave = Date.now(); savePos(video.currentTime, d); }
  });
  video.addEventListener('ended', () => {
    savePos(video.duration, video.duration);
    if (plIndex + 1 < playlist.length) { loadFile(plIndex + 1); }
    else { player.classList.remove('playing'); pToast('Finished'); }
  });
  video.addEventListener('error', () => { if (!player.hidden && video.src) pToast('This file could not be played'); });

  $('#pPlay').addEventListener('click', togglePlay);
  $('#pBig').addEventListener('click', togglePlay);
  video.addEventListener('click', () => { togglePlay(); wake(); });
  video.addEventListener('dblclick', () => toggleFull());

  $('#pSeek').addEventListener('input', (e) => {
    const d = video.duration || 0;
    if (d) video.currentTime = (Number(e.target.value) / 1000) * d;
  });

  $('#pBack').addEventListener('click', () => { video.currentTime = Math.max(0, video.currentTime - 10); pToast('−10s'); wake(); });
  $('#pFwd').addEventListener('click', () => { video.currentTime = Math.min(video.duration || 0, video.currentTime + 10); pToast('+10s'); wake(); });

  $('#pMute').addEventListener('click', () => {
    video.muted = !video.muted;
    $('#pMute').textContent = video.muted ? '🔇' : '🔊';
  });
  $('#pVol').addEventListener('input', (e) => {
    video.volume = Number(e.target.value);
    video.muted = video.volume === 0;
    $('#pMute').textContent = video.muted ? '🔇' : '🔊';
  });

  const SPEEDS = [1, 1.25, 1.5, 2, 0.75];
  let speedIdx = 0;
  $('#pSpeed').addEventListener('click', () => {
    speedIdx = (speedIdx + 1) % SPEEDS.length;
    video.playbackRate = SPEEDS[speedIdx];
    $('#pSpeed').textContent = SPEEDS[speedIdx] + '×';
    pToast('Speed ' + SPEEDS[speedIdx] + '×');
  });

  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (player.requestFullscreen) player.requestFullscreen().catch(() => {});
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
  }
  $('#pFull').addEventListener('click', toggleFull);
  $('#pClose').addEventListener('click', closePlayer);

  ['mousemove', 'pointerdown', 'touchstart', 'wheel'].forEach((ev) => {
    player.addEventListener(ev, wake, { passive: true });
  });

  /* ---------------- file picker ---------------- */
  $('#btnLocal').addEventListener('click', () => document.dispatchEvent(new CustomEvent('av:library')));
  if ($('#fileInput')) $('#fileInput').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) openPlayer(files);
    e.target.value = '';
  });

  /* ---------------- keyboard ---------------- */
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);

    if (e.key === '/' && !typing && $('#player').hidden) {
      e.preventDefault();
      searchInput.focus();
      return;
    }
    if (e.key === 'Escape') {
      if (!$('#player').hidden) { closePlayer(); return; }
      if (!$('#trailer').hidden) { closeTrailer(); return; }
      if (!$('#modal').hidden) { closeDetail(); return; }
      if (!$('#browse').hidden) { closeBrowse(); return; }
      if (!searchPanel.hidden) { hideSearch(); searchInput.blur(); return; }
      return;
    }
    if ($('#player').hidden) return;

    if (e.code === 'Space') { e.preventDefault(); togglePlay(); wake(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 10); pToast('−10s'); wake(); }
    if (e.key === 'ArrowRight') { e.preventDefault(); video.currentTime = Math.min(video.duration || 0, video.currentTime + 10); pToast('+10s'); wake(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); video.volume = clamp(video.volume + 0.1, 0, 1); $('#pVol').value = String(video.volume); pToast('Volume ' + Math.round(video.volume * 100) + '%'); wake(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); video.volume = clamp(video.volume - 0.1, 0, 1); $('#pVol').value = String(video.volume); pToast('Volume ' + Math.round(video.volume * 100) + '%'); wake(); }
    if (e.key === 'm' || e.key === 'M') { video.muted = !video.muted; $('#pMute').textContent = video.muted ? '🔇' : '🔊'; pToast(video.muted ? 'Muted' : 'Unmuted'); wake(); }
    if (e.key === 'f' || e.key === 'F') toggleFull();
  });

  /* ---------------- network status ---------------- */
  window.addEventListener('offline', () => toast('Offline — showing cached data only', 3200));

  /* ---------------- PWA: install + offline shell ---------------- */
  let deferredPrompt = null;
  const btnInstall = $('#btnInstall');

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (btnInstall) btnInstall.hidden = false;
  });

  if (btnInstall) {
    btnInstall.addEventListener('click', async () => {
      if (!deferredPrompt) {
        toast('Browser menu → “Add to Home screen” se install karo', 4200);
        return;
      }
      deferredPrompt.prompt();
      try {
        const choice = await deferredPrompt.userChoice;
        if (choice && choice.outcome === 'accepted') toast('AniVerse install ho gaya 🎉', 3000);
      } catch (e) {}
      deferredPrompt = null;
      btnInstall.hidden = true;
    });
  }

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    if (btnInstall) btnInstall.hidden = true;
    toast('AniVerse install ho gaya 🎉', 3000);
  });

  if ('serviceWorker' in navigator) {
    const secure = location.protocol === 'https:' ||
      location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (secure) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
      });
    }
  }

  /* ---------------- boot ---------------- */
  function boot() {
    navActive('home');
    renderHome();
    applyHash().catch(() => {});
    if (!navigator.onLine) toast('You are offline — cached data only');
  }

  boot();
})();
