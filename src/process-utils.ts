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
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * On Windows, `npm`/`npx`/`railway` are `.cmd` shims. `execFile` and `spawn`
 * do not resolve those without a shell, so the extension is added explicitly.
 * This is what lets us drop `shell: true` everywhere.
 */
export function resolveCommand(command: string): string {
  if (process.platform !== "win32") return command;
  if (/\.(cmd|bat|exe)$/i.test(command)) return command;
  return `${command}.cmd`;
}

/**
 * Run a command to completion with arguments passed as argv (no shell).
 */
export async function runCommand(
  command: string,
  args: string[],
  options: RunOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(resolveCommand(command), args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs,
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
  return spawn(resolveCommand(command), args, {
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
