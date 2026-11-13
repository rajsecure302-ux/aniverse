import { JSDOM, VirtualConsole } from "jsdom";
const vc = new VirtualConsole();
vc.on("jsdomError", e => console.log("JSDOMERR:", e.message));
vc.on("error", (...a) => console.log("CONSOLE.ERR:", ...a));
const dom = await JSDOM.fromURL("http://127.0.0.1:8080/", {
  runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(win) {
    win.fetch = (u,o)=>fetch(u,o);
    win.URL.createObjectURL = () => "blob:x";
    win.URL.revokeObjectURL = () => {};
    win.HTMLMediaElement.prototype.play = function(){return Promise.resolve();};
    win.HTMLMediaElement.prototype.pause = function(){};
    win.HTMLMediaElement.prototype.load = function(){};
  },
});
const w = dom.window, d = w.document;
await new Promise(r=>setTimeout(r,3000));
console.log("inputs:", !!d.querySelector("#libFileInput"), "toasts:", !!d.querySelector("#toasts"));
const files = [new w.File([new Uint8Array(100)], "Jujutsu Kaisen - 01.mkv")];
const inp = d.querySelector("#libFileInput");
console.log("files prop before:", inp.files && inp.files.length);
Object.defineProperty(inp, "files", { value: files, configurable: true });
console.log("files prop after:", inp.files.length);
w.addEventListener("error", e => console.log("WINERR", e.message));
inp.dispatchEvent(new w.Event("change", { bubbles: true }));
await new Promise(r=>setTimeout(r,1500));
console.log("localStorage av:libidx =", w.localStorage.getItem("av:libidx"));
console.log("library hidden:", d.querySelector("#library").hidden);
console.log("body html len:", d.querySelector("#libBody").innerHTML.length);
dom.window.close();
