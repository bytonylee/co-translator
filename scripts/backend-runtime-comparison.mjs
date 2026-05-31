import { execFileSync, spawn } from "node:child_process";

const rootPort = Number(process.env.BACKEND_BENCH_PORT || 41910);
const settleMs = Number(process.env.BACKEND_BENCH_SETTLE_MS || 1000);

const cases = [
  {
    name: "go",
    argv: ["dist/backend-go/co-translator-backend"]
  },
  {
    name: "bun-smol-typescript-bundle",
    argv: ["bun", "--smol", "--no-install", "dist/backend/server.bundle.js"]
  },
  {
    name: "node-typescript-build",
    argv: ["node", "--max-old-space-size=32", "--max-semi-space-size=1", "dist/backend/server.js"]
  }
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(port, timeoutMs = 5000) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return performance.now() - startedAt;
      }
    } catch {
      // Keep polling until the backend starts.
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for backend health on port ${port}.`);
}

function rssMb(pid) {
  const output = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim();
  return Number(output) / 1024;
}

async function measure(entry, index) {
  const port = rootPort + index;
  const child = spawn(entry.argv[0], entry.argv.slice(1), {
    env: { ...process.env, CO_TRANSLATOR_BRIDGE_PORT: String(port) },
    stdio: ["ignore", "ignore", "ignore"]
  });

  try {
    const startupMs = await waitForHealth(port);
    await sleep(settleMs);
    return {
      name: entry.name,
      startupMs,
      rssMb: rssMb(child.pid),
      command: entry.argv.join(" ")
    };
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
}

async function main() {
  const results = [];
  for (let index = 0; index < cases.length; index += 1) {
    results.push(await measure(cases[index], index));
  }
  console.table(results.map((result) => ({
    runtime: result.name,
    startupMs: result.startupMs.toFixed(1),
    rssMb: result.rssMb.toFixed(2)
  })));
  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
