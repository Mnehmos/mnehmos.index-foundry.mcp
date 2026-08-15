import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const projectRoot = resolve(
  process.argv[2] || join(repoRoot, "projects", "close-loop-dungeon-demo")
);
const port = String(19000 + (process.pid % 1000));

function startServer() {
  const env = { ...process.env, PORT: port };
  delete env.INDEXFOUNDRY_HTTP;

  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: projectRoot,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  let initialized = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        if (message.id === 1 && message.result) {
          initialized = true;
          resolveReady(message.result.serverInfo?.name || "unknown");
        }
      } catch {
        // Ignore partial/non-JSON output; MCP responses are newline-delimited.
      }
    }
  });

  child.on("error", rejectReady);
  child.on("exit", (code, signal) => {
    if (!initialized) {
      rejectReady(new Error(`server exited before initialize: code=${code} signal=${signal}`));
    }
  });

  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "stdio-transport-smoke", version: "1.0.0" },
    },
  }) + "\n");

  return { child, ready };
}

const servers = [startServer(), startServer()];

try {
  const names = await Promise.all(servers.map((server) => server.ready));

  let httpAvailable = false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(500),
    });
    httpAvailable = response.ok;
  } catch {
    // Expected: stdio-only servers must not bind the HTTP port.
  }

  if (httpAvailable) {
    throw new Error(`HTTP listener unexpectedly available on port ${port}`);
  }

  console.log(`stdio-only startup: ${names.join(", ")}`);
  console.log(`two instances initialized without binding port ${port}`);
} finally {
  for (const { child } of servers) child.kill();
}
