/* PWA checks: manifest, icons, service worker and registration wiring. */
const BASE = process.env.BASE || "http://127.0.0.1:8090/";

const get = async (path, type) => {
  const res = await fetch(new URL(path, BASE));
  const body = type === "json" ? await res.json().catch(() => null)
    : type === "text" ? await res.text() : null;
  return { status: res.status, type: res.headers.get("content-type") || "", body };
};

const out = {};
let failed = false;

try {
  const index = await get("", "text");
  out.indexStatus = index.status;
  out.manifestLink = /rel="manifest" href="manifest\.webmanifest"/.test(index.body);
  out.appleIcon = /rel="apple-touch-icon" href="icons\/icon-180\.png"/.test(index.body);
  out.installBtn = /id="btnInstall"/.test(index.body);

  const app = await get("app.js", "text");
  out.swRegister = /serviceWorker\.register\('\.\/sw\.js'\)/.test(app.body);
  out.installPrompt = /beforeinstallprompt/.test(app.body);

  const manifest = await get("manifest.webmanifest", "json");
  out.manifestStatus = manifest.status;
  out.manifestName = manifest.body && manifest.body.name;
  out.display = manifest.body && manifest.body.display;
  out.icons = (manifest.body && manifest.body.icons || []).map((i) => i.src);

  out.iconsOk = true;
  for (const src of out.icons) {
    const r = await fetch(new URL(src, BASE));
    if (r.status !== 200 || !/image\/png/.test(r.headers.get("content-type") || "")) {
      out.iconsOk = false;
      out.badIcon = src + " " + r.status;
    }
  }

  const sw = await get("sw.js", "text");
  out.swStatus = sw.status;
  out.swCache = (sw.body.match(/av-shell-v\d+/) || [])[0] || null;
  out.swShell = /index\.html/.test(sw.body) && /library\.js/.test(sw.body);
  out.swOfflineFallback = /caches\.match\('\.\/index\.html'\)/.test(sw.body);

  failed = !(
    out.indexStatus === 200 && out.manifestLink && out.appleIcon && out.installBtn &&
    out.swRegister && out.installPrompt &&
    out.manifestStatus === 200 && out.display === "standalone" &&
    out.icons.length >= 4 && out.iconsOk &&
    out.swStatus === 200 && out.swCache && out.swShell && out.swOfflineFallback
  );
} catch (e) {
  out.FAILED = e.message;
  failed = true;
}

console.log(JSON.stringify(out, null, 1));
process.exit(failed ? 1 : 0);
