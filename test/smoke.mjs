/* Runtime smoke test for AniVerse using jsdom against the live AniList API. */
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
    win.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
    win.HTMLMediaElement.prototype.pause = function () {};
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

async function until(fn, label, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (fn()) return true; } catch (e) { /* keep waiting */ }
    await wait(250);
  }
  throw new Error("timeout: " + label);
}

const out = {};
try {
  // wait for rows to be filled from AniList
  await until(() => $$("#rows .card:not(.sk)").length >= 80, "rows load", 40000);
  out.rows = $$("#rows .row").map((r) => ({
    kind: r.dataset.kind,
    cards: r.querySelectorAll(".card").length,
  }));
  out.heroTitle = $("#heroTitle").textContent.trim();
  out.heroScore = $("#heroMeta").textContent.trim();
  out.heroDesc = $("#heroDesc").textContent.trim().slice(0, 70);
  out.heroImg = !!$("#heroImg").getAttribute("src");
  out.heroDots = $$("#heroDots button").length;

  // open a detail sheet from the first card
  const first = $("#rows .card:not(.sk)");
  first.click();
  await until(() => !$("#modal").hidden, "modal opens");
  out.detail = {
    title: $("#mTitle").textContent.trim(),
    chips: $$("#mChips .chip").length,
    desc: $("#mDesc").textContent.trim().slice(0, 60),
    facts: $$("#mFacts dt").length,
    hash: win.location.hash,
    crunchy: $("#mCrunchy").getAttribute("href").slice(0, 40),
  };

  // add to list
  $("#mList").click();
  await wait(150);
  out.listAfterAdd = JSON.parse(win.localStorage.getItem("av:list") || "[]").length;
  out.myRowExists = !!$('#rows .row[data-kind="list"]');
  out.listBtnLabel = $("#mList").querySelector("span").textContent;

  // close modal
  $("#modalClose").click();
  await wait(100);
  out.modalClosed = $("#modal").hidden;

  // trailer opens
  const trBtn = $("#mTrailer");
  if (trBtn && trBtn.style.display !== "none") {
    first.click();
    await until(() => !$("#modal").hidden, "modal reopen");
    $("#mTrailer").click();
    await wait(150);
    out.trailerOpen = !$("#trailer").hidden && !!$("#trailerFrame iframe");
    $("#trailerClose").click();
    $("#modalClose").click();
  }

  // browse overlay
  $('#rows .row[data-kind="trending"] .row-link').click();
  await until(() => !$("#browse").hidden && $$("#browseGrid .card:not(.sk)").length >= 20, "browse grid");
  out.browse = {
    title: $("#browseTitle").textContent.trim(),
    cards: $$("#browseGrid .card").length,
    sub: $("#browseSub").textContent.trim(),
  };
  // load more
  const before = $$("#browseGrid .card").length;
  $("#browseMore").click();
  await until(() => $$("#browseGrid .card").length > before, "load more", 30000);
  out.browseMore = $$("#browseGrid .card").length - before;

  // go home via hash, then search
  win.location.hash = "#/";
  await until(() => $("#browse").hidden, "browse closes");

  const input = $("#searchInput");
  input.value = "one piece";
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  await until(() => $$("#searchPanel .card:not(.sk)").length > 0, "search results", 30000);
  out.search = {
    results: $$("#searchPanel .card:not(.sk)").length,
    head: $("#searchPanel .sp-head").textContent.trim(),
    first: $("#searchPanel .card .card-title")?.textContent.trim(),
  };

  // player: simulate a file selection is not possible, check picker wiring only
  out.fileInput = !!$("#fileInput");
  out.footer = $(".footer").textContent.includes("AniList");
} catch (e) {
  out.FAILED = e.message;
}

out.consoleErrors = errors.slice(0, 8);
console.log(JSON.stringify(out, null, 1));
dom.window.close();
process.exit(out.FAILED ? 1 : 0);
