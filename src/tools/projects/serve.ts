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

/**
 * Start a local development server for a project
 */
export async function projectServe(input: ProjectServeInput): Promise<ProjectServeResult | ToolError> {
  const paths = getProjectPaths(input.project_id);
  
  // Check if project exists
  if (!(await pathExists(paths.manifest))) {
    return createToolError("NOT_FOUND", `Project '${input.project_id}' not found`, {
      recoverable: false,
    });
  }
  
  // Check if already running
  const existingServer = runningServers.get(input.project_id);
  if (existingServer && isProcessRunning(existingServer.pid)) {
    return createToolError("ALREADY_RUNNING", `Server already running for '${input.project_id}' at ${existingServer.endpoint} (PID: ${existingServer.pid})`, {
      recoverable: true,
    });
  }
  
  // Check for orphaned process from PID file
  const pidData = await readServerPidFile(input.project_id);
  if (pidData && isProcessRunning(pidData.pid)) {
    return createToolError("ALREADY_RUNNING", `Server already running for '${input.project_id}' (PID: ${pidData.pid}, started externally). Use project_serve_stop first.`, {
      recoverable: true,
    });
  }
  
  // Verify project has been exported (has src/index.ts)
  const serverSourcePath = path.join(paths.src, "index.ts");
  if (!(await pathExists(serverSourcePath))) {
    return createToolError("NOT_EXPORTED", `Project '${input.project_id}' has not been exported. Run project_export first.`, {
      recoverable: true,
    });
  }
  
  // Check if project has been built (has chunks/vectors)
  if (!(await pathExists(paths.chunks))) {
    return createToolError("NOT_BUILT", `Project '${input.project_id}' has no data. Run project_build first.`, {
      recoverable: true,
    });
  }
  
  try {
    // Check if node_modules exists, if not run npm install
    const nodeModulesPath = path.join(paths.root, "node_modules");
    if (!(await pathExists(nodeModulesPath))) {
      console.error(`[install] Installing dependencies for ${input.project_id}...`);
      try {
        await runCommand("npm", ["install"], { cwd: paths.root });
        console.error(`OK: Dependencies installed`);
      } catch (err) {
        return createToolError("INSTALL_FAILED", `Failed to install dependencies: ${err}`, {
          recoverable: true,
        });
      }
    }
    
    const port = input.port;
    const endpoint = `http://localhost:${port}`;
    
    let serverProcess: ChildProcess;
    
    if (input.mode === "dev") {
      // Dev mode: use tsx for hot reload
      console.error(`[start] Starting dev server for ${input.project_id} on port ${port}...`);
      serverProcess = spawnDetached("npx", ["tsx", "src/index.ts"], {
        cwd: paths.root,
        env: { ...process.env, PORT: String(port) },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } else {
      // Build mode: compile TypeScript first, then run
      console.error(`[build] Building ${input.project_id}...`);
      try {
        await runCommand("npm", ["run", "build"], { cwd: paths.root });
        console.error(`OK: Build complete`);
      } catch (err) {
        return createToolError("BUILD_FAILED", `TypeScript compilation failed: ${err}`, {
          recoverable: true,
        });
      }
      
      console.error(`[start] Starting production server for ${input.project_id} on port ${port}...`);
      serverProcess = spawnDetached("node", ["dist/index.js"], {
        cwd: paths.root,
        env: { ...process.env, PORT: String(port) },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
    
    // Capture output for debugging
    let stderr = "";
    serverProcess.stderr?.on("data", (data) => {
      stderr += data.toString();
      console.error(`[${input.project_id}] ${data.toString().trim()}`);
    });
    
    serverProcess.stdout?.on("data", (data) => {
      console.error(`[${input.project_id}] ${data.toString().trim()}`);
    });
    
    // Handle process exit
    serverProcess.on("exit", (code) => {
      console.error(`[${input.project_id}] Server exited with code ${code}`);
      runningServers.delete(input.project_id);
      deleteServerPidFile(input.project_id).catch(() => {});
    });
    
    // Unref so the parent process can exit independently
    serverProcess.unref();
    
    const pid = serverProcess.pid!;
    const startTime = new Date();
    
    // Store in running servers map
    const serverInfo: RunningServer = {
      projectId: input.project_id,
      process: serverProcess,
      pid,
      port,
      mode: input.mode,
      startTime,
      endpoint,
    };
    runningServers.set(input.project_id, serverInfo);
    
    // Write PID file for persistence
    await writeServerPidFile(input.project_id, {
      pid,
      port,
      mode: input.mode,
      startTime: startTime.toISOString(),
    });
    
    // Wait for health check
    console.error(`[wait] Waiting for server health check...`);
    const healthy = await waitForHealthCheck(endpoint, input.health_check_timeout);
    
    if (!healthy) {
      // Server didn't respond in time
      console.error(`âš ï¸ Health check timed out. Server may still be starting. stderr: ${stderr.slice(-500)}`);
      return {
        success: true,
        project_id: input.project_id,
        endpoint,
        pid,
        port,
        mode: input.mode,
        message: `Server started (PID: ${pid}) but health check timed out. Check logs for errors. Endpoint: ${endpoint}`,
      };
    }
    
    console.error(`OK: Server healthy at ${endpoint}`);
    
    // Open browser if requested
    if (input.open_browser) {
      const frontendPath = path.join(paths.root, "frontend", "index.html");
      if (await pathExists(frontendPath)) {
        try {
          await openInBrowser(frontendPath);
          console.error(`[browser] Opened frontend in browser`);
        } catch {
          console.error(`âš ï¸ Could not open browser automatically`);
        }
      }
    }
    
    return {
      success: true,
      project_id: input.project_id,
      endpoint,
      pid,
      port,
      mode: input.mode,
      message: `Server running at ${endpoint} (PID: ${pid}). Frontend: ${path.join(paths.root, "frontend", "index.html")}`,
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
  let startTime: Date | undefined;
  
  // First check in-memory map
  const runningServer = runningServers.get(input.project_id);
  if (runningServer) {
    pid = runningServer.pid;
    startTime = runningServer.startTime;
  } else {
    // Check PID file for externally started server
    const pidData = await readServerPidFile(input.project_id);
    if (pidData) {
      pid = pidData.pid;
      startTime = new Date(pidData.startTime);
    }
  }
  
  if (!pid) {
    return createToolError("NOT_RUNNING", `No server running for '${input.project_id}'`, {
      recoverable: true,
    });
  }
  
  // Check if process is actually running
  if (!isProcessRunning(pid)) {
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
      
      // Check if still running
      if (isProcessRunning(pid)) {
        console.error(`âš ï¸ Process still running, sending SIGKILL...`);
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

