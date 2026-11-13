import { JSDOM, VirtualConsole } from "jsdom";
const vc = new VirtualConsole();
vc.on("jsdomError", e => console.log("ERR:", e.message));
const dom = await JSDOM.fromURL("http://127.0.0.1:8080/#/library", {
  runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(win) {
    win.fetch = (u,o)=>fetch(u,o);
    win.URL.createObjectURL = () => "blob:x"; win.URL.revokeObjectURL = () => {};
    win.HTMLMediaElement.prototype.play = function(){return Promise.resolve();};
    win.HTMLMediaElement.prototype.pause = function(){}; win.HTMLMediaElement.prototype.load = function(){};
  },
});
const d = dom.window.document;
await new Promise(r=>setTimeout(r,2500));
console.log("library hidden:", d.querySelector("#library").hidden);
console.log("title:", d.querySelector("#libTitle").textContent);
console.log("empty state:", !!d.querySelector("#libBody .lib-empty"));
console.log("buttons:", [...d.querySelectorAll("#libBody .btn")].map(b=>b.textContent.trim()));
console.log("topbar library btn:", d.querySelector("#btnLocal span").textContent);
dom.window.close();
