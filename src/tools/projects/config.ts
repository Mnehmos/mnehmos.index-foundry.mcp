/**
 * Shared configuration, path resolution and metrics for the project tools.
 *
 * Split out of the former single-file projects.ts so the pipeline, serving and
 * deployment modules can share one definition of where a project lives.
 *
 * Copyright (c) 2024 vario.automation
 * Proprietary and confidential. All rights reserved.
 */

import path from "path";
import { fileURLToPath } from "url";
import { dirname as pathDirname } from "path";

// ============================================================================
// Configuration Constants
// ============================================================================

/** Maximum file size for fetched content (200MB) */
export const MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024;

/** Maximum file size for folder files (5MB) */
export const MAX_FOLDER_FILE_SIZE_BYTES = 5 * 1024 * 1024;

/** Default timeout for HTTP requests (30 seconds) */
export const DEFAULT_TIMEOUT_MS = 30000;

/** Timeout for embedding API requests (2 minutes) */
export const EMBEDDING_TIMEOUT_MS = 120000;

/** Maximum URLs to crawl from a sitemap */
export const MAX_SITEMAP_URLS = 100;

/** Maximum files to process from a folder */
export const MAX_FOLDER_FILES = 500;

/** Rate limit delay between API calls (ms) */
export const RATE_LIMIT_DELAY_MS = 100;

/** Cost per 1M tokens for text-embedding-3-small */
export const EMBEDDING_COST_PER_1M_TOKENS = 0.02;

/** PID file name for persistence across restarts */
export const SERVER_PID_FILE = ".server.pid";

/** Reciprocal Rank Fusion constant - balances keyword and semantic contributions */
export const RRF_CONSTANT = 60;

// ============================================================================
// Template Location
// ============================================================================

const __toolsDir = pathDirname(pathDirname(fileURLToPath(import.meta.url)));

/**
 * Templates live next to the compiled tools (dist/templates) and next to the
 * sources under tsx (src/templates). Both resolve the same way from here.
 */
export const TEMPLATES_DIR = path.join(pathDirname(__toolsDir), "templates");

// ============================================================================
// Build Metrics Tracking
// ============================================================================

export interface BuildMetrics {
  startTime: number;
  sourcesProcessed: number;
  sourcesFailed: number;
  chunksCreated: number;
  vectorsCreated: number;
  tokensUsed: number;
  estimatedCostUsd: number;
  phaseTimings: Record<string, number>;
}

export function createBuildMetrics(): BuildMetrics {
  return {
    startTime: Date.now(),
    sourcesProcessed: 0,
    sourcesFailed: 0,
    chunksCreated: 0,
    vectorsCreated: 0,
    tokensUsed: 0,
    estimatedCostUsd: 0,
    phaseTimings: {},
  };
}

export function logMetric(
  phase: string,
  message: string,
  data?: Record<string, unknown>
): void {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      phase,
      message,
      ...data,
    })
  );
}

// ============================================================================
// Project Manager
// ============================================================================

let projectsBaseDir: string;

export function initProjectManager(baseDir: string): void {
  projectsBaseDir = path.join(baseDir, "projects");
}

export function getProjectsBaseDir(): string {
  return projectsBaseDir;
}

export function getProjectDir(projectId: string): string {
  return path.join(projectsBaseDir, projectId);
}

export interface ProjectPaths {
  root: string;
  manifest: string;
  sources: string;
  data: string;
  chunks: string;
  vectors: string;
  runs: string;
  src: string;
}

export function getProjectPaths(projectId: string): ProjectPaths {
  const dir = getProjectDir(projectId);
  return {
    root: dir,
    manifest: path.join(dir, "project.json"),
    sources: path.join(dir, "sources.jsonl"),
    data: path.join(dir, "data"),
    chunks: path.join(dir, "data", "chunks.jsonl"),
    vectors: path.join(dir, "data", "vectors.jsonl"),
    runs: path.join(dir, "runs"),
    src: path.join(dir, "src"),
  };
}
