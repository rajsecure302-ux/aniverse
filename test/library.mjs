/* Library smoke test: indexing, grouping, series view, player (jsdom). */
import { JSDOM, VirtualConsole } from "jsdom";

const BASE = process.env.BASE || "http://127.0.0.1:8080/";
const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errors.push("jsdom: " + (e.message || e)));
vc.on("error", (...a) => errors.push("console.error: " + a.join(" ")));

const dom = await JSDOM.fromURL(BASE, {
  runScripts: "dangerously",
  resources: "usable",
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(win) {
    win.fetch = (u, o) => fetch(u, o);
    win.URL.createObjectURL = () => "blob:fake-" + Math.random().toString(36).slice(2);
    win.URL.revokeObjectURL = () => {};
    win.HTMLMediaElement.prototype.play = function () { this._playing = true; return Promise.resolve(); };
    win.HTMLMediaElement.prototype.pause = function () { this._playing = false; };
    win.HTMLMediaElement.prototype.load = function () {};
    win.scrollTo = () => {};
    win.Element.prototype.scrollBy = function () {};
    win.Element.prototype.scrollIntoView = function () {};
  },
});

const win = dom.window;
const doc = win.document;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => doc.querySelector(s);
const $$ = (s) => [...doc.querySelectorAll(s)];

async function until(fn, label, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (fn()) return true; } catch (e) {}
    await wait(200);
  }
  throw new Error("timeout: " + label);
}

// wait for app boot
await until(() => doc.readyState === "complete", "dom ready", 20000);
await wait(400);

const names = [
  "Jujutsu Kaisen - 01 [1080p].mkv",
  "Jujutsu Kaisen - 02 [1080p].mkv",
  "Jujutsu Kaisen - 03 [1080p].mkv",
  "[SubsPlease] Frieren Beyond Journeys End - 03 (1080p) [ABCD1234].mkv",
  "One.Piece.S01E1080.1080p.mkv",
  "Naruto Episode 12 [English Sub].mp4",
  "Attack on Titan S02E05.mkv",
];
const files = names.map((n) => new win.File([new Uint8Array(2048)], n, { type: "video/x-matroska" }));
const sub = new win.File(["1\n00:00:01,000 --> 00:00:04,000\nHello\n"], "Jujutsu Kaisen - 01.srt");
files.push(sub);

const input = $("#libFileInput");
Object.defineProperty(input, "files", { value: files, configurable: true });
input.dispatchEvent(new win.Event("change", { bubbles: true }));

const out = {};
try {
  await until(() => JSON.parse(win.localStorage.getItem("av:libidx") || "[]").length >= 4, "library indexed", 20000);
  const idx = JSON.parse(win.localStorage.getItem("av:libidx"));
  out.indexed = idx.map((s) => ({ title: s.title, eps: s.episodes.length, nums: s.episodes.map((e) => e.num) }));

  // open library via topbar button
  $("#btnLocal").click();
  await until(() => !$("#library").hidden, "library opens");
  out.gridCards = $$("#libBody .lib-card").length;
  out.librarySub = $("#libSub").textContent.trim();

  // open the Jujutsu Kaisen series (has 3 episodes + a subtitle)
  const jjk = $$("#libBody .lib-card").find((c) => /Jujutsu/.test(c.textContent));
  jjk.click();
  await until(() => $$("#libBody .lib-ep").length > 0, "series view");
  out.seriesTitle = $("#libBody .lib-hero-info h2").textContent.trim();
  out.episodeRows = $$("#libBody .lib-ep").length;
  out.firstEp = $("#libBody .lib-ept b").textContent.trim();

  // play first episode
  $("#libBody .lib-ep").click();
  await until(() => !$("#libPlayer").hidden, "player opens");
  out.playerName = $("#lvName").textContent.trim();
  out.hasSeek = !!$("#lvSeek");
  out.hasSubBtn = !!$("#lvSub");
  out.subEnabled = !$("#lvSub").disabled; // srt matched to Jujutsu Kaisen - 01

  // gestures: single tap toggles controls, double-tap right/left seeks
  const v = $("#lvVideo");
  Object.defineProperty(v, "duration", { value: 1440, configurable: true });
  Object.defineProperty(v, "currentTime", { value: 600, configurable: true, writable: true });
  v.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 560, right: 1000, bottom: 560 });

  v.dispatchEvent(new win.MouseEvent("click", { bubbles: true, clientX: 500 }));
  await wait(320);
  out.tapHidesControls = $("#libPlayer").classList.contains("idle");
  v.dispatchEvent(new win.MouseEvent("click", { bubbles: true, clientX: 500 }));
  await wait(320);
  out.tapShowsControls = !$("#libPlayer").classList.contains("idle");

  v.dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true, clientX: 900 }));
  await wait(60);
  out.seekForward = v.currentTime;
  v.dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true, clientX: 60 }));
  await wait(60);
  out.seekBack = v.currentTime;
  out.seekHint = !!$(".seek-hint");

  // next episode
  out.nextQueue = true;
  v.dispatchEvent(new win.Event("ended"));
  await wait(120);
  out.nextOverlay = !$("#lvNext").hidden;
  $("#lvNextBtn").click();
  await wait(150);
  out.afterNext = $("#lvName").textContent.trim();

  // fake some watch progress, then check the continue-watching row
  Object.defineProperty(v, "duration", { value: 1440, configurable: true });
  Object.defineProperty(v, "currentTime", { value: 300, configurable: true, writable: true });
  v.dispatchEvent(new win.Event("timeupdate"));
  await wait(80);
  out.savedPos = JSON.parse(win.localStorage.getItem("av:libpos") || "{}");

  // close player
  $("#lvClose").click();
  await wait(150);
  out.playerClosed = $("#libPlayer").hidden;
  out.continueRow = !!$("#rows #libRow");
  out.continueCards = $$("#rows #libRow .card").length;

  // back to grid, then close library
  $("#libBody .lib-series-top .icon-btn").click();
  await until(() => $$("#libBody .lib-card").length > 0, "back to grid");
  out.backToGrid = true;
  $("#libClose").click();
  await wait(120);
  out.libraryClosed = $("#library").hidden;
  out.hashHome = win.location.hash;

  // detail sheet must show the matching library episodes
  win.location.hash = "#/anime/113415";
  await until(() => !$("#modal").hidden && $$("#mEps .se-ep").length >= 3, "sheet episodes", 30000);
  out.sheet = {
    head: $("#mEps .se-head").textContent.trim(),
    episodes: $$("#mEps .se-ep").length,
    resumeBtn: $("#mEps .se-top .btn").textContent.trim(),
  };
  $("#mEps .se-ep").click();
  await until(() => !$("#libPlayer").hidden, "sheet -> player");
  out.sheetPlayer = $("#lvName").textContent.trim();
  $("#lvClose").click();
  await wait(150);
  $("#modalClose").click();
  await wait(120);
  out.sheetClosed = $("#modal").hidden;

  // a title that is not in the library shows the add-files CTA
  win.location.hash = "#/anime/11061";
  await until(() => !$("#modal").hidden, "other detail");
  await wait(300);
  out.cta = {
    empty: !!$("#mEps .se-empty"),
    buttons: $$("#mEps .se-btns .btn").map((b) => b.textContent.trim()),
  };
  $("#modalClose").click();
  await wait(100);

  // filename parser check via a fresh set
  const weird = [
    new win.File([new Uint8Array(512)], "Demon Slayer Season 2 - 07.mkv"),
    new win.File([new Uint8Array(512)], "86_EIGHTY_SIX_1x03_720p.mp4"),
    new win.File([new Uint8Array(512)], "[Group] Bleach - 366 (BD 1080p) [x265].mkv"),
  ];
  Object.defineProperty(input, "files", { value: weird, configurable: true });
  input.dispatchEvent(new win.Event("change", { bubbles: true }));
  await wait(600);
  const idx2 = JSON.parse(win.localStorage.getItem("av:libidx"));
  out.parsed = idx2.filter((s) => /Demon Slayer|EIGHTY|Bleach/i.test(s.title))
    .map((s) => ({ title: s.title, season: s.season, nums: s.episodes.map((e) => e.num) }));
} catch (e) {
  out.FAILED = e.message;
}

out.consoleErrors = errors.slice(0, 6);
console.log(JSON.stringify(out, null, 1));
dom.window.close();
process.exit(out.FAILED ? 1 : 0);
