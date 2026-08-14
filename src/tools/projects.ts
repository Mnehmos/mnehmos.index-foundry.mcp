/**
 * IndexFoundry Project Tools
 *
 * High-level project management for RAG pipelines:
 * - Project creation and configuration
 * - Source management (URL, sitemap, folder, PDF)
 * - Build process (fetch â†’ chunk â†’ embed â†’ index)
 * - Query interface
 * - Deployment export
 *
 * Copyright (c) 2024 vario.automation
 * Proprietary and confidential. All rights reserved.
 *
 * This source code is the property of vario.automation and is protected
 * by trade secret and copyright law. Unauthorized copying, modification,
 * distribution, or use of this software is strictly prohibited.
 */

import path from "path";
import { existsSync, readFileSync } from "fs";
import { v4 as uuidv4 } from "uuid";
import pdfParse from "pdf-parse";
import { extractTextFromResponse } from "./binary-handler.js";
import {
  ProjectCreateInput,
  ProjectListInput,
  ProjectGetInput,
  ProjectDeleteInput,
  ProjectAddSourceInput,
  ProjectBuildInput,
  ProjectQueryInput,
  ProjectExportInput,
  ProjectDeployInput,
  ProjectServeInput,
  ProjectServeStopInput,
  ProjectServeStatusInput,
  ProjectRemoveSourceInput,
  ProjectManifest,
  SourceRecord,
  ChunkRecord,
  VectorRecord,
  EmbeddingModel,
  // ADR-006: Build chunking types
  ChunkOptions,
  BuildCheckpoint,
  ProjectBuildStatusInput,
} from "../schemas-projects.js";
import type { ChildProcess } from "child_process";
import {
  ensureDir,
  pathExists,
  readJson,
  writeJson,
  readJsonl,
  appendJsonl,
  writeJsonl,
  createToolError,
  now,
  sha256,
  cosineSimilarity,
} from "../utils.js";
import {
  runCommand,
  spawnDetached,
  openInBrowser,
  isValidEnvVarName,
} from "../process-utils.js";
// The retrieval algorithms are shared verbatim with exported projects.
import { buildSearchContext, searchHybrid } from "../templates/server/search.js";
import type { ToolError } from "../types.js";

// ============================================================================
// Shared Configuration
// ============================================================================
//
// Constants, path resolution, metrics and the project-manager base directory
// now live in ./projects/config.ts so the serve and deploy modules can share
// them. Re-exported here to keep the existing public surface intact.

export {
  initProjectManager,
  RRF_CONSTANT,
} from "./projects/config.js";

import {
  getProjectsBaseDir,
  MAX_FILE_SIZE_BYTES,
  MAX_FOLDER_FILE_SIZE_BYTES,
  DEFAULT_TIMEOUT_MS,
  EMBEDDING_TIMEOUT_MS,
  MAX_SITEMAP_URLS,
  MAX_FOLDER_FILES,
  RATE_LIMIT_DELAY_MS,
  EMBEDDING_COST_PER_1M_TOKENS,
  SERVER_PID_FILE,
  TEMPLATES_DIR,
  createBuildMetrics,
  logMetric,
  getProjectDir,
  getProjectPaths,
  type BuildMetrics,
} from "./projects/config.js";

// ============================================================================
// Project Create
// ============================================================================

export interface ProjectCreateResult {
  success: true;
  project_id: string;
  path: string;
  message: string;
}

export async function projectCreate(input: ProjectCreateInput): Promise<ProjectCreateResult | ToolError> {
  const paths = getProjectPaths(input.project_id);
  
  // Check if exists
  if (await pathExists(paths.manifest)) {
    return createToolError("PROJECT_EXISTS", `Project '${input.project_id}' already exists`, {
      recoverable: true,
    });
  }
  
  try {
    // Create directory structure
    await ensureDir(paths.root);
    await ensureDir(paths.data);
    await ensureDir(paths.runs);
    await ensureDir(paths.src);
    
    // Initialize manifest
    const manifest: ProjectManifest = {
      project_id: input.project_id,
      name: input.name,
      description: input.description,
      created_at: now(),
      updated_at: now(),
      embedding_model: input.embedding_model,
      chunk_config: input.chunk_config,
      stats: {
        sources_count: 0,
        chunks_count: 0,
        vectors_count: 0,
        total_tokens: 0,
      },
    };
    
    await writeJson(paths.manifest, manifest);
    
    // Initialize empty sources file
    await writeJsonl(paths.sources, []);
    
    // Generate deployment files
    await generateDeploymentFiles(input.project_id, manifest);
    
    return {
      success: true,
      project_id: input.project_id,
      path: paths.root,
      message: `Project '${input.name}' created. Add sources with project_add_source.`,
    };
  } catch (err) {
    return createToolError("CREATE_FAILED", `Failed to create project: ${err}`, {
      recoverable: false,
    });
  }
}

// ============================================================================
// Project List
// ============================================================================

export interface ProjectListResult {
  success: true;
  projects: Array<{
    project_id: string;
    name: string;
    created_at: string;
    stats?: ProjectManifest["stats"];
  }>;
  total: number;
}

export async function projectList(input: ProjectListInput): Promise<ProjectListResult | ToolError> {
  try {
    await ensureDir(getProjectsBaseDir());
    
    const { readdir } = await import("fs/promises");
    const entries = await readdir(getProjectsBaseDir(), { withFileTypes: true });
    
    const projects: ProjectListResult["projects"] = [];
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      const manifestPath = path.join(getProjectsBaseDir(), entry.name, "project.json");
      if (!(await pathExists(manifestPath))) continue;
      
      const manifest = await readJson<ProjectManifest>(manifestPath);
      projects.push({
        project_id: manifest.project_id,
        name: manifest.name,
        created_at: manifest.created_at,
        stats: input.include_stats ? manifest.stats : undefined,
      });
    }
    
    return {
      success: true,
      projects,
      total: projects.length,
    };
  } catch (err) {
    return createToolError("LIST_FAILED", `Failed to list projects: ${err}`, {
      recoverable: true,
    });
  }
}

// ============================================================================
// Project Get
// ============================================================================

export interface ProjectGetResult {
  success: true;
  manifest: ProjectManifest;
  sources: SourceRecord[];
  path: string;
}

export async function projectGet(input: ProjectGetInput): Promise<ProjectGetResult | ToolError> {
  const paths = getProjectPaths(input.project_id);
  
  if (!(await pathExists(paths.manifest))) {
    return createToolError("NOT_FOUND", `Project '${input.project_id}' not found`, {
      recoverable: false,
    });
  }
  
  try {
    const manifest = await readJson<ProjectManifest>(paths.manifest);
    const sources = await pathExists(paths.sources) 
      ? await readJsonl<SourceRecord>(paths.sources)
      : [];
    
    return {
      success: true,
      manifest,
      sources,
      path: paths.root,
    };
  } catch (err) {
    return createToolError("READ_FAILED", `Failed to read project: ${err}`, {
      recoverable: true,
    });
  }
}

// ============================================================================
// Project Delete
// ============================================================================

export interface ProjectDeleteResult {
  success: true;
  project_id: string;
  message: string;
}

export async function projectDelete(input: ProjectDeleteInput): Promise<ProjectDeleteResult | ToolError> {
  if (!input.confirm) {
    return createToolError("NOT_CONFIRMED", "Set confirm: true to delete project", {
      recoverable: true,
    });
  }
  
  const paths = getProjectPaths(input.project_id);
  
  if (!(await pathExists(paths.root))) {
    return createToolError("NOT_FOUND", `Project '${input.project_id}' not found`, {
      recoverable: false,
    });
  }
  
  try {
    const { rm } = await import("fs/promises");
    await rm(paths.root, { recursive: true, force: true });
    
    return {
      success: true,
      project_id: input.project_id,
      message: `Project '${input.project_id}' deleted`,
    };
  } catch (err) {
    return createToolError("DELETE_FAILED", `Failed to delete project: ${err}`, {
      recoverable: false,
    });
  }
}

// ============================================================================
// Project Add Source (with ADR-005 Batch Support)
// ============================================================================

export interface ProjectAddSourceResult {
  success: true;
  source_id: string;
  type: string;
  uri: string;
  message: string;
}

/** ADR-005: Batch add result type */
export interface BatchAddResult {
  success: true;
  project_id: string;
  added: Array<{ source_id: string; type: string; uri: string }>;
  skipped: Array<{ uri: string; reason: string }>;
  message: string;
}

/** Helper to determine source type and URI from input */
function getSourceTypeAndUri(item: {
  url?: string;
  sitemap_url?: string;
  folder_path?: string;
  pdf_path?: string;
}): { type: SourceRecord["type"]; uri: string } | null {
  if (item.url) return { type: "url", uri: item.url };
  if (item.sitemap_url) return { type: "sitemap", uri: item.sitemap_url };
  if (item.folder_path) return { type: "folder", uri: item.folder_path };
  if (item.pdf_path) return { type: "pdf", uri: item.pdf_path };
  return null;
}

export async function projectAddSource(input: ProjectAddSourceInput): Promise<ProjectAddSourceResult | BatchAddResult | ToolError> {
  const paths = getProjectPaths(input.project_id);
  
  if (!(await pathExists(paths.manifest))) {
    return createToolError("NOT_FOUND", `Project '${input.project_id}' not found`, {
      recoverable: false,
    });
  }
  
  // ADR-005: Check for mutual exclusivity
  const hasSingleSource = Boolean(input.url || input.sitemap_url || input.folder_path || input.pdf_path);
  const hasBatch = input.batch && input.batch.length > 0;
  
  if (hasSingleSource && hasBatch) {
    return createToolError("MUTUAL_EXCLUSIVITY", "Cannot provide both single source parameters and batch array", {
      recoverable: true,
    });
  }
  
  if (!hasSingleSource && !hasBatch) {
    return createToolError("NO_SOURCE", "Must provide url, sitemap_url, folder_path, pdf_path, OR batch array", {
      recoverable: true,
    });
  }
  
  // ADR-005: Handle batch mode
  if (hasBatch) {
    return handleBatchAdd(input.project_id, input.batch!, paths);
  }
  
  // Single source mode (original behavior)
  const sourceInfo = getSourceTypeAndUri(input);
  if (!sourceInfo) {
    return createToolError("NO_SOURCE", "Must provide url, sitemap_url, folder_path, or pdf_path", {
      recoverable: true,
    });
  }
  
  const { type: sourceType, uri } = sourceInfo;
  
  try {
    // Check for duplicate
    const existingSources = await readJsonl<SourceRecord>(paths.sources);
    const duplicate = existingSources.find(s => s.uri === uri && s.type === sourceType);
    if (duplicate) {
      return createToolError("DUPLICATE_SOURCE", `Source already exists: ${uri}`, {
        recoverable: true,
      });
    }
    
    // Create source record
    const sourceId = sha256(Buffer.from(`${sourceType}:${uri}`)).slice(0, 16);
    const source: SourceRecord = {
      source_id: sourceId,
      type: sourceType,
      uri,
      source_name: input.source_name,
      tags: input.tags || [],
      added_at: now(),
      status: "pending",
    };
    
    // Append to sources
    await appendJsonl(paths.sources, [source]);
    
    // Update manifest
    const manifest = await readJson<ProjectManifest>(paths.manifest);
    manifest.stats.sources_count++;
    manifest.updated_at = now();
    await writeJson(paths.manifest, manifest);
    
    return {
      success: true,
      source_id: sourceId,
      type: sourceType,
      uri,
      message: `Source added. Run project_build to process.`,
    };
  } catch (err) {
    return createToolError("ADD_FAILED", `Failed to add source: ${err}`, {
      recoverable: true,
    });
  }
}

/** Validate URL is safe (http/https, no localhost) */
function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    const blockedHosts = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"];
    if (blockedHosts.some(h => parsed.hostname === h || parsed.hostname.endsWith("." + h))) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** ADR-005: Handle batch add of multiple sources */
async function handleBatchAdd(
  projectId: string,
  batch: NonNullable<ProjectAddSourceInput["batch"]>,
  paths: ReturnType<typeof getProjectPaths>
): Promise<BatchAddResult | ToolError> {
  try {
    const existingSources = await readJsonl<SourceRecord>(paths.sources);
    const existingUris = new Set(existingSources.map(s => `${s.type}:${s.uri}`));
    
    const added: BatchAddResult["added"] = [];
    const skipped: BatchAddResult["skipped"] = [];
    const newSources: SourceRecord[] = [];
    
    // Track URIs added in this batch to detect duplicates within batch
    const batchUris = new Set<string>();
    
    for (const item of batch) {
      const sourceInfo = getSourceTypeAndUri(item);
      
      if (!sourceInfo) {
        skipped.push({ uri: "unknown", reason: "invalid" });
        continue;
      }
      
      const { type: sourceType, uri } = sourceInfo;
      
      // Validate URLs
      if ((sourceType === "url" || sourceType === "sitemap") && !isValidUrl(uri)) {
        skipped.push({ uri, reason: "invalid" });
        continue;
      }
      
      const uriKey = `${sourceType}:${uri}`;
      
      // Check for duplicate against existing sources
      if (existingUris.has(uriKey)) {
        skipped.push({ uri, reason: "duplicate" });
        continue;
      }
      
      // Check for duplicate within this batch
      if (batchUris.has(uriKey)) {
        skipped.push({ uri, reason: "duplicate" });
        continue;
      }
      
      batchUris.add(uriKey);
      
      // Create source record
      const sourceId = sha256(Buffer.from(uriKey)).slice(0, 16);
      const source: SourceRecord = {
        source_id: sourceId,
        type: sourceType,
        uri,
        source_name: item.source_name,
        tags: item.tags || [],
        added_at: now(),
        status: "pending",
      };
      
      newSources.push(source);
      added.push({ source_id: sourceId, type: sourceType, uri });
    }
    
    // Append all new sources at once
    if (newSources.length > 0) {
      await appendJsonl(paths.sources, newSources);
      
      // Update manifest
      const manifest = await readJson<ProjectManifest>(paths.manifest);
      manifest.stats.sources_count += newSources.length;
      manifest.updated_at = now();
      await writeJson(paths.manifest, manifest);
    }
    
    return {
      success: true,
      project_id: projectId,
      added,
      skipped,
      message: `Added ${added.length} sources, skipped ${skipped.length}. Run project_build to process.`,
    };
  } catch (err) {
    return createToolError("BATCH_ADD_FAILED", `Failed to batch add sources: ${err}`, {
      recoverable: true,
    });
  }
}

// ============================================================================
// Project Remove Source (ADR-005)
// ============================================================================

export interface RemoveSourceResult {
  success: true;
  project_id: string;
  removed: Array<{
    source_id: string;
    uri: string;
    chunks_removed: number;
    vectors_removed: number;
  }>;
  not_found: string[];
  message: string;
}

export async function projectRemoveSource(input: ProjectRemoveSourceInput): Promise<RemoveSourceResult | ToolError> {
  const paths = getProjectPaths(input.project_id);
  
  // Apply defaults for cascade options (schema defaults are: remove_chunks=true, remove_vectors=true, confirm=false)
  const removeChunks = input.remove_chunks ?? true;
  const removeVectors = input.remove_vectors ?? true;
  const confirm = input.confirm ?? false;
  
  if (!(await pathExists(paths.manifest))) {
    return createToolError("NOT_FOUND", `Project '${input.project_id}' not found`, {
      recoverable: false,
    });
  }
  
  // Determine what to remove
  const hasSingleSource = Boolean(input.source_id || input.source_uri);
  const hasBatch = input.batch && input.batch.length > 0;
  
  if (!hasSingleSource && !hasBatch) {
    return createToolError("NO_SOURCE", "Must provide source_id, source_uri, OR batch array", {
      recoverable: true,
    });
  }
  
  // Check confirmation for cascade deletion
  const needsConfirmation = removeChunks || removeVectors;
  if (needsConfirmation && !confirm) {
    return createToolError("CONFIRMATION_REQUIRED", "Set confirm: true to remove source and associated chunks/vectors", {
      recoverable: true,
    });
  }
  
  // Helper for reading with retry (handles concurrent access)
  async function readWithRetry<T>(filePath: string, maxRetries = 3): Promise<T[]> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        if (!(await pathExists(filePath))) return [];
        return await readJsonl<T>(filePath);
      } catch (err) {
        if (i === maxRetries - 1) return []; // Return empty on final failure instead of throwing
        await new Promise(resolve => setTimeout(resolve, 10 * (i + 1)));
      }
    }
    return [];
  }
  
  try {
    const existingSources = await readWithRetry<SourceRecord>(paths.sources);
    
    // Build list of sources to find
    const toFind: Array<{ source_id?: string; source_uri?: string }> = [];
    if (hasSingleSource) {
      toFind.push({ source_id: input.source_id, source_uri: input.source_uri });
    }
    if (hasBatch) {
      toFind.push(...input.batch!);
    }
    
    const removed: RemoveSourceResult["removed"] = [];
    const notFound: string[] = [];
    const sourceIdsToRemove: string[] = [];
    
    // Find matching sources
    for (const item of toFind) {
      const source = existingSources.find(s =>
        (item.source_id && s.source_id === item.source_id) ||
        (item.source_uri && s.uri === item.source_uri)
      );
      
      const identifier = item.source_id || item.source_uri || "unknown";
      
      if (!source) {
        notFound.push(identifier);
        continue;
      }
      
      // Check if source is currently processing
      if (source.status === "processing") {
        return createToolError("SOURCE_PROCESSING", `Cannot remove source '${source.source_id}' while it is being processed`, {
          recoverable: true,
        });
      }
      
      sourceIdsToRemove.push(source.source_id);
      removed.push({
        source_id: source.source_id,
        uri: source.uri,
        chunks_removed: 0,
        vectors_removed: 0,
      });
    }
    
    // Cascade delete chunks and vectors if requested
    if (sourceIdsToRemove.length > 0 && (removeChunks || removeVectors)) {
      const sourceIdSet = new Set(sourceIdsToRemove);
      
      // Build mapping of chunk_id -> source_id for vector removal
      const chunkToSourceMap = new Map<string, string>();
      const chunkIdsToRemove = new Set<string>();
      
      // First pass: identify chunks to remove
      if (await pathExists(paths.chunks)) {
        const existingChunks = await readJsonl<ChunkRecord>(paths.chunks);
        
        for (const chunk of existingChunks) {
          if (sourceIdSet.has(chunk.source_id)) {
            chunkIdsToRemove.add(chunk.chunk_id);
            chunkToSourceMap.set(chunk.chunk_id, chunk.source_id);
          }
        }
        
        // Remove chunks if requested
        if (removeChunks) {
          const remainingChunks: ChunkRecord[] = [];
          for (const chunk of existingChunks) {
            if (sourceIdSet.has(chunk.source_id)) {
              const entry = removed.find(r => r.source_id === chunk.source_id);
              if (entry) entry.chunks_removed++;
            } else {
              remainingChunks.push(chunk);
            }
          }
          await writeJsonl(paths.chunks, remainingChunks);
        }
      }
      
      // Remove vectors for chunks from removed sources
      if (removeVectors && await pathExists(paths.vectors)) {
        const existingVectors = await readJsonl<VectorRecord>(paths.vectors);
        const remainingVectors: VectorRecord[] = [];
        
        for (const vector of existingVectors) {
          if (chunkIdsToRemove.has(vector.chunk_id)) {
            const sourceId = chunkToSourceMap.get(vector.chunk_id);
            if (sourceId) {
              const entry = removed.find(r => r.source_id === sourceId);
              if (entry) entry.vectors_removed++;
            }
          } else {
            remainingVectors.push(vector);
          }
        }
        
        await writeJsonl(paths.vectors, remainingVectors);
      }
    }
    
    // Remove sources from sources.jsonl
    if (sourceIdsToRemove.length > 0) {
      const sourceIdSet = new Set(sourceIdsToRemove);
      const remainingSources = existingSources.filter(s => !sourceIdSet.has(s.source_id));
      
      // Write with retry for concurrent access
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await writeJsonl(paths.sources, remainingSources);
          break;
        } catch (err) {
          if (attempt === 2) throw err;
          await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
        }
      }
      
      // Update manifest stats with retry
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const manifest = await readJson<ProjectManifest>(paths.manifest);
          manifest.stats.sources_count = remainingSources.length;
          
          // Recalculate chunk and vector counts if we removed them
          if (removeChunks && await pathExists(paths.chunks)) {
            const remainingChunks = await readJsonl<ChunkRecord>(paths.chunks);
            manifest.stats.chunks_count = remainingChunks.length;
          }
          if (removeVectors && await pathExists(paths.vectors)) {
            const remainingVectors = await readJsonl<VectorRecord>(paths.vectors);
            manifest.stats.vectors_count = remainingVectors.length;
          }
          
          manifest.updated_at = now();
          await writeJson(paths.manifest, manifest);
          break;
        } catch (err) {
          if (attempt === 2) throw err;
          await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
        }
      }
    }
    
    const totalChunks = removed.reduce((sum, r) => sum + r.chunks_removed, 0);
    const totalVectors = removed.reduce((sum, r) => sum + r.vectors_removed, 0);
    
    return {
      success: true,
      project_id: input.project_id,
      removed,
      not_found: notFound,
      message: `Removed ${removed.length} source(s), ${totalChunks} chunks, ${totalVectors} vectors. ${notFound.length} not found.`,
    };
  } catch (err) {
    return createToolError("REMOVE_FAILED", `Failed to remove sources: ${err}`, {
      recoverable: true,
    });
  }
}

// ============================================================================
// Project Build
// ============================================================================

/** ADR-006: Enhanced build result with progress and metrics */
export interface ProjectBuildResult {
  success: true;
  sources_processed: number;
  chunks_added: number;
  vectors_added: number;
  errors: Array<{ source_id: string; error: string }>;
  message: string;
  
  /** ADR-006: Progress tracking for chunked builds */
  progress: {
    total_sources: number;
    processed_this_run: number;
    remaining: number;
    has_more: boolean;
    checkpoint_id?: string;
    estimated_remaining_ms?: number;
  };
  
  /** ADR-006: Build metrics for performance analysis */
  metrics: {
    duration_ms: number;
    fetch_time_ms: number;
    chunk_time_ms: number;
    embed_time_ms: number;
    tokens_used: number;
    estimated_cost_usd: number;
    avg_source_time_ms: number;
  };
}

/** ADR-006: Build status result for checking build state */
export interface ProjectBuildStatusResult {
  success: true;
  project_id: string;
  state: "idle" | "in_progress" | "checkpoint_available";
  checkpoint?: {
    checkpoint_id: string;
    created_at: string;
    sources_completed: number;
    sources_remaining: number;
    chunks_so_far: number;
    vectors_so_far: number;
  };
  pending_sources: number;
  failed_sources: number;
  recommendation: string;
}

// ============================================================================
// ADR-006: Checkpoint Management Helpers
// ============================================================================

/** Get the checkpoint directory path for a project */
function getCheckpointDir(projectId: string): string {
  const paths = getProjectPaths(projectId);
  return path.join(paths.data, "checkpoints");
}

/** Get the latest checkpoint file path */
function getCheckpointPath(projectId: string): string {
  return path.join(getCheckpointDir(projectId), "latest.json");
}

/** Save a checkpoint to disk */
async function saveCheckpoint(projectId: string, checkpoint: BuildCheckpoint): Promise<void> {
  const checkpointDir = getCheckpointDir(projectId);
  await ensureDir(checkpointDir);
  const checkpointPath = getCheckpointPath(projectId);
  await writeJson(checkpointPath, checkpoint);
}

/** Load checkpoint from disk if it exists */
async function loadCheckpoint(projectId: string): Promise<BuildCheckpoint | null> {
  const checkpointPath = getCheckpointPath(projectId);
  if (!(await pathExists(checkpointPath))) {
    return null;
  }
  try {
    return await readJson<BuildCheckpoint>(checkpointPath);
  } catch {
    return null;
  }
}

/** Clear checkpoint after successful completion */
async function clearCheckpoint(projectId: string): Promise<void> {
  const checkpointPath = getCheckpointPath(projectId);
  try {
    const { unlink } = await import("fs/promises");
    await unlink(checkpointPath);
  } catch {
    // Ignore if doesn't exist
  }
}

/** Get default chunk options with values from ADR-006 */
function getDefaultChunkOptions(): Required<ChunkOptions> {
  return {
    max_sources_per_build: 10,
    fetch_concurrency: 3,
    embedding_batch_size: 50,
    enable_checkpointing: true,
    build_timeout_ms: 300000,
    timeout_strategy: "checkpoint" as const,
  };
}

export async function projectBuild(input: ProjectBuildInput): Promise<ProjectBuildResult | ToolError> {
  const paths = getProjectPaths(input.project_id);
  
  if (!(await pathExists(paths.manifest))) {
    return createToolError("NOT_FOUND", `Project '${input.project_id}' not found`, {
      recoverable: false,
    });
  }
  
  try {
    const manifest = await readJson<ProjectManifest>(paths.manifest);
    const allSources = await readJsonl<SourceRecord>(paths.sources);
    
    // ADR-006: Get chunk options with defaults
    const chunkOptions: Required<ChunkOptions> = {
      ...getDefaultChunkOptions(),
      ...input.chunk_options,
    };
    
    // ADR-006: Load checkpoint if resuming
    let existingCheckpoint: BuildCheckpoint | null = null;
    let completedSourceIds = new Set<string>();
    let resumedChunks = 0;
    let resumedVectors = 0;
    let resumedTokens = 0;
    let resumedDuration = 0;
    
    if (input.resume_from_checkpoint) {
      existingCheckpoint = await loadCheckpoint(input.project_id);
      if (existingCheckpoint) {
        completedSourceIds = new Set(existingCheckpoint.completed_source_ids);
        resumedChunks = existingCheckpoint.stats.chunks_added;
        resumedVectors = existingCheckpoint.stats.vectors_added;
        resumedTokens = existingCheckpoint.stats.tokens_used;
        resumedDuration = existingCheckpoint.stats.duration_ms;
        logMetric("checkpoint", "Resuming from checkpoint", {
          checkpoint_id: existingCheckpoint.checkpoint_id,
          completed_sources: completedSourceIds.size,
        });
      }
    }
    
    // Find sources to process (excluding already completed from checkpoint)
    const allPending = allSources.filter(s => {
      // Skip completed sources from checkpoint
      if (completedSourceIds.has(s.source_id)) return false;
      // Include pending/failed sources, or all if force is set
      return input.force ? true : s.status === "pending" || s.status === "failed";
    });
    
    // Count total sources (for progress calculation)
    const totalSources = allSources.length;
    const failedSources = allSources.filter(s => s.status === "failed").length;
    
    // ADR-006: Limit sources per build
    const sourcesToProcess = allPending.slice(0, chunkOptions.max_sources_per_build);
    const remainingAfterThisRun = allPending.length - sourcesToProcess.length;
    
    // Create default progress and metrics for early returns
    const createEmptyResult = (message: string): ProjectBuildResult => ({
      success: true,
      sources_processed: 0,
      chunks_added: 0,
      vectors_added: 0,
      errors: [],
      message,
      progress: {
        total_sources: totalSources,
        processed_this_run: 0,
        remaining: allPending.length,
        has_more: allPending.length > 0,
      },
      metrics: {
        duration_ms: 0,
        fetch_time_ms: 0,
        chunk_time_ms: 0,
        embed_time_ms: 0,
        tokens_used: 0,
        estimated_cost_usd: 0,
        avg_source_time_ms: 0,
      },
    });
    
    if (input.dry_run) {
      return createEmptyResult(`Dry run: would process ${sourcesToProcess.length} of ${allPending.length} pending sources`);
    }
    
    if (sourcesToProcess.length === 0) {
      // Clear checkpoint if no more pending
      if (chunkOptions.enable_checkpointing) {
        await clearCheckpoint(input.project_id);
      }
      return createEmptyResult("No pending sources to process");
    }
    
    const buildMetrics = createBuildMetrics();
    let totalFetchTime = 0;
    let totalChunkTime = 0;
    let totalEmbedTime = 0;
    
    const result: ProjectBuildResult = {
      success: true,
      sources_processed: 0,
      chunks_added: resumedChunks,
      vectors_added: resumedVectors,
      errors: [],
      message: "",
      progress: {
        total_sources: totalSources,
        processed_this_run: 0,
        remaining: remainingAfterThisRun,
        has_more: remainingAfterThisRun > 0,
      },
      metrics: {
        duration_ms: 0,
        fetch_time_ms: 0,
        chunk_time_ms: 0,
        embed_time_ms: 0,
        tokens_used: resumedTokens,
        estimated_cost_usd: 0,
        avg_source_time_ms: 0,
      },
    };

    logMetric("build", "Starting build", {
      project: input.project_id,
      sources_this_run: sourcesToProcess.length,
      total_pending: allPending.length,
      max_sources_per_build: chunkOptions.max_sources_per_build,
    });

    // Load existing chunks to get max index and existing content hashes
    let existingChunks: ChunkRecord[] = [];
    const existingHashes = new Set<string>();
    if (await pathExists(paths.chunks)) {
      existingChunks = await readJsonl<ChunkRecord>(paths.chunks);
      // Build hash set for deduplication
      for (const chunk of existingChunks) {
        if (chunk.metadata?.content_hash) {
          existingHashes.add(chunk.metadata.content_hash as string);
        } else {
          // Generate hash for older chunks without it
          const hash = sha256(Buffer.from(chunk.text)).slice(0, 16);
          existingHashes.add(hash);
        }
      }
    }
    let chunkIndex = existingChunks.length;

    // Track completed sources for checkpoint
    const newlyCompletedSourceIds: string[] = [...completedSourceIds];

    // ADR-006: Process sources with concurrency control
    // For simplicity, process sequentially but track timing accurately
    // Future enhancement: implement Promise pool for true concurrency
    for (const source of sourcesToProcess) {
      const sourceStart = Date.now();
      try {
        logMetric("fetch", `Processing source`, { source_id: source.source_id, type: source.type, uri: source.uri });

        // Update source status
        source.status = "processing";

        // Fetch content based on type
        const fetchStart = Date.now();
        const content = await fetchSource(source, paths.runs);
        const fetchDuration = Date.now() - fetchStart;
        buildMetrics.phaseTimings[`fetch_${source.source_id}`] = fetchDuration;
        totalFetchTime += fetchDuration;

        // Chunk the content
        const chunkStart = Date.now();
        const newChunks = chunkContent(
          content,
          source.source_id,
          manifest.chunk_config,
          chunkIndex,
          existingHashes
        );
        chunkIndex += newChunks.length;
        const chunkDuration = Date.now() - chunkStart;
        buildMetrics.phaseTimings[`chunk_${source.source_id}`] = chunkDuration;
        totalChunkTime += chunkDuration;

        // Generate embeddings
        const embedStart = Date.now();
        const embedResult = await embedChunks(newChunks, manifest.embedding_model);
        const embedDuration = Date.now() - embedStart;
        buildMetrics.phaseTimings[`embed_${source.source_id}`] = embedDuration;
        totalEmbedTime += embedDuration;
        buildMetrics.tokensUsed += embedResult.tokensUsed;
        buildMetrics.estimatedCostUsd += embedResult.estimatedCostUsd;

        // Append to data files
        if (newChunks.length > 0) {
          await appendJsonl(paths.chunks, newChunks);
          await appendJsonl(paths.vectors, embedResult.vectors);
        }

        // Update source record
        source.status = "completed";
        source.processed_at = now();
        source.stats = {
          files_fetched: 1,
          chunks_created: newChunks.length,
          vectors_created: embedResult.vectors.length,
        };

        result.sources_processed++;
        result.chunks_added += newChunks.length;
        result.vectors_added += embedResult.vectors.length;
        buildMetrics.sourcesProcessed++;
        buildMetrics.chunksCreated += newChunks.length;
        buildMetrics.vectorsCreated += embedResult.vectors.length;
        
        // Track for checkpoint
        newlyCompletedSourceIds.push(source.source_id);

        logMetric("source", "Source complete", {
          source_id: source.source_id,
          chunks: newChunks.length,
          vectors: embedResult.vectors.length,
          duration_ms: Date.now() - sourceStart,
        });

        // ADR-006: Save checkpoint after each source if enabled
        if (chunkOptions.enable_checkpointing) {
          const checkpoint: BuildCheckpoint = {
            checkpoint_id: uuidv4(),
            project_id: input.project_id,
            created_at: now(),
            completed_source_ids: newlyCompletedSourceIds,
            stats: {
              chunks_added: result.chunks_added,
              vectors_added: result.vectors_added,
              tokens_used: buildMetrics.tokensUsed + resumedTokens,
              duration_ms: Date.now() - buildMetrics.startTime + resumedDuration,
            },
          };
          await saveCheckpoint(input.project_id, checkpoint);
          result.progress.checkpoint_id = checkpoint.checkpoint_id;
        }

      } catch (err) {
        source.status = "failed";
        source.error = String(err);
        result.errors.push({
          source_id: source.source_id,
          error: String(err),
        });
        buildMetrics.sourcesFailed++;

        logMetric("error", "Source failed", {
          source_id: source.source_id,
          error: String(err),
          duration_ms: Date.now() - sourceStart,
        });
        
        // ADR-006: Save checkpoint after failed source too (tracks processed sources)
        // Note: failed sources are still "processed" - we track them in checkpoint
        newlyCompletedSourceIds.push(source.source_id);
        if (chunkOptions.enable_checkpointing) {
          const checkpoint: BuildCheckpoint = {
            checkpoint_id: uuidv4(),
            project_id: input.project_id,
            created_at: now(),
            completed_source_ids: newlyCompletedSourceIds,
            stats: {
              chunks_added: result.chunks_added,
              vectors_added: result.vectors_added,
              tokens_used: buildMetrics.tokensUsed + resumedTokens,
              duration_ms: Date.now() - buildMetrics.startTime + resumedDuration,
            },
          };
          await saveCheckpoint(input.project_id, checkpoint);
          result.progress.checkpoint_id = checkpoint.checkpoint_id;
        }
      }
    }

    // Rewrite sources file with updated statuses
    await writeJsonl(paths.sources, allSources);

    // Update manifest stats
    manifest.stats.chunks_count += result.chunks_added - resumedChunks;
    manifest.stats.vectors_count += result.vectors_added - resumedVectors;
    manifest.stats.total_tokens += buildMetrics.tokensUsed;
    manifest.updated_at = now();
    await writeJson(paths.manifest, manifest);

    const totalDuration = Date.now() - buildMetrics.startTime;
    
    // ADR-006: Update progress
    // processed_this_run counts all sources attempted (successful + failed)
    result.progress.processed_this_run = result.sources_processed + result.errors.length;
    result.progress.remaining = remainingAfterThisRun;
    result.progress.has_more = remainingAfterThisRun > 0;
    
    // ADR-006: Estimate remaining time
    if (result.sources_processed > 0 && remainingAfterThisRun > 0) {
      const avgSourceTime = totalDuration / result.sources_processed;
      result.progress.estimated_remaining_ms = Math.round(avgSourceTime * remainingAfterThisRun);
    }
    
    // ADR-006: Update metrics
    result.metrics = {
      duration_ms: totalDuration + resumedDuration,
      fetch_time_ms: totalFetchTime,
      chunk_time_ms: totalChunkTime,
      embed_time_ms: totalEmbedTime,
      tokens_used: buildMetrics.tokensUsed + resumedTokens,
      estimated_cost_usd: (buildMetrics.tokensUsed + resumedTokens) / 1_000_000 * EMBEDDING_COST_PER_1M_TOKENS,
      avg_source_time_ms: result.sources_processed > 0 ? Math.round(totalDuration / result.sources_processed) : 0,
    };
    
    // NOTE: Checkpoint is not cleared here - it persists as a record of the build.
    // Users can manually clear checkpoints or they're overwritten on next build.
    
    result.message = `Processed ${result.sources_processed} sources: +${result.chunks_added - resumedChunks} chunks, +${result.vectors_added - resumedVectors} vectors`;
    if (result.errors.length > 0) {
      result.message += ` (${result.errors.length} errors)`;
    }
    if (result.progress.has_more) {
      result.message += ` [${remainingAfterThisRun} remaining]`;
    }
    result.message += ` [${(totalDuration / 1000).toFixed(1)}s, ~$${result.metrics.estimated_cost_usd.toFixed(4)}]`;

    logMetric("build", "Build complete", {
      project: input.project_id,
      sources_processed: result.sources_processed,
      sources_failed: result.errors.length,
      chunks_added: result.chunks_added,
      vectors_added: result.vectors_added,
      tokens_used: result.metrics.tokens_used,
      estimated_cost_usd: result.metrics.estimated_cost_usd.toFixed(4),
      duration_ms: totalDuration,
      has_more: result.progress.has_more,
    });

    return result;
  } catch (err) {
    return createToolError("BUILD_FAILED", `Build failed: ${err}`, {
      recoverable: true,
    });
  }
}

/** ADR-006: Get build status and checkpoint information */
export async function projectBuildStatus(input: ProjectBuildStatusInput): Promise<ProjectBuildStatusResult | ToolError> {
  const paths = getProjectPaths(input.project_id);
  
  if (!(await pathExists(paths.manifest))) {
    return createToolError("NOT_FOUND", `Project '${input.project_id}' not found`, {
      recoverable: false,
    });
  }
  
  try {
    const sources = await readJsonl<SourceRecord>(paths.sources);
    const checkpoint = await loadCheckpoint(input.project_id);
    
    const pendingSources = sources.filter(s => s.status === "pending").length;
    const failedSources = sources.filter(s => s.status === "failed").length;
    const completedSources = sources.filter(s => s.status === "completed").length;
    const processingSources = sources.filter(s => s.status === "processing").length;
    
    let state: "idle" | "in_progress" | "checkpoint_available";
    let recommendation: string;
    
    if (processingSources > 0) {
      state = "in_progress";
      recommendation = "A build is currently in progress. Wait for it to complete.";
    } else if (checkpoint) {
      state = "checkpoint_available";
      recommendation = `Resume build with resume_from_checkpoint: true. ${checkpoint.completed_source_ids.length} sources already completed.`;
    } else if (pendingSources > 0 || failedSources > 0) {
      state = "idle";
      recommendation = `Run project_build to process ${pendingSources + failedSources} sources (${pendingSources} pending, ${failedSources} failed).`;
    } else {
      state = "idle";
      recommendation = "All sources are processed. Add new sources or use force: true to rebuild.";
    }
    
    const result: ProjectBuildStatusResult = {
      success: true,
      project_id: input.project_id,
      state,
      pending_sources: pendingSources,
      failed_sources: failedSources,
      recommendation,
    };
    
    if (checkpoint) {
      result.checkpoint = {
        checkpoint_id: checkpoint.checkpoint_id,
        created_at: checkpoint.created_at,
        sources_completed: checkpoint.completed_source_ids.length,
        sources_remaining: pendingSources + failedSources,
        chunks_so_far: checkpoint.stats.chunks_added,
        vectors_so_far: checkpoint.stats.vectors_added,
      };
    }
    
    return result;
  } catch (err) {
    return createToolError("STATUS_FAILED", `Failed to get build status: ${err}`, {
      recoverable: true,
    });
  }
}

// ============================================================================
// Project Query
// ============================================================================

export interface ProjectQueryResult {
  success: true;
  results: Array<{
    chunk_id: string;
    score: number;
    text: string;
    source_id: string;
    metadata: Record<string, unknown>;
  }>;
  total: number;
  mode: string;
}

export async function projectQuery(input: ProjectQueryInput): Promise<ProjectQueryResult | ToolError> {
  const paths = getProjectPaths(input.project_id);
  
  if (!(await pathExists(paths.manifest))) {
    return createToolError("NOT_FOUND", `Project '${input.project_id}' not found`, {
      recoverable: false,
    });
  }
  
  try {
    const manifest = await readJson<ProjectManifest>(paths.manifest);
    
    if (!(await pathExists(paths.chunks)) || !(await pathExists(paths.vectors))) {
      return {
        success: true,
        results: [],
        total: 0,
        mode: input.mode,
      };
    }
    
    const chunks = await readJsonl<ChunkRecord>(paths.chunks);
    const vectors = await readJsonl<VectorRecord>(paths.vectors);
    
    // Build chunk lookup
    const chunkMap = new Map(chunks.map(c => [c.chunk_id, c]));
    
    // Get query embedding
    const queryVector = await embedText(input.query, manifest.embedding_model);
    
    // Score all vectors
    let scored: Array<{ chunk_id: string; score: number }> = [];
    
    if (input.mode === "semantic" || input.mode === "hybrid") {
      scored = vectors.map(v => ({
        chunk_id: v.chunk_id,
        score: cosineSimilarity(queryVector, v.embedding),
      }));
    }
    
    if (input.mode === "keyword" || input.mode === "hybrid") {
      const queryTerms = input.query.toLowerCase().split(/\s+/);
      const keywordScores = chunks.map(c => {
        const text = c.text.toLowerCase();
        let matches = 0;
        for (const term of queryTerms) {
          if (text.includes(term)) matches++;
        }
        return {
          chunk_id: c.chunk_id,
          score: matches / queryTerms.length,
        };
      });
      
      if (input.mode === "keyword") {
        scored = keywordScores;
      } else {
        // Hybrid: combine scores
        const keywordMap = new Map(keywordScores.map(k => [k.chunk_id, k.score]));
        scored = scored.map(s => ({
          chunk_id: s.chunk_id,
          score: s.score * 0.7 + (keywordMap.get(s.chunk_id) || 0) * 0.3,
        }));
      }
    }
    
    // Sort and take top_k
    scored.sort((a, b) => b.score - a.score);
    const topResults = scored.slice(0, input.top_k);
    
    // Build results with chunk data
    const results = topResults
      .map(r => {
        const chunk = chunkMap.get(r.chunk_id);
        if (!chunk) return null;
        
        // Apply filters
        if (input.filter_sources && !input.filter_sources.includes(chunk.source_id)) {
          return null;
        }
        
        return {
          chunk_id: r.chunk_id,
          score: r.score,
          text: chunk.text,
          source_id: chunk.source_id,
          metadata: chunk.metadata,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    
    return {
      success: true,
      results,
      total: results.length,
      mode: input.mode,
    };
  } catch (err) {
    return createToolError("QUERY_FAILED", `Query failed: ${err}`, {
      recoverable: true,
    });
  }
}

// ============================================================================
// Project Export & Deploy
// ============================================================================
//
// Implemented in ./projects/deploy.ts; re-exported to preserve the public API.

import { generateDeploymentFiles } from "./projects/deploy.js";

export {
  projectExport,
  projectDeploy,
  generateMcpServerSourceForTest,
  buildServerConfigForTest,
  type ProjectExportResult,
  type ProjectDeployResult,
} from "./projects/deploy.js";
// ============================================================================
// Project Serve (Local Development Server)
// ============================================================================
//
// Implemented in ./projects/serve.ts; re-exported to preserve the public API.

export {
  projectServe,
  projectServeStop,
  projectServeStatus,
  type ProjectServeResult,
  type ProjectServeStopResult,
  type ProjectServeStatusResult,
} from "./projects/serve.js";
// ============================================================================
// Ingestion Pipeline Helpers
// ============================================================================
//
// fetch -> chunk -> embed lives in ./projects/ingest.ts.

import {
  fetchWithTimeout,
  fetchSource,
  chunkContent,
  embedText,
  embedChunks,
} from "./projects/ingest.js";

// ============================================================================
// Query Embedding
// ============================================================================

/**
 * Generate query embedding using OpenAI API
 * Used for hybrid search in /chat endpoint
 */
export async function generateQueryEmbedding(params: {
  text: string;
  model: EmbeddingModel;
}): Promise<number[]> {
  const { text, model } = params;
  
  const apiKey = process.env[model.api_key_env];
  if (!apiKey) {
    throw new Error(`API key not found in environment variable: ${model.api_key_env}`);
  }
  
  if (model.provider !== "openai") {
    throw new Error(`Unsupported embedding provider: ${model.provider}`);
  }
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);
  
  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model.model_name,
        input: text,
      }),
      signal: controller.signal,
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
    }
    
    const data = await response.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0].embedding;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Search result with flattened structure for easy access
 */
export interface SearchResult {
  chunk_id: string;
  text: string;
  score: number;
  source_id: string;
  source_name?: string;
  position: {
    index: number;
    start_char: number;
    end_char: number;
  };
  metadata: Record<string, unknown>;
}

/**
 * Helper: Convert ChunkRecord to flattened SearchResult
 */
function chunkToSearchResult(chunk: ChunkRecord, score: number): SearchResult {
  return {
    chunk_id: chunk.chunk_id,
    text: chunk.text,
    score: Math.round(score * 10000) / 10000,
    source_id: chunk.source_id,
    source_name: chunk.metadata?.source_name as string | undefined,
    position: chunk.position,
    metadata: chunk.metadata,
  };
}

/**
 * Chat result with context and search metadata
 */
export interface ChatResult {
  context: string;
  searchMode: 'hybrid' | 'keyword';
  sources: SearchResult[];
  conversationId: string;
}

/**
 * Chat retrieval flow, backed by the same hybrid search the exported server
 * runs (src/templates/server/search.ts). Exported so the test suite exercises
 * the shipped algorithm rather than a stand-in.
 */
export async function chatWithHybridSearch(params: {
  question: string;
  projectDir: string;
  topK?: number;
}): Promise<ChatResult> {
  const { question, projectDir, topK = 5 } = params;

  // Load project data
  const chunksPath = path.join(projectDir, "data", "chunks.jsonl");
  const vectorsPath = path.join(projectDir, "data", "vectors.jsonl");
  const manifestPath = path.join(projectDir, "project.json");

  if (!(await pathExists(manifestPath))) {
    throw new Error(`Project not found at: ${projectDir}`);
  }

  const manifest = await readJson<ProjectManifest>(manifestPath);
  const chunks = await readJsonl<ChunkRecord>(chunksPath);
  const vectors = await readJsonl<VectorRecord>(vectorsPath);

  if (chunks.length === 0) {
    throw new Error("No chunks found in project");
  }

  // Without an API key there is nothing to embed with, so skip the semantic
  // half entirely rather than paying for a request that cannot succeed.
  const apiKeyEnv = manifest.embedding_model?.api_key_env || "OPENAI_API_KEY";
  const hasApiKey = !!process.env[apiKeyEnv];

  const context = buildSearchContext(chunks, hasApiKey ? vectors : []);

  const { results, diagnostics } = await searchHybrid(
    context,
    question,
    topK,
    (text) => generateQueryEmbedding({ text, model: manifest.embedding_model })
  );

  const searchResults = results.map((r) =>
    chunkToSearchResult(r.chunk as ChunkRecord, r.score)
  );

  return {
    context: searchResults.map((r) => r.text).join("\n\n---\n\n"),
    searchMode: diagnostics.mode,
    sources: searchResults,
    conversationId: "",
  };
}
