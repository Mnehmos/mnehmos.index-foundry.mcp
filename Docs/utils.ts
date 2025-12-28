/**
 * IndexFoundry-MCP Utility Functions
 * 
 * Core utilities for hashing, file operations, and deterministic processing.
 */

import { createHash } from "crypto";
import { promises as fs } from "fs";
import { join, dirname, basename, extname } from "path";
import { v7 as uuidv7 } from "uuid";
import type { LogEvent, LogLevel, RunManifest, PhaseManifest } from "./types.js";

// =============================================================================
// Hashing Utilities
// =============================================================================

/**
 * Compute SHA256 hash of a string (normalized to UTF-8)
 */
export function hashString(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Compute SHA256 hash of a buffer
 */
export function hashBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Compute SHA256 hash of a file
 */
export async function hashFile(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return hashBuffer(buffer);
}

/**
 * Generate a deterministic chunk ID from document and position
 */
export function generateChunkId(docId: string, byteStart: number, byteEnd: number): string {
  const input = `${docId}::${byteStart}::${byteEnd}`;
  return hashString(input);
}

/**
 * Normalize text for consistent hashing (trim, collapse whitespace, lowercase)
 */
export function normalizeText(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// =============================================================================
// Run Directory Management
// =============================================================================

export interface RunDirectory {
  runId: string;
  basePath: string;
  paths: {
    manifest: string;
    config: string;
    raw: string;
    extracted: string;
    normalized: string;
    indexed: string;
    served: string;
    logs: string;
  };
}

/**
 * Create a new run directory with all required subdirectories
 */
export async function createRunDirectory(
  runsDir: string,
  runId?: string
): Promise<RunDirectory> {
  const id = runId ?? uuidv7();
  const basePath = join(runsDir, id);
  
  const paths = {
    manifest: join(basePath, "manifest.json"),
    config: join(basePath, "config.json"),
    raw: join(basePath, "raw"),
    extracted: join(basePath, "extracted"),
    normalized: join(basePath, "normalized"),
    indexed: join(basePath, "indexed"),
    served: join(basePath, "served"),
    logs: join(basePath, "logs"),
  };
  
  // Create all directories
  await fs.mkdir(basePath, { recursive: true });
  await fs.mkdir(paths.raw, { recursive: true });
  await fs.mkdir(paths.extracted, { recursive: true });
  await fs.mkdir(paths.normalized, { recursive: true });
  await fs.mkdir(paths.indexed, { recursive: true });
  await fs.mkdir(paths.served, { recursive: true });
  await fs.mkdir(paths.logs, { recursive: true });
  
  return { runId: id, basePath, paths };
}

/**
 * Get an existing run directory
 */
export async function getRunDirectory(
  runsDir: string,
  runId: string
): Promise<RunDirectory | null> {
  const basePath = join(runsDir, runId);
  
  try {
    await fs.access(basePath);
  } catch {
    return null;
  }
  
  return {
    runId,
    basePath,
    paths: {
      manifest: join(basePath, "manifest.json"),
      config: join(basePath, "config.json"),
      raw: join(basePath, "raw"),
      extracted: join(basePath, "extracted"),
      normalized: join(basePath, "normalized"),
      indexed: join(basePath, "indexed"),
      served: join(basePath, "served"),
      logs: join(basePath, "logs"),
    },
  };
}

// =============================================================================
// Manifest Management
// =============================================================================

/**
 * Create initial run manifest
 */
export function createInitialManifest(runId: string, configHash: string): RunManifest {
  return {
    run_id: runId,
    created_at: new Date().toISOString(),
    status: "running",
    config_hash: configHash,
    phases: {},
    totals: {
      sources_fetched: 0,
      documents_extracted: 0,
      chunks_created: 0,
      vectors_indexed: 0,
      errors_encountered: 0,
    },
    timing: {
      total_duration_ms: 0,
      phase_durations: {},
    },
  };
}

/**
 * Create initial phase manifest
 */
export function createPhaseManifest(toolVersion: string): PhaseManifest {
  return {
    started_at: new Date().toISOString(),
    status: "running",
    inputs: { count: 0, hashes: [] },
    outputs: { count: 0, hashes: [] },
    tool_version: toolVersion,
    errors: [],
  };
}

/**
 * Save manifest to disk
 */
export async function saveManifest(manifestPath: string, manifest: RunManifest): Promise<void> {
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

/**
 * Load manifest from disk
 */
export async function loadManifest(manifestPath: string): Promise<RunManifest> {
  const content = await fs.readFile(manifestPath, "utf8");
  return JSON.parse(content) as RunManifest;
}

// =============================================================================
// JSONL Operations
// =============================================================================

/**
 * Append a record to a JSONL file
 */
export async function appendJsonl<T>(filePath: string, record: T): Promise<void> {
  const line = JSON.stringify(record) + "\n";
  await fs.appendFile(filePath, line);
}

/**
 * Read all records from a JSONL file
 */
export async function readJsonl<T>(filePath: string): Promise<T[]> {
  const content = await fs.readFile(filePath, "utf8");
  return content
    .split("\n")
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as T);
}

/**
 * Stream records from a JSONL file (generator)
 */
export async function* streamJsonl<T>(filePath: string): AsyncGenerator<T> {
  const content = await fs.readFile(filePath, "utf8");
  for (const line of content.split("\n")) {
    if (line.trim()) {
      yield JSON.parse(line) as T;
    }
  }
}

/**
 * Write records to a JSONL file (overwrite)
 */
export async function writeJsonl<T>(filePath: string, records: T[]): Promise<void> {
  const content = records.map(r => JSON.stringify(r)).join("\n") + "\n";
  await fs.writeFile(filePath, content);
}

// =============================================================================
// Logging
// =============================================================================

export class RunLogger {
  private eventsPath: string;
  private errorsPath: string;
  private currentPhase: string = "init";
  private currentTool: string = "system";
  
  constructor(logsDir: string) {
    this.eventsPath = join(logsDir, "events.ndjson");
    this.errorsPath = join(logsDir, "errors.ndjson");
  }
  
  setContext(phase: string, tool: string): void {
    this.currentPhase = phase;
    this.currentTool = tool;
  }
  
  async log(level: LogLevel, message: string, details?: unknown): Promise<void> {
    const event: LogEvent = {
      timestamp: new Date().toISOString(),
      level,
      phase: this.currentPhase,
      tool: this.currentTool,
      message,
      details,
    };
    
    await appendJsonl(this.eventsPath, event);
    
    if (level === "error") {
      await appendJsonl(this.errorsPath, event);
    }
    
    // Also log to stderr for debugging
    console.error(`[${level.toUpperCase()}] [${this.currentPhase}/${this.currentTool}] ${message}`);
  }
  
  debug(message: string, details?: unknown): Promise<void> {
    return this.log("debug", message, details);
  }
  
  info(message: string, details?: unknown): Promise<void> {
    return this.log("info", message, details);
  }
  
  warn(message: string, details?: unknown): Promise<void> {
    return this.log("warn", message, details);
  }
  
  error(message: string, details?: unknown): Promise<void> {
    return this.log("error", message, details);
  }
}

// =============================================================================
// File Utilities
// =============================================================================

/**
 * Get file extension from path or content-type
 */
export function getExtension(pathOrContentType: string): string {
  if (pathOrContentType.includes("/")) {
    // It's a content-type
    const typeMap: Record<string, string> = {
      "application/pdf": ".pdf",
      "text/html": ".html",
      "text/plain": ".txt",
      "text/markdown": ".md",
      "text/csv": ".csv",
      "application/json": ".json",
      "application/xml": ".xml",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    };
    return typeMap[pathOrContentType] ?? ".bin";
  }
  return extname(pathOrContentType) || ".bin";
}

/**
 * Ensure a directory exists
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Check if a file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy a file with hash verification
 */
export async function copyFileWithHash(
  source: string,
  dest: string
): Promise<{ hash: string; size: number }> {
  await ensureDir(dirname(dest));
  const buffer = await fs.readFile(source);
  await fs.writeFile(dest, buffer);
  return {
    hash: hashBuffer(buffer),
    size: buffer.length,
  };
}

/**
 * Get sorted list of files matching a glob pattern
 */
export async function getSortedFiles(
  dir: string,
  pattern: string = "*"
): Promise<string[]> {
  const { glob } = await import("glob");
  const files = await glob(pattern, { cwd: dir, absolute: true });
  return files.sort();
}

// =============================================================================
// Text Processing
// =============================================================================

/**
 * Estimate token count (rough approximation: chars / 4)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Split text by a hierarchy of separators (for recursive chunking)
 */
export function splitByHierarchy(
  text: string,
  separators: string[],
  maxChars: number
): string[] {
  if (text.length <= maxChars || separators.length === 0) {
    return [text];
  }
  
  const [sep, ...restSeps] = separators;
  const parts = text.split(sep);
  
  const chunks: string[] = [];
  let current = "";
  
  for (const part of parts) {
    const addition = current ? sep + part : part;
    
    if ((current + addition).length <= maxChars) {
      current += addition;
    } else {
      if (current) {
        // Recursively split if still too large
        if (current.length > maxChars && restSeps.length > 0) {
          chunks.push(...splitByHierarchy(current, restSeps, maxChars));
        } else {
          chunks.push(current);
        }
      }
      current = part;
    }
  }
  
  if (current) {
    if (current.length > maxChars && restSeps.length > 0) {
      chunks.push(...splitByHierarchy(current, restSeps, maxChars));
    } else {
      chunks.push(current);
    }
  }
  
  return chunks;
}

// =============================================================================
// Error Formatting
// =============================================================================

export interface FormattedError {
  code: string;
  message: string;
  details?: unknown;
  recoverable: boolean;
  suggestion?: string;
}

export function formatError(
  code: string,
  message: string,
  options?: {
    details?: unknown;
    recoverable?: boolean;
    suggestion?: string;
  }
): FormattedError {
  return {
    code,
    message,
    details: options?.details,
    recoverable: options?.recoverable ?? false,
    suggestion: options?.suggestion,
  };
}

// =============================================================================
// Timing Utilities
// =============================================================================

export class Timer {
  private start: bigint;
  
  constructor() {
    this.start = process.hrtime.bigint();
  }
  
  elapsedMs(): number {
    const end = process.hrtime.bigint();
    return Number(end - this.start) / 1_000_000;
  }
  
  reset(): void {
    this.start = process.hrtime.bigint();
  }
}
