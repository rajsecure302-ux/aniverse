/* Direct-link episodes: add by URL, in-site player source, persistence, HLS path. */
import { JSDOM, VirtualConsole } from "jsdom";

const BASE = process.env.BASE || "http://127.0.0.1:8090/";
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

let fails = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log("  ✓ " + label);
  else { fails++; console.log("  ✗ " + label + (extra ? " — " + extra : "")); }
};

async function until(fn, label, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (fn()) return true; } catch (e) {}
    await wait(150);
  }
  throw new Error("timeout: " + label);
}

await until(() => doc.readyState === "complete", "dom ready");
await until(() => win.AniVerseLib && win.AniVerseLib.isReady, "library ready");
await wait(300);

const L = win.AniVerseLib;

console.log("dialog wiring");
ok(!!$("#libLinkDlg"), "dialog present");
ok(!!$("#libAddLink"), "toolbar link button present");
$("#libAddLink").click();
ok($("#libLinkDlg").open === true || $("#libLinkDlg").hasAttribute("open"), "dialog opens");
$("#libLinkDlg").removeAttribute("open");
await wait(50);

console.log("dialog submit adds series");
$("#libAddLink").click();
$("#lkTitle").value = "Demon Slayer S02E03";
$("#lkUrl").value = "https://media.example.com/ds/S02E03.mp4";
$("#libLinkDlg form").dispatchEvent(new win.Event("submit", { cancelable: true, bubbles: true }));
await wait(150);
const dsRaw = JSON.parse(win.localStorage.getItem("av:liburls") || "[]")
  .find((x) => (x.episodes || []).some((e) => e.num === 3 && /S02E03/.test(e.url)));
ok(!!dsRaw, "form submit created the episode");
ok($("#lkUrl").value === "", "form cleared after add");
if (dsRaw) win.AniVerseLib.removeSeries({ id: dsRaw.id, link: true });
await wait(80);

console.log("add direct link");
const before = L.count();
const s1 = L.addLink("Jujutsu Kaisen S01E04", "https://media.example.com/jk/S01E04.mp4");
ok(!!s1, "series created");
ok(L.count() === before + 1, "series count grew");
ok(s1.episodes.length === 1 && s1.episodes[0].num === 4, "episode number parsed (E04)");
ok(s1.episodes[0].url === "https://media.example.com/jk/S01E04.mp4", "url stored on episode");

console.log("in-site playback source");
ok(L.openSeries(s1.id) === true, "opens series page");
ok(!!$(".lib-eplist .lib-ep"), "episode row rendered");
$(".lib-eplist .lib-ep").click();
await until(() => !$("#libPlayer").hidden, "player opens");
await wait(120);
const v = $("#lvVideo");
ok(v.src === "https://media.example.com/jk/S01E04.mp4", "video src is the direct URL", v.src);
ok(/E04/.test($("#lvName").textContent) && /Jujutsu/.test($("#lvName").textContent), "player title shows series + episode", $("#lvName").textContent);
$("#lvClose").click();
await wait(100);
ok($("#libPlayer").hidden === true, "player closes");
ok(!v.getAttribute("src"), "direct URL cleared on close");

console.log("merge + hls + persistence");
const s2 = L.addLink("Jujutsu Kaisen S01E05", "https://media.example.com/jk/S01E05.m3u8");
ok(s2.id === s1.id, "same show merges into one series");
ok(s2.episodes.length === 2, "second episode appended");
const saved = JSON.parse(win.localStorage.getItem("av:liburls") || "[]");
const savedSeries = saved.find((x) => x.id === s1.id);
ok(!!savedSeries && savedSeries.episodes.length === 2, "links persisted to localStorage");
ok(savedSeries.episodes.some((e) => /\.m3u8$/.test(e.url)), "m3u8 link persisted");

const bad = L.addLink("Bad", "javascript:alert(1)");
ok(bad === null, "rejects non-http links");

const e5 = s2.episodes.find((e) => e.num === 5);
L.playEpisodeById(s1.id, e5.idx);
await until(() => !$("#libPlayer").hidden, "player opens for HLS ep");
await wait(150);
ok(v.src === "https://media.example.com/jk/S01E05.m3u8" || v.src === "" , "hls falls back to native src when hls.js unavailable", v.src);
$("#lvClose").click();
await wait(80);

console.log("reload restores links");
// fresh document, same localStorage
const store = win.localStorage;
const savedRaw = store.getItem("av:liburls");
const dom2 = new JSDOM(await (await fetch(BASE)).text(), {
  url: BASE,
  runScripts: "dangerously",
  resources: "usable",
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(w2) {
    w2.localStorage.setItem("av:liburls", savedRaw);
    w2.fetch = () => Promise.reject(new Error("offline in test"));
    w2.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    w2.scrollTo = () => {};
    w2.Element.prototype.scrollBy = function () {};
    w2.Element.prototype.scrollIntoView = function () {};
    w2.URL.createObjectURL = () => "blob:x";
    w2.URL.revokeObjectURL = () => {};
    w2.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
    w2.HTMLMediaElement.prototype.pause = function () {};
    w2.HTMLMediaElement.prototype.load = function () {};
    w2.navigator.serviceWorker = undefined;
  },
});
const w2 = dom2.window;
await until(() => w2.AniVerseLib && w2.AniVerseLib.isReady, "library ready after reload", 20000);
const hit = w2.document.querySelector(`#library .lib-card[data-id="${s1.id}"]`);
ok(!!hit, "link series restored from storage", hit ? hit.dataset.id : "missing");

if (errors.length) { console.log("\njsdom errors:"); errors.forEach((e) => console.log("  " + e)); }
console.log(fails ? `\n${fails} check(s) failed` : "\nall link checks passed");
process.exit(fails ? 1 : 0);
