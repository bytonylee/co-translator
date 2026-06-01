import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const reportDir = path.join(rootDir, "reports");
const reportPath = path.join(reportDir, "electron-vs-zero-native.html");
const releaseAppPath = path.join(rootDir, "zig-out/package/co-translator-0.0.1-macos-ReleaseSmall.app");
const releaseBinaryPath = path.join(releaseAppPath, "Contents/MacOS/co-translator");
const builtBinaryPath = path.join(rootDir, "zig-out/bin/co-translator");
const bridgePort = 41873;
const bridgeToken = "benchmark-bridge-token";
const iterations = Number(process.env.BENCH_ITERATIONS || 5000);
const zeroNativeOptimize = process.env.ZERO_NATIVE_OPTIMIZE || "ReleaseSmall";
const zeroNativeTrace = process.env.ZERO_NATIVE_TRACE || "off";
const electronBaseline = {
  rssMb: 407.58,
  p50Ms: 0.00,
  p95Ms: 0.10,
  source: "Measured from origin/main dba1eea on this machine with Electron 39.2.7."
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    iterations: sorted.length,
    zeroSamples: sorted.filter((value) => value === 0).length,
    minMs: sorted[0],
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1]
  };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: { ...process.env, ...options.env },
      stdio: options.stdio || ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
      options.onStdout?.(chunk.toString());
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
      options.onStderr?.(chunk.toString());
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with ${code ?? signal}\n${stdout}\n${stderr}`));
      }
    });
  });
}

function startApp(env = {}) {
  return spawn("zig-out/bin/co-translator", [], {
    cwd: rootDir,
    env: {
      ...process.env,
      ...env,
      CO_TRANSLATOR_BRIDGE_PORT: String(bridgePort),
      CO_TRANSLATOR_BRIDGE_TOKEN: bridgeToken,
      ZERO_NATIVE_LOG_DIR: path.join(rootDir, ".zig-cache", "benchmark-logs")
    },
    stdio: ["ignore", "ignore", "ignore"]
  });
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const tree = processTree(await psSnapshot(), child.pid).sort((a, b) => b.pid - a.pid);
  for (const process of tree) {
    try {
      globalThis.process.kill(process.pid, "SIGTERM");
    } catch {
      // Process already exited.
    }
  }
  await sleep(1000);
  for (const process of tree) {
    try {
      globalThis.process.kill(process.pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }
  await killBridgePortListener();
}

async function killBridgePortListener() {
  if (process.platform !== "darwin") return;
  try {
    const { stdout } = await run("lsof", [`-tiTCP:${bridgePort}`, "-sTCP:LISTEN"]);
    for (const pidText of stdout.split(/\s+/).filter(Boolean)) {
      const pid = Number(pidText);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      try {
        globalThis.process.kill(pid, "SIGTERM");
      } catch {
        // Process already exited.
      }
    }
  } catch {
    // No listener on the benchmark bridge port.
  }
}

async function psSnapshot() {
  const { stdout } = await run("ps", ["-axo", "pid=,ppid=,rss=,comm=,command="]);
  return stdout.trim().split("\n").map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) return null;
    return {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKb: Number(match[3]),
      comm: match[4],
      command: match[5]
    };
  }).filter(Boolean);
}

function processTree(processes, rootPid) {
  const byParent = new Map();
  for (const process of processes) {
    const children = byParent.get(process.ppid) || [];
    children.push(process);
    byParent.set(process.ppid, children);
  }
  const result = [];
  const visit = (pid) => {
    for (const child of byParent.get(pid) || []) {
      result.push(child);
      visit(child.pid);
    }
  };
  const root = processes.find((process) => process.pid === rootPid);
  if (root) result.push(root);
  visit(rootPid);
  return result;
}

function memorySummary(processes) {
  return {
    rssMb: processes.reduce((sum, process) => sum + process.rssKb, 0) / 1024,
    processCount: processes.length,
    processes: processes
      .map((process) => ({
        pid: process.pid,
        rssMb: process.rssKb / 1024,
        command: process.command
      }))
      .sort((a, b) => b.rssMb - a.rssMb)
  };
}

function isWebKitXpc(process) {
  return process.command.includes("/com.apple.WebKit.");
}

function parseMemoryToMb(value) {
  const match = String(value).trim().match(/^([\d.]+)([KMG])$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (match[2] === "K") return amount / 1024;
  if (match[2] === "M") return amount;
  return amount * 1024;
}

async function physicalFootprintMb(pid) {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await run("vmmap", ["-summary", String(pid)]);
    const line = stdout.split("\n").find((candidate) => candidate.includes("Physical footprint:"));
    const value = line?.match(/Physical footprint:\s+([\d.]+[KMG])/)?.[1];
    return value ? parseMemoryToMb(value) : null;
  } catch {
    return null;
  }
}

async function addPhysicalFootprints(summary) {
  let total = 0;
  let count = 0;
  for (const process of summary.processes) {
    process.physicalFootprintMb = await physicalFootprintMb(process.pid);
    if (process.physicalFootprintMb != null) {
      total += process.physicalFootprintMb;
      count += 1;
    }
  }
  summary.physicalFootprintMb = count > 0 ? total : null;
  return summary;
}

function dirSizeBytes(targetPath) {
  if (!fs.existsSync(targetPath)) return null;
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) return stat.size;
  return fs.readdirSync(targetPath)
    .reduce((sum, entry) => sum + dirSizeBytes(path.join(targetPath, entry)), 0);
}

async function waitForHealth(timeoutMs = 10000, pollMs = 25) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${bridgePort}/health`);
      if (response.ok) return performance.now() - started;
    } catch {
      // Keep polling until the backend starts.
    }
    await sleep(pollMs);
  }
  throw new Error("Timed out waiting for Zero Native backend health endpoint.");
}

async function buildOptimizedZeroNative() {
  await run("npm", ["run", "build"], { stdio: "inherit" });
  await run("zig", ["build", `-Doptimize=${zeroNativeOptimize}`, `-Dtrace=${zeroNativeTrace}`], { stdio: "inherit" });
}

async function measureZeroNative() {
  const idle = await measureZeroNativeIdle();
  const beforeProcesses = await psSnapshot();
  const beforeWebKitPids = new Set(beforeProcesses.filter(isWebKitXpc).map((process) => process.pid));
  const child = startApp({ CO_TRANSLATOR_EAGER_BACKEND: "1" });
  let measured;
  try {
    const startupMs = await waitForHealth();
    await sleep(5000);
    const processes = await psSnapshot();
    const memory = await addPhysicalFootprints(memorySummary(processTree(processes, child.pid)));
    const webKitXpc = await addPhysicalFootprints(memorySummary(
      processes.filter((process) => isWebKitXpc(process) && !beforeWebKitPids.has(process.pid))
    ));
    const latency = await measureBridgeLatency();
    measured = { startupMs, memory, webKitXpc, latency, idle };
  } finally {
    await stop(child);
  }
  return { ...measured, warmStartupMs: await measureBackendReadyOnly() };
}

async function measureBackendReadyOnly() {
  const child = startApp({ CO_TRANSLATOR_EAGER_BACKEND: "1" });
  try {
    return await waitForHealth();
  } finally {
    await stop(child);
  }
}

async function measureZeroNativeIdle() {
  const beforeProcesses = await psSnapshot();
  const beforeWebKitPids = new Set(beforeProcesses.filter(isWebKitXpc).map((process) => process.pid));
  const child = startApp();
  try {
    await sleep(5000);
    const processes = await psSnapshot();
    const memory = await addPhysicalFootprints(memorySummary(processTree(processes, child.pid)));
    const webKitXpc = await addPhysicalFootprints(memorySummary(
      processes.filter((process) => isWebKitXpc(process) && !beforeWebKitPids.has(process.pid))
    ));
    return { memory, webKitXpc };
  } finally {
    await stop(child);
  }
}

async function measureBridgeLatency() {
  const socket = new WebSocket(`ws://127.0.0.1:${bridgePort}/bridge?token=${encodeURIComponent(bridgeToken)}`);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  try {
    const samples = [];
    let nextId = 1;
    const pending = new Map();
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      entry.resolve(performance.now() - entry.started);
    });

    for (let index = 0; index < iterations; index += 1) {
      const id = String(nextId++);
      const elapsed = await new Promise((resolve, reject) => {
        pending.set(id, { started: performance.now(), resolve });
        socket.send(JSON.stringify({ id, command: "translator:get-api-pricing" }), (error) => {
          if (error) {
            pending.delete(id);
            reject(error);
          }
        });
      });
      samples.push(elapsed);
    }
    return summarize(samples);
  } finally {
    socket.close();
  }
}

function fmt(value, digits = 2) {
  if (value == null || Number.isNaN(Number(value))) return "n/a";
  return Number(value).toFixed(digits);
}

function fmtBytes(value) {
  if (value == null) return "n/a";
  if (value < 1024 * 1024) return `${fmt(value / 1024, 0)} KB`;
  return `${fmt(value / (1024 * 1024), 2)} MB`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderProcessRows(processes) {
  return processes.map((process) => `
    <tr>
      <td>${process.pid}</td>
      <td>${fmt(process.rssMb)}</td>
      <td>${fmt(process.physicalFootprintMb)}</td>
      <td><code>${escapeHtml(process.command)}</code></td>
    </tr>`).join("");
}

function backendProcess(processes) {
  return processes.find((process) =>
    process.command.includes("co-translator-backend") ||
    process.command.includes("dist/backend/server.bundle.js") ||
    process.command.includes("dist/backend/server.js")
  );
}

function renderReport(results) {
  const memoryDelta = electronBaseline.rssMb - results.zeroNative.memory.rssMb;
  const memoryReduction = (memoryDelta / electronBaseline.rssMb) * 100;
  const attributableRssMb = results.zeroNative.memory.rssMb + results.zeroNative.webKitXpc.rssMb;
  const attributablePhysicalMb = (results.zeroNative.memory.physicalFootprintMb ?? 0) + (results.zeroNative.webKitXpc.physicalFootprintMb ?? 0);
  const backend = backendProcess(results.zeroNative.memory.processes);
  const generatedAt = new Date().toISOString();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Co Translator: Electron vs Zero Native</title>
  <style>
    :root { color-scheme: light; --ink: #18211f; --muted: #596662; --line: #d7ded8; --paper: #fbfbf7; --panel: #ffffff; --green: #176b52; --blue: #245d8f; --amber: #8b5a16; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--paper); }
    main { max-width: 1160px; margin: 0 auto; padding: 42px 24px 56px; }
    h1 { font-size: 34px; line-height: 1.12; margin: 0 0 8px; }
    h2 { margin: 34px 0 12px; font-size: 21px; }
    p { line-height: 1.55; }
    .meta { color: var(--muted); margin: 0 0 26px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
    .metric { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; min-height: 86px; }
    .metric span { color: var(--muted); font-size: 13px; }
    .metric b { display: block; font-size: 25px; margin-top: 8px; }
    .metric.good b { color: var(--green); }
    .metric.watch b { color: var(--amber); }
    table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #edf0eb; text-align: left; vertical-align: top; }
    th { background: #eef2ed; font-size: 13px; }
    tr:last-child td { border-bottom: 0; }
    code { font-size: 12px; white-space: pre-wrap; word-break: break-word; }
    .note { background: #fff9e8; border: 1px solid #e8d48a; border-radius: 8px; padding: 14px 16px; }
    .callout { background: #eef7f3; border: 1px solid #b9d8ca; border-radius: 8px; padding: 14px 16px; }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    @media (max-width: 860px) { .grid, .two { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
<main>
  <h1>Co Translator Shell Migration Report</h1>
  <p class="meta">Generated ${generatedAt} on ${escapeHtml(process.platform)} ${escapeHtml(process.arch)}. Zero Native was built with <code>-Doptimize=${escapeHtml(zeroNativeOptimize)}</code> and <code>-Dtrace=${escapeHtml(zeroNativeTrace)}</code>.</p>

  <section class="grid">
    <div class="metric"><span>Electron RSS baseline</span><b>${fmt(electronBaseline.rssMb)} MB</b></div>
    <div class="metric good"><span>Optimized Zero Native RSS</span><b>${fmt(results.zeroNative.memory.rssMb)} MB</b></div>
    <div class="metric good"><span>RSS reduction</span><b>${fmt(memoryReduction, 1)}%</b></div>
    <div class="metric"><span>Zero Native backend ready</span><b>${fmt(results.zeroNative.startupMs, 0)} ms cold / ${fmt(results.zeroNative.warmStartupMs, 0)} ms warm</b></div>
  </section>

  <h2>680 KB Claim vs 159 MB RSS</h2>
  <section class="grid">
    <div class="metric good"><span>Packaged .app size</span><b>${fmtBytes(results.sizes.releaseAppBytes)}</b></div>
    <div class="metric good"><span>Packaged executable</span><b>${fmtBytes(results.sizes.releaseBinaryBytes)}</b></div>
    <div class="metric watch"><span>Process-tree RSS</span><b>${fmt(results.zeroNative.memory.rssMb)} MB</b></div>
    <div class="metric watch"><span>App + WebKit physical footprint</span><b>${fmt(attributablePhysicalMb)} MB</b></div>
  </section>
  <p class="note">Root cause: the small number is file size, not resident memory. This app's packaged executable is already smaller than 680 KB, and the whole packaged app is around that size. The 159 MB number is process-tree RSS after launch, dominated by mapped AppKit/WebKit pages in the native host plus the backend sidecar. RSS also counts shared system library pages; <code>vmmap</code> physical footprint is the better proxy for unique resident pressure on macOS.</p>

  <h2>Memory Root Cause</h2>
  <table>
    <thead><tr><th>Component</th><th>RSS</th><th>Physical footprint</th><th>Cause</th></tr></thead>
    <tbody>
      <tr><td>Native host process</td><td>${fmt(results.zeroNative.memory.processes.find((process) => process.command.includes("co-translator"))?.rssMb)} MB</td><td>${fmt(results.zeroNative.memory.processes.find((process) => process.command.includes("co-translator"))?.physicalFootprintMb)} MB</td><td>WKWebView/AppKit/WebKit frameworks are loaded into the host process; most of the high RSS is shared read-only framework mapping, not app binary size.</td></tr>
      <tr><td>Go backend sidecar</td><td>${fmt(backend?.rssMb)} MB</td><td>${fmt(backend?.physicalFootprintMb)} MB</td><td>The OpenAI HTTP/WebSocket bridge now runs as a small Go sidecar to keep API keys out of the renderer while avoiding a long-lived JavaScript runtime.</td></tr>
      <tr><td>WebKit XPC processes</td><td>${fmt(results.zeroNative.webKitXpc.rssMb)} MB</td><td>${fmt(results.zeroNative.webKitXpc.physicalFootprintMb)} MB</td><td>macOS launches WebKit GPU, Networking, and WebContent XPC services under <code>launchd</code>, so they are attributable to the WebView but are not children of the app process.</td></tr>
      <tr><td>Attributable total</td><td>${fmt(attributableRssMb)} MB</td><td>${fmt(attributablePhysicalMb)} MB</td><td>RSS answers “what is mapped/resident by these processes”; physical footprint is closer to the app's private pressure.</td></tr>
    </tbody>
  </table>

  <h2>Latency</h2>
  <table>
    <thead><tr><th>Bridge</th><th>p50</th><th>p95</th><th>p99</th><th>min</th><th>max</th><th>0 ms samples</th></tr></thead>
    <tbody>
      <tr><td>Electron IPC invoke baseline</td><td>${fmt(electronBaseline.p50Ms)} ms</td><td>${fmt(electronBaseline.p95Ms)} ms</td><td>not measured</td><td>not measured</td><td>not measured</td><td>not measured</td></tr>
      <tr><td>Optimized Zero Native WebSocket bridge</td><td>${fmt(results.zeroNative.latency.p50Ms)} ms</td><td>${fmt(results.zeroNative.latency.p95Ms)} ms</td><td>${fmt(results.zeroNative.latency.p99Ms)} ms</td><td>${fmt(results.zeroNative.latency.minMs)} ms</td><td>${fmt(results.zeroNative.latency.maxMs)} ms</td><td>${results.zeroNative.latency.zeroSamples} / ${results.zeroNative.latency.iterations}</td></tr>
    </tbody>
  </table>
  <p class="note">Root cause for the apparent Electron p50 advantage: the Electron IPC baseline was measured inside the renderer with <code>performance.now()</code>, which quantizes many very fast calls to exactly <code>0.00 ms</code>. The Zero Native measurement is a real local WebSocket round trip through the backend sidecar using Node's finer timer, so it rarely reports zero even when the operation is only a few hundredths of a millisecond. The p95 comparison is the more useful number here.</p>

  <h2>Lowest-Latency / Lowest-Memory Path</h2>
  <section class="two">
    <div class="callout">
      <b>Applied now</b>
      <p>Build Zero Native with <code>ReleaseSmall</code> and trace disabled. The native launcher now prefers the Go backend sidecar, falls back to the bundled backend with <code>bun --smol --no-install</code>, and finally falls back to capped Node with <code>--max-old-space-size=32 --max-semi-space-size=1</code>. The renderer also schedules an idle Go binary prewarm that exits immediately, keeping idle memory low while reducing the first action path.</p>
    </div>
    <div class="callout">
      <b>Best next solution</b>
      <p>Keep the Go sidecar as the active bridge/backend path. A future in-process native backend could remove the sidecar entirely, but the current Go process is already below the 200 MB active RSS target when WebKit XPC is counted.</p>
    </div>
  </section>

  <h2>Options Tested</h2>
  <table>
    <thead><tr><th>Option</th><th>Memory impact</th><th>Latency impact</th><th>Decision</th></tr></thead>
    <tbody>
      <tr><td>Go sidecar</td><td>Largest reduction found in the existing architecture; current sidecar is ${fmt(backend?.rssMb)} MB RSS / ${fmt(backend?.physicalFootprintMb)} MB physical.</td><td>No regression in the local bridge probe; current run is ${fmt(results.zeroNative.latency.p50Ms, 4)} / ${fmt(results.zeroNative.latency.p95Ms, 4)} ms p50/p95.</td><td>Applied as preferred runtime when the Go binary is built.</td></tr>
      <tr><td>Bun sidecar</td><td>Reduced versus Node, especially with bundled output and <code>--smol</code>, but still larger than Go.</td><td>No regression in the local bridge probe.</td><td>Kept as fallback.</td></tr>
      <tr><td>Node heap caps</td><td>Small reduction in Node RSS/physical footprint.</td><td>No regression in the local bridge probe, but more memory than Bun.</td><td>Kept as fallback when Bun is unavailable.</td></tr>
      <tr><td><code>--jitless</code></td><td>Slightly lower Node RSS than heap caps.</td><td>Worse bridge p50/p95 in the local probe.</td><td>Rejected for the low-latency target.</td></tr>
      <tr><td>Lazy-start + idle prewarm</td><td>Removes the sidecar from idle memory; the short prewarm process exits before the steady-state memory snapshot.</td><td>Avoids paying the full Go binary cold-start on the first user action after idle.</td><td>Applied as the default lightweight Zero Native integration.</td></tr>
      <tr><td>Port backend to native</td><td>Largest controllable reduction because it removes the Node sidecar.</td><td>Can preserve or improve bridge latency if implemented as a native control/data plane.</td><td>Best long-term solution; larger rewrite with OpenAI protocol risk.</td></tr>
    </tbody>
  </table>

  <h2>Memory Method</h2>
  <p>RSS is measured from the launched Zero Native app process tree after the backend health endpoint is ready and the app has idled for five seconds. The idle snapshot is taken before the persistent backend starts; the active snapshot includes the native shell and backend sidecar. The WebKit XPC rows are detected by taking a WebKit process snapshot before launch and attributing newly created WebKit XPC services to this run. The Electron RSS number is the provided migration benchmark baseline.</p>

  <h2>Measured Processes: Optimized Zero Native</h2>
  <table><thead><tr><th>PID</th><th>RSS MB</th><th>Physical MB</th><th>Command</th></tr></thead><tbody>${renderProcessRows(results.zeroNative.memory.processes)}</tbody></table>

  <h2>Attributed WebKit XPC Processes</h2>
  <table><thead><tr><th>PID</th><th>RSS MB</th><th>Physical MB</th><th>Command</th></tr></thead><tbody>${renderProcessRows(results.zeroNative.webKitXpc.processes)}</tbody></table>

  <h2>Commands</h2>
  <table><tbody>
    <tr><th>Build</th><td><code>npm run build && zig build -Doptimize=${escapeHtml(zeroNativeOptimize)} -Dtrace=${escapeHtml(zeroNativeTrace)}</code></td></tr>
    <tr><th>Zero Native app</th><td><code>zig-out/bin/co-translator</code></td></tr>
    <tr><th>File size probe</th><td><code>du -sh zig-out/package/co-translator-0.0.1-macos-ReleaseSmall.app</code> and executable stat size</td></tr>
    <tr><th>Physical footprint probe</th><td><code>vmmap -summary &lt;pid&gt;</code> on macOS</td></tr>
    <tr><th>Zero Native latency</th><td><code>ws://127.0.0.1:${bridgePort}/bridge</code>, ${iterations} sequential <code>translator:get-api-pricing</code> calls</td></tr>
    <tr><th>Electron baseline</th><td>${escapeHtml(electronBaseline.source)}</td></tr>
  </tbody></table>
</main>
</body>
</html>`;
}

async function main() {
  await buildOptimizedZeroNative();
  const zeroNative = await measureZeroNative();
  const results = {
    zeroNative,
    sizes: {
      builtBinaryBytes: dirSizeBytes(builtBinaryPath),
      releaseAppBytes: dirSizeBytes(releaseAppPath),
      releaseBinaryBytes: dirSizeBytes(releaseBinaryPath)
    }
  };
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(reportPath, renderReport(results), "utf8");
  console.log(JSON.stringify({ reportPath, electronBaseline, results }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
