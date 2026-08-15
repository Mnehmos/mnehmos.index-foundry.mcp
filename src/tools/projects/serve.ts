/**
 * Local development server lifecycle for exported projects.
 *
 * Starts, stops and reports on the generated server process, tracking it both
 * in memory and via a .server.pid file so status survives a restart of this
 * MCP server.
 *
 * Copyright (c) 2024 vario.automation
 * Proprietary and confidential. All rights reserved.
 */

import path from "path";
import type { ChildProcess } from "child_process";

import {
  ProjectServeInput,
  ProjectServeStopInput,
  ProjectServeStatusInput,
} from "../../schemas-projects.js";
import {
  pathExists,
  readJson,
  writeJson,
  createToolError,
} from "../../utils.js";
import { runCommand, spawnDetached, openInBrowser } from "../../process-utils.js";
import type { ToolError } from "../../types.js";
import { SERVER_PID_FILE, getProjectPaths, getProjectsBaseDir } from "./config.js";

// ============================================================================
// Server Process Tracking
// ============================================================================

interface RunningServer {
  projectId: string;
  process: ChildProcess;
  pid: number;
  port: number;
  mode: "dev" | "build";
  startTime: Date;
  endpoint: string;
}

/** Map of project_id -> running server info */
const runningServers = new Map<string, RunningServer>();

export interface ProjectServeResult {
  success: true;
  project_id: string;
  endpoint: string;
  pid: number;
  port: number;
  mode: "dev" | "build";
  message: string;
}

export interface ProjectServeStopResult {
  success: true;
  project_id: string;
  pid: number;
  uptime_seconds: number;
  message: string;
}

export interface ProjectServeStatusResult {
  success: true;
  servers: Array<{
    project_id: string;
    endpoint: string;
    pid: number;
    port: number;
    mode: "dev" | "build";
    uptime_seconds: number;
    status: "running" | "unknown";
  }>;
  total: number;
}

/**
 * Check if a process is still running
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write server PID file for persistence
 */
async function writeServerPidFile(projectId: string, data: { pid: number; port: number; mode: string; startTime: string }): Promise<void> {
  const paths = getProjectPaths(projectId);
  const pidFilePath = path.join(paths.root, SERVER_PID_FILE);
  const { writeFile: write } = await import("fs/promises");
  await write(pidFilePath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Read server PID file
 */
async function readServerPidFile(projectId: string): Promise<{ pid: number; port: number; mode: string; startTime: string } | null> {
  const paths = getProjectPaths(projectId);
  const pidFilePath = path.join(paths.root, SERVER_PID_FILE);
  try {
    if (!(await pathExists(pidFilePath))) return null;
    const content = await readJson<{ pid: number; port: number; mode: string; startTime: string }>(pidFilePath);
    if (!content || !Number.isInteger(content.pid) || !Number.isInteger(content.port)) return null;
    return content;
  } catch {
    return null;
  }
}

/**
 * Delete server PID file
 */
async function deleteServerPidFile(projectId: string): Promise<void> {
  const paths = getProjectPaths(projectId);
  const pidFilePath = path.join(paths.root, SERVER_PID_FILE);
  try {
    const { unlink } = await import("fs/promises");
    await unlink(pidFilePath);
  } catch {
    // Ignore if file doesn't exist
  }
}

/**
 * Poll health endpoint until server is ready
 */
async function waitForHealthCheck(endpoint: string, timeoutMs: number): Promise<boolean> {
  const startTime = Date.now();
  const pollInterval = 500; // Poll every 500ms

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(`${endpoint}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(2000), // 2s timeout per request
      });
      if (response.ok) {
        return true;
      }
    } catch {
      // Server not ready yet, continue polling
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
  return false;
}

/** A single identity check used before acting on a persisted PID. */
async function isHealthyEndpoint(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Start a local development server for a project
 */
async function validateServeRequest(
  input: ProjectServeInput,
  paths: ReturnType<typeof getProjectPaths>
): Promise<ToolError | null> {
  if (!(await pathExists(paths.manifest))) {
    return createToolError("NOT_FOUND", `Project '${input.project_id}' not found`, {
      recoverable: false,
    });
  }

  const runningServer = runningServers.get(input.project_id);
  if (runningServer && isProcessRunning(runningServer.pid)) {
    return createToolError(
      "ALREADY_RUNNING",
      `Server already running for '${input.project_id}' at ${runningServer.endpoint} (PID: ${runningServer.pid})`,
      { recoverable: true }
    );
  }

  const pidData = await readServerPidFile(input.project_id);
  if (pidData && isProcessRunning(pidData.pid)) {
    const endpoint = `http://localhost:${pidData.port}`;
    if (await isHealthyEndpoint(endpoint)) {
      return createToolError(
        "ALREADY_RUNNING",
        `Server already running for '${input.project_id}' (PID: ${pidData.pid}, started externally). Use project_serve_stop first.`,
        { recoverable: true }
      );
    }
    await deleteServerPidFile(input.project_id);
  }

  if (!(await pathExists(path.join(paths.src, "index.ts")))) {
    return createToolError(
      "NOT_EXPORTED",
      `Project '${input.project_id}' has not been exported. Run project_export first.`,
      { recoverable: true }
    );
  }

  if (!(await pathExists(paths.chunks))) {
    return createToolError(
      "NOT_BUILT",
      `Project '${input.project_id}' has no data. Run project_build first.`,
      { recoverable: true }
    );
  }

  return null;
}

interface StartedServer {
  process: ChildProcess;
  stderr: { value: string };
  spawnError: { value: Error | null };
}

async function startServerProcess(
  input: ProjectServeInput,
  paths: ReturnType<typeof getProjectPaths>
): Promise<StartedServer | ToolError> {
  const nodeModulesPath = path.join(paths.root, "node_modules");
  if (!(await pathExists(nodeModulesPath))) {
    console.error(`[install] Installing dependencies for ${input.project_id}...`);
    try {
      await runCommand("npm", ["install"], { cwd: paths.root });
      console.error("OK: Dependencies installed");
    } catch (err) {
      return createToolError("INSTALL_FAILED", `Failed to install dependencies: ${err}`, {
        recoverable: true,
      });
    }
  }

  const env = { ...process.env, PORT: String(input.port), INDEXFOUNDRY_HTTP: "1" };
  if (input.mode === "dev") {
    console.error(`[start] Starting dev server for ${input.project_id} on port ${input.port}...`);
    return {
      process: spawnDetached("npx", ["tsx", "src/index.ts"], {
        cwd: paths.root,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      }),
      stderr: { value: "" },
      spawnError: { value: null },
    };
  }

  console.error(`[build] Building ${input.project_id}...`);
  try {
    await runCommand("npm", ["run", "build"], { cwd: paths.root });
    console.error("OK: Build complete");
  } catch (err) {
    return createToolError("BUILD_FAILED", `TypeScript compilation failed: ${err}`, {
      recoverable: true,
    });
  }

  console.error(`[start] Starting production server for ${input.project_id} on port ${input.port}...`);
  return {
    process: spawnDetached("node", ["dist/index.js"], {
      cwd: paths.root,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    }),
    stderr: { value: "" },
    spawnError: { value: null },
  };
}

function attachServerLogging(projectId: string, started: StartedServer): void {
  const serverProcess = started.process;
  serverProcess.stderr?.on("data", data => {
    started.stderr.value += data.toString();
    console.error(`[${projectId}] ${data.toString().trim()}`);
  });
  serverProcess.stdout?.on("data", data => {
    console.error(`[${projectId}] ${data.toString().trim()}`);
  });
  serverProcess.on("error", error => {
    started.spawnError.value = error instanceof Error ? error : new Error(String(error));
    console.error(`[${projectId}] Failed to launch server process: ${started.spawnError.value.message}`);
    runningServers.delete(projectId);
    deleteServerPidFile(projectId).catch(() => {});
  });
  serverProcess.on("exit", code => {
    console.error(`[${projectId}] Server exited with code ${code}`);
    runningServers.delete(projectId);
    deleteServerPidFile(projectId).catch(() => {});
  });
  serverProcess.unref();
}

function storeRunningServer(
  input: ProjectServeInput,
  started: StartedServer,
  endpoint: string
): RunningServer | ToolError {
  const serverProcess = started.process;
  const pid = serverProcess.pid;
  if (pid === undefined) {
    return createToolError("SERVE_FAILED", `Failed to spawn server process for '${input.project_id}'`, {
      recoverable: true,
    });
  }
  const startTime = new Date();
  const serverInfo: RunningServer = {
    projectId: input.project_id,
    process: serverProcess,
    pid,
    port: input.port,
    mode: input.mode,
    startTime,
    endpoint,
  };
  runningServers.set(input.project_id, serverInfo);
  return serverInfo;
}

async function openProjectFrontend(
  input: ProjectServeInput,
  paths: ReturnType<typeof getProjectPaths>
): Promise<void> {
  if (!input.open_browser) return;

  const frontendPath = path.join(paths.root, "frontend", "index.html");
  if (!(await pathExists(frontendPath))) return;

  try {
    // Serve the frontend through Express so browser requests have a supported
    // origin instead of the `file://` / `Origin: null` origin.
    await openInBrowser(`http://localhost:${input.port}/`);
    console.error("[browser] Opened frontend in browser");
  } catch {
    console.error("Could not open browser automatically");
  }
}

export async function projectServe(input: ProjectServeInput): Promise<ProjectServeResult | ToolError> {
  const paths = getProjectPaths(input.project_id);
  const validationError = await validateServeRequest(input, paths);
  if (validationError) return validationError;

  try {
    const started = await startServerProcess(input, paths);
    if ("isError" in started) return started;

    const endpoint = `http://localhost:${input.port}`;
    attachServerLogging(input.project_id, started);
    const serverInfo = storeRunningServer(input, started, endpoint);
    if ("isError" in serverInfo) return serverInfo;

    await writeServerPidFile(input.project_id, {
      pid: serverInfo.pid,
      port: serverInfo.port,
      mode: serverInfo.mode,
      startTime: serverInfo.startTime.toISOString(),
    });

    console.error("[wait] Waiting for server health check...");
    const healthy = await waitForHealthCheck(endpoint, input.health_check_timeout);
    if (started.spawnError.value) {
      return createToolError(
        "SERVE_FAILED",
        `Failed to launch server process: ${started.spawnError.value.message}`,
        { recoverable: true }
      );
    }
    if (!healthy) {
      console.error(
        `Warning: Health check timed out. Server may still be starting. stderr: ${started.stderr.value.slice(-500)}`
      );
      return {
        success: true,
        project_id: input.project_id,
        endpoint,
        pid: serverInfo.pid,
        port: input.port,
        mode: input.mode,
        message: `Server started (PID: ${serverInfo.pid}) but health check timed out. Check logs for errors. Endpoint: ${endpoint}`,
      };
    }

    console.error(`OK: Server healthy at ${endpoint}`);
    await openProjectFrontend(input, paths);

    return {
      success: true,
      project_id: input.project_id,
      endpoint,
      pid: serverInfo.pid,
      port: input.port,
      mode: input.mode,
      message: `Server running at ${endpoint} (PID: ${serverInfo.pid}). Frontend: ${path.join(paths.root, "frontend", "index.html")}`,
    };
  } catch (err) {
    return createToolError("SERVE_FAILED", `Failed to start server: ${err}`, {
      recoverable: true,
    });
  }
}

/**
 * Stop a running project server
 */
export async function projectServeStop(input: ProjectServeStopInput): Promise<ProjectServeStopResult | ToolError> {
  const paths = getProjectPaths(input.project_id);

  // Check if project exists
  if (!(await pathExists(paths.manifest))) {
    return createToolError("NOT_FOUND", `Project '${input.project_id}' not found`, {
      recoverable: false,
    });
  }

  // Try to find running server
  let pid: number | undefined;
  let endpoint: string | undefined;
  let startTime: Date | undefined;

  // First check in-memory map
  const runningServer = runningServers.get(input.project_id);
  if (runningServer) {
    pid = runningServer.pid;
    endpoint = runningServer.endpoint;
    startTime = runningServer.startTime;
  } else {
    // Check PID file for externally started server
    const pidData = await readServerPidFile(input.project_id);
    if (pidData) {
      pid = pidData.pid;
      endpoint = `http://localhost:${pidData.port}`;
      startTime = new Date(pidData.startTime);
    }
  }

  if (!pid) {
    return createToolError("NOT_RUNNING", `No server running for '${input.project_id}'`, {
      recoverable: true,
    });
  }

  // A persisted PID can be reused after a crash or reboot, so require its
  // recorded port to answer the health endpoint before sending a signal. An
  // in-memory child was spawned by this MCP instance, so it can be stopped
  // even when its health endpoint is currently unhealthy.
  const processRunning = isProcessRunning(pid);
  const identityConfirmed = runningServer
    ? processRunning
    : processRunning && endpoint !== undefined
      ? await isHealthyEndpoint(endpoint)
      : false;
  if (!identityConfirmed) {
    // Clean up stale references
    runningServers.delete(input.project_id);
    await deleteServerPidFile(input.project_id);
    return createToolError("NOT_RUNNING", `Server process (PID: ${pid}) is no longer running`, {
      recoverable: true,
    });
  }

  const uptimeSeconds = startTime
    ? Math.floor((Date.now() - startTime.getTime()) / 1000)
    : 0;

  try {
    // Attempt graceful shutdown
    console.error(`[stop] Stopping server for ${input.project_id} (PID: ${pid})...`);

    if (input.force) {
      // Force kill
      process.kill(pid, "SIGKILL");
    } else {
      // Graceful shutdown
      process.kill(pid, "SIGTERM");

      // Wait a bit for graceful shutdown
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Revalidate the original process before escalating. An in-memory
      // ChildProcess object is a non-reusable identity; for a persisted PID,
      // require the recorded endpoint to remain healthy so a reused PID is
      // never force-killed.
      const originalProcessStillRunning = runningServer
        ? runningServers.get(input.project_id)?.process === runningServer.process
          && runningServer.process.pid === pid
          && runningServer.process.exitCode === null
          && runningServer.process.signalCode === null
          && isProcessRunning(pid)
        : isProcessRunning(pid)
          && endpoint !== undefined
          && await isHealthyEndpoint(endpoint);
      if (originalProcessStillRunning) {
        console.error(`Ã¢Å¡ Ã¯Â¸Â Process still running, sending SIGKILL...`);
        process.kill(pid, "SIGKILL");
      }
    }

    // Clean up
    runningServers.delete(input.project_id);
    await deleteServerPidFile(input.project_id);

    console.error(`OK: Server stopped`);

    return {
      success: true,
      project_id: input.project_id,
      pid,
      uptime_seconds: uptimeSeconds,
      message: `Server stopped (was running for ${uptimeSeconds}s)`,
    };

  } catch (err) {
    return createToolError("STOP_FAILED", `Failed to stop server: ${err}`, {
      recoverable: true,
    });
  }
}

/**
 * Get status of running project servers
 */
export async function projectServeStatus(input: ProjectServeStatusInput): Promise<ProjectServeStatusResult | ToolError> {
  const servers: ProjectServeStatusResult["servers"] = [];

  if (input.project_id) {
    // Get status for specific project
    const paths = getProjectPaths(input.project_id);

    if (!(await pathExists(paths.manifest))) {
      return createToolError("NOT_FOUND", `Project '${input.project_id}' not found`, {
        recoverable: false,
      });
    }

    // Check in-memory map first
    const runningServer = runningServers.get(input.project_id);
    if (runningServer && isProcessRunning(runningServer.pid)) {
      servers.push({
        project_id: runningServer.projectId,
        endpoint: runningServer.endpoint,
        pid: runningServer.pid,
        port: runningServer.port,
        mode: runningServer.mode,
        uptime_seconds: Math.floor((Date.now() - runningServer.startTime.getTime()) / 1000),
        status: "running",
      });
    } else {
      // Check PID file
      const pidData = await readServerPidFile(input.project_id);
      if (pidData && isProcessRunning(pidData.pid)) {
        servers.push({
          project_id: input.project_id,
          endpoint: `http://localhost:${pidData.port}`,
          pid: pidData.pid,
          port: pidData.port,
          mode: pidData.mode as "dev" | "build",
          uptime_seconds: Math.floor((Date.now() - new Date(pidData.startTime).getTime()) / 1000),
          status: "running",
        });
      }
    }
  } else {
    // Get status for all running servers
    for (const [projectId, server] of runningServers) {
      if (isProcessRunning(server.pid)) {
        servers.push({
          project_id: projectId,
          endpoint: server.endpoint,
          pid: server.pid,
          port: server.port,
          mode: server.mode,
          uptime_seconds: Math.floor((Date.now() - server.startTime.getTime()) / 1000),
          status: "running",
        });
      } else {
        // Clean up stale entry
        runningServers.delete(projectId);
        deleteServerPidFile(projectId).catch(() => {});
      }
    }

    // Also scan projects directory for PID files we don't know about
    try {
      const { readdir } = await import("fs/promises");
      const entries = await readdir(getProjectsBaseDir(), { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (runningServers.has(entry.name)) continue; // Already checked

        const pidData = await readServerPidFile(entry.name);
        if (pidData && isProcessRunning(pidData.pid)) {
          servers.push({
            project_id: entry.name,
            endpoint: `http://localhost:${pidData.port}`,
            pid: pidData.pid,
            port: pidData.port,
            mode: pidData.mode as "dev" | "build",
            uptime_seconds: Math.floor((Date.now() - new Date(pidData.startTime).getTime()) / 1000),
            status: "running",
          });
        }
      }
    } catch {
      // Projects directory may not exist yet
    }
  }

  return {
    success: true,
    servers,
    total: servers.length,
  };
}
