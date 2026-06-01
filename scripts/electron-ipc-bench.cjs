const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const iterations = Number(process.env.BENCH_ITERATIONS || 1000);
const preloadPath = path.join(os.tmpdir(), `co-translator-electron-ipc-preload-${process.pid}.cjs`);

fs.writeFileSync(
  preloadPath,
  `
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("bench", {
  ping(value) {
    return ipcRenderer.invoke("bench:ping", value);
  },
  done(result) {
    ipcRenderer.send("bench:done", result);
  }
});
`,
  "utf8"
);

ipcMain.handle("bench:ping", (_event, value) => value);
ipcMain.once("bench:done", (_event, result) => {
  console.log(JSON.stringify(result));
  fs.rmSync(preloadPath, { force: true });
  app.quit();
});

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const html = `
<!doctype html>
<script>
(async () => {
  const samples = [];
  for (let index = 0; index < ${iterations}; index += 1) {
    const started = performance.now();
    await window.bench.ping(index);
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const at = (p) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];
  window.bench.done({
    iterations: samples.length,
    p50Ms: at(0.50),
    p95Ms: at(0.95),
    p99Ms: at(0.99),
    minMs: samples[0],
    maxMs: samples[samples.length - 1]
  });
})();
</script>`;

  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
});
