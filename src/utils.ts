/**
 * IndexFoundry-MCP: Core Utilities
 *
 * Deterministic utilities for hashing, file operations, and ID generation.
 *
 * Copyright (c) 2024 vario.automation
 * Proprietary and confidential. All rights reserved.
 */

import { createHash } from "crypto";
import { v7 as uuidv7 } from "uuid";
import * as fs from "fs/promises";
import * as path from "path";
import type { EventLogEntry, ErrorCode, ToolError, RunManifest, PhaseManifest, RawArtifact } from "./types.js";

// ============================================================================
// Hashing Utilities (Deterministic)
// ============================================================================

/**
 * Generate SHA256 hash of content
 */
export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Generate deterministic chunk ID from doc_id and byte offsets
 */
export function generateChunkId(docId: string, byteStart: number, byteEnd: number): string {
  return sha256(`${docId}|${byteStart}|${byteEnd}`);
}

/**
 * Generate SHA256 hash of a file
 */
export async function hashFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return sha256(content);
}

/**
 * Generate config hash for manifest
 */
export function hashConfig(config: unknown): string {
  // Stable JSON stringify (sorted keys)
  const stable = JSON.stringify(config, Object.keys(config as object).sort());
  return sha256(stable);
}

// ============================================================================
// ID Generation
// ============================================================================

/**
 * Generate time-ordered UUID v7 for run IDs
 */
export function generateRunId(): string {
  return uuidv7();
}

// ============================================================================
// File Operations
// ============================================================================

/**
 * Ensure a directory exists
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Check if a path exists
 */
export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get file extension from content type
 */
export function extensionFromContentType(contentType: string): string {
  const mapping: Record<string, string> = {
    "application/pdf": ".pdf",
    "text/html": ".html",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "text/csv": ".csv",
    "application/json": ".json",
    "application/xml": ".xml",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  };
  
  const base = contentType.split(";")[0].trim();
  return mapping[base] || ".bin";
}

/**
 * Detect content type from file extension
 */
export function contentTypeFromExtension(ext: string): string {
  const mapping: Record<string, string> = {
    ".pdf": "application/pdf",
    ".html": "text/html",
    ".htm": "text/html",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
    ".xml": "application/xml",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  
  return mapping[ext.toLowerCase()] || "application/octet-stream";
}

/**
 * Write JSONL file (append mode)
 */
export async function appendJsonl(filePath: string, records: unknown[]): Promise<void> {
  const lines = records.map(r => JSON.stringify(r)).join("\n") + "\n";
  await fs.appendFile(filePath, lines, "utf-8");
}

/**
 * Write JSONL file (overwrite mode)
 */
export async function writeJsonl(filePath: string, records: unknown[]): Promise<void> {
  const lines = records.map(r => JSON.stringify(r)).join("\n");
  await fs.writeFile(filePath, lines ? lines + "\n" : "", "utf-8");
}

/**
 * Read JSONL file
 */
export async function readJsonl<T>(filePath: string): Promise<T[]> {
  const content = await fs.readFile(filePath, "utf-8");
  return content
    .split("\n")
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as T);
}

/**
 * Write JSON file with stable sorting
 */
export async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Read JSON file
 */
export async function readJson<T>(filePath: string): Promise<T> {
  const content = await fs.readFile(filePath, "utf-8");
  return JSON.parse(content) as T;
}

/**
 * List files in directory (sorted for determinism)
 */
export async function listFiles(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter(e => e.isFile())
    .map(e => e.name)
    .sort();
}

// ============================================================================
// Text Utilities
// ============================================================================

/**
 * Normalize text for consistent hashing
 */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")  // Normalize line endings
    .replace(/\t/g, "    ")   // Tabs to spaces
    .normalize("NFC");        // Unicode normalization
}

/**
 * Estimate token count (rough approximation)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ============================================================================
// Heading Utilities (Hierarchical Chunking)
// ============================================================================

/**
 * Parse heading level from a markdown line.
 * Detects ATX-style headings (# through ######).
 *
 * @param line - The line to parse
 * @returns Heading level (1-6) or null if not a valid heading
 *
 * @example
 * parseHeadingLevel("# Title")       // returns 1
 * parseHeadingLevel("## Section")    // returns 2
 * parseHeadingLevel("#NoSpace")      // returns null (invalid - no space after #)
 * parseHeadingLevel("Regular text")  // returns null
 */
export function parseHeadingLevel(line: string): number | null {
  const match = line.match(/^(#{1,6})\s+/);
  return match ? match[1].length : null;
}

/**
 * Get truncated parent context from a parent chunk's text.
 * Used for hierarchical chunking to provide context from parent sections.
 *
 * @param parentText - The parent chunk's text content
 * @param maxChars - Maximum characters to include (0 disables context)
 * @returns Truncated parent content, or undefined if maxChars is 0
 *
 * @example
 * getParentContext("# Long Title\nWith content...", 50)
 * // returns "# Long Title\nWith content..." (truncated to 50 chars)
 *
 * getParentContext("Short", 100)
 * // returns "Short" (no truncation needed)
 *
 * getParentContext("Any text", 0)
 * // returns undefined (context disabled)
 */
export function getParentContext(parentText: string, maxChars: number): string | undefined {
  if (maxChars <= 0) {
    return undefined;
  }
  return parentText.slice(0, maxChars);
}

// ============================================================================
// Error Handling
// ============================================================================

/**
 * Create a standardized tool error
 */
export function createToolError(
  code: ErrorCode,
  message: string,
  options?: {
    details?: unknown;
    recoverable?: boolean;
    suggestion?: string;
  }
): ToolError {
  return {
    success: false,
    isError: true,
    code,
    message,
    details: options?.details,
    recoverable: options?.recoverable ?? false,
    suggestion: options?.suggestion,
  };
}

/**
 * Format error for MCP response
 */
export function formatErrorResponse(error: ToolError): { isError: true; content: Array<{ type: "text"; text: string }> } {
  const text = [
    `Error: ${error.code}`,
    error.message,
    error.suggestion ? `Suggestion: ${error.suggestion}` : "",
    error.details ? `Details: ${JSON.stringify(error.details)}` : "",
  ].filter(Boolean).join("\n");

  return {
    isError: true,
    content: [{ type: "text", text }],
  };
}

// ============================================================================
// Logging
// ============================================================================

/**
 * Create an event log entry
 */
export function createLogEntry(
  level: EventLogEntry["level"],
  phase: string,
  tool: string,
  message: string,
  data?: unknown
): EventLogEntry {
  return {
    timestamp: new Date().toISOString(),
    level,
    phase,
    tool,
    message,
    data,
  };
}

/**
 * Logger class for run operations
 */
export class RunLogger {
  private logsDir: string;
  
  constructor(runDir: string) {
    this.logsDir = path.join(runDir, "logs");
  }
  
  async init(): Promise<void> {
    await ensureDir(this.logsDir);
  }
  
  async log(entry: EventLogEntry): Promise<void> {
    const file = entry.level === "error" ? "errors.ndjson" : "events.ndjson";
    await appendJsonl(path.join(this.logsDir, file), [entry]);
  }
  
  async info(phase: string, tool: string, message: string, data?: unknown): Promise<void> {
    await this.log(createLogEntry("info", phase, tool, message, data));
  }
  
  async warn(phase: string, tool: string, message: string, data?: unknown): Promise<void> {
    await this.log(createLogEntry("warn", phase, tool, message, data));
  }
  
  async error(phase: string, tool: string, message: string, data?: unknown): Promise<void> {
    await this.log(createLogEntry("error", phase, tool, message, data));
  }
}

// ============================================================================
// Time Utilities
// ============================================================================

/**
 * Get current ISO8601 timestamp
 */
export function now(): string {
  return new Date().toISOString();
}

/**
 * Measure execution time
 */
export async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; duration_ms: number }> {
  const start = performance.now();
  const result = await fn();
  const duration_ms = Math.round(performance.now() - start);
  return { result, duration_ms };
}

// ============================================================================
// Vector Utilities (Embeddings & Similarity)
// ============================================================================

/**
 * Generate a deterministic mock embedding from text content.
 * Uses SHA256 hash as a seed for reproducible pseudo-random generation.
 * The resulting vector is L2 normalized (unit length).
 *
 * @param text - Input text to generate embedding from
 * @param dimension - Vector dimension (default: 1536 for OpenAI compatibility)
 * @returns Normalized embedding vector of specified dimension
 *
 * @example
 * const embedding = generateMockEmbedding("Hello, world!", 1536);
 * // Returns reproducible 1536-dimensional unit vector
 */
export function generateMockEmbedding(text: string, dimension: number = 1536): number[] {
  const hash = createHash("sha256").update(text).digest("hex");
  const seed = parseInt(hash.slice(0, 8), 16);

  const embedding: number[] = [];
  let x = seed;
  for (let i = 0; i < dimension; i++) {
    x = (x * 1103515245 + 12345) % (2 ** 31);
    embedding.push((x / (2 ** 31)) * 2 - 1); // Normalize to [-1, 1]
  }

  // L2 normalize to unit vector
  const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
  return embedding.map(v => v / norm);
}

/**
 * Calculate cosine similarity between two vectors.
 * Returns a value between -1 (opposite) and 1 (identical).
 * Returns 0 if vectors have different lengths or zero magnitude.
 *
 * @param a - First vector
 * @param b - Second vector
 * @returns Cosine similarity score [-1, 1]
 *
 * @example
 * const sim = cosineSimilarity([1, 0, 0], [1, 0, 0]); // 1.0
 * const sim2 = cosineSimilarity([1, 0, 0], [0, 1, 0]); // 0.0
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}
