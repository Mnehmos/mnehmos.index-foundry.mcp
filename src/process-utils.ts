/**
 * Process execution helpers.
 *
 * Every child process in this codebase goes through these helpers so that
 * arguments are passed as an argv array rather than interpolated into a shell
 * command string. Callers frequently pass values that originated with an MCP
 * client (project ids, env var names, file paths), which must never reach a
 * shell unescaped.
 *
 * Copyright (c) 2024 vario.automation
 * Proprietary and confidential. All rights reserved.
 */

import { execFile, spawn } from "child_process";
import type { ChildProcess, SpawnOptions } from "child_process";
import path from "path";
import { existsSync } from "fs";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_COMMAND_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * Resolve commands without passing them through a shell. Windows `.cmd` shims
 * are handled by `resolveInvocation`; arbitrary command names are left for
 * Windows PATH resolution rather than guessing a shell-backed extension.
 */
export function resolveCommand(command: string): string {
  if (process.platform !== "win32") return command;
  if (command === "node") return process.execPath;
  return command;
}

/**
 * Windows batch shims cannot be launched by child_process without a shell.
 * Resolve the Node-backed shims to their JavaScript entry points instead, so
 * callers keep argv semantics and do not need shell interpolation. If the
 * local Node installation does not contain a known CLI entry point, fail
 * clearly instead of falling back to a `.cmd` process with shell semantics.
 */
function resolveInvocation(command: string, args: string[]): { file: string; args: string[] } {
  if (process.platform !== "win32") {
    return { file: command, args };
  }

  const nodeCliByCommand: Record<string, string> = {
    npm: path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    npx: path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js"),
    railway: path.join(path.dirname(process.execPath), "node_modules", "@railway", "cli", "bin", "railway.js"),
  };
  const nodeCliCandidates = [nodeCliByCommand[command]];
  if (command === "railway") {
    const globalPrefixes = [
      process.env.npm_config_prefix,
      process.env.NPM_CONFIG_PREFIX,
      process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : undefined,
      ...(process.env.Path ?? process.env.PATH ?? "").split(path.delimiter),
    ].filter((prefix): prefix is string => Boolean(prefix));

    nodeCliCandidates.push(
      ...globalPrefixes.map(prefix =>
        path.join(prefix, "node_modules", "@railway", "cli", "bin", "railway.js")
      )
    );
  }

  const nodeCli = nodeCliCandidates.find(candidate => Boolean(candidate) && existsSync(candidate));

  if (nodeCli && existsSync(nodeCli)) {
    return { file: process.execPath, args: [nodeCli, ...args] };
  }

  if (/\.(cmd|bat)$/i.test(command) || ["npm", "npx", "railway"].includes(command)) {
    throw new Error(
      `Cannot execute Windows command shim '${command}' without a Node CLI entry point`
    );
  }

  return { file: resolveCommand(command), args };
}

/**
 * Run a command to completion with arguments passed as argv (no shell).
 */
export async function runCommand(
  command: string,
  args: string[],
  options: RunOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const invocation = resolveInvocation(command, args);
  const { stdout, stderr } = await execFileAsync(invocation.file, invocation.args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    maxBuffer: options.maxBufferBytes ?? DEFAULT_COMMAND_MAX_BUFFER_BYTES,
    windowsHide: true,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
}

/**
 * Spawn a long-lived detached process with arguments passed as argv (no shell).
 */
export function spawnDetached(
  command: string,
  args: string[],
  options: SpawnOptions & { cwd?: string }
): ChildProcess {
  const invocation = resolveInvocation(command, args);
  return spawn(invocation.file, invocation.args, {
    ...options,
    shell: false,
    windowsHide: true,
  });
}

/**
 * Environment variable names must be a plain identifier. Anything else is
 * rejected rather than escaped, since no legitimate caller needs it.
 */
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidEnvVarName(name: string): boolean {
  return ENV_VAR_NAME.test(name);
}

/**
 * Open a local file with the platform's default handler.
 *
 * Uses argv rather than a shell string. `explorer.exe` exits non-zero even on
 * success, so callers should treat a rejection here as non-fatal.
 */
export async function openInBrowser(target: string): Promise<void> {
  if (process.platform === "win32") {
    await runCommand("explorer.exe", [target]);
  } else if (process.platform === "darwin") {
    await runCommand("open", [target]);
  } else {
    await runCommand("xdg-open", [target]);
  }
}
