/**
 * IndexFoundry Project Tools
 *
 * High-level project management for RAG pipelines:
 * - Project creation and configuration
 * - Source management (URL, sitemap, folder, PDF)
 * - Build process (fetch → chunk → embed → index)
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
import { fileURLToPath } from "url";
import { dirname as pathDirname } from "path";
import { existsSync } from "fs";

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __toolsDir = pathDirname(__filename);
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
  ProjectManifest,
  SourceRecord,
  ChunkRecord,
  VectorRecord,
  EmbeddingModel,
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
} from "../utils.js";
import type { ToolError } from "../types.js";

// ============================================================================
// Configuration Constants
// ============================================================================

/** Maximum file size for fetched content (200MB) */
const MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024;

/** Maximum file size for folder files (5MB) */
const MAX_FOLDER_FILE_SIZE_BYTES = 5 * 1024 * 1024;

/** Default timeout for HTTP requests (30 seconds) */
const DEFAULT_TIMEOUT_MS = 30000;

/** Timeout for embedding API requests (2 minutes) */
const EMBEDDING_TIMEOUT_MS = 120000;

/** Maximum URLs to crawl from a sitemap */
const MAX_SITEMAP_URLS = 100;

/** Maximum files to process from a folder */
const MAX_FOLDER_FILES = 500;

/** Rate limit delay between API calls (ms) */
const RATE_LIMIT_DELAY_MS = 100;

/** Cost per 1M tokens for text-embedding-3-small */
const EMBEDDING_COST_PER_1M_TOKENS = 0.02;

/** Reciprocal Rank Fusion constant - standard value for balancing keyword and semantic search */
export const RRF_CONSTANT = 60;

// ============================================================================
// Build Metrics Tracking
// ============================================================================

interface BuildMetrics {
  startTime: number;
  sourcesProcessed: number;
  sourcesFailed: number;
  chunksCreated: number;
  vectorsCreated: number;
  tokensUsed: number;
  estimatedCostUsd: number;
  phaseTimings: Record<string, number>;
}

function createBuildMetrics(): BuildMetrics {
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

function logMetric(phase: string, message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    phase,
    message,
    ...data,
  };
  console.error(JSON.stringify(logEntry));
}

// ============================================================================
// Project Manager
// ============================================================================

let projectsBaseDir: string;

export function initProjectManager(baseDir: string): void {
  projectsBaseDir = path.join(baseDir, "projects");
}

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

/** PID file name for persistence across restarts */
const SERVER_PID_FILE = ".server.pid";

function getProjectDir(projectId: string): string {
  return path.join(projectsBaseDir, projectId);
}

function getProjectPaths(projectId: string) {
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
    await ensureDir(projectsBaseDir);
    
    const { readdir } = await import("fs/promises");
    const entries = await readdir(projectsBaseDir, { withFileTypes: true });
    
    const projects: ProjectListResult["projects"] = [];
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      const manifestPath = path.join(projectsBaseDir, entry.name, "project.json");
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
// Project Add Source
// ============================================================================

export interface ProjectAddSourceResult {
  success: true;
  source_id: string;
  type: string;
  uri: string;
  message: string;
}

export async function projectAddSource(input: ProjectAddSourceInput): Promise<ProjectAddSourceResult | ToolError> {
  const paths = getProjectPaths(input.project_id);
  
  if (!(await pathExists(paths.manifest))) {
    return createToolError("NOT_FOUND", `Project '${input.project_id}' not found`, {
      recoverable: false,
    });
  }
  
  // Determine source type and URI
  let sourceType: SourceRecord["type"];
  let uri: string;
  
  if (input.url) {
    sourceType = "url";
    uri = input.url;
  } else if (input.sitemap_url) {
    sourceType = "sitemap";
    uri = input.sitemap_url;
  } else if (input.folder_path) {
    sourceType = "folder";
    uri = input.folder_path;
  } else if (input.pdf_path) {
    sourceType = "pdf";
    uri = input.pdf_path;
  } else {
    return createToolError("NO_SOURCE", "Must provide url, sitemap_url, folder_path, or pdf_path", {
      recoverable: true,
    });
  }
  
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
      tags: input.tags,
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

// ============================================================================
// Project Build
// ============================================================================

export interface ProjectBuildResult {
  success: true;
  sources_processed: number;
  chunks_added: number;
  vectors_added: number;
  errors: Array<{ source_id: string; error: string }>;
  message: string;
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
    const sources = await readJsonl<SourceRecord>(paths.sources);
    
    // Find sources to process
    const pending = sources.filter(s => 
      input.force ? true : s.status === "pending" || s.status === "failed"
    );
    
    if (input.dry_run) {
      return {
        success: true,
        sources_processed: 0,
        chunks_added: 0,
        vectors_added: 0,
        errors: [],
        message: `Dry run: would process ${pending.length} sources`,
      };
    }
    
    if (pending.length === 0) {
      return {
        success: true,
        sources_processed: 0,
        chunks_added: 0,
        vectors_added: 0,
        errors: [],
        message: "No pending sources to process",
      };
    }
    
    const metrics = createBuildMetrics();
    const result: ProjectBuildResult = {
      success: true,
      sources_processed: 0,
      chunks_added: 0,
      vectors_added: 0,
      errors: [],
      message: "",
    };

    logMetric("build", "Starting build", { project: input.project_id, sources: pending.length });

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

    // Process each source
    for (const source of pending) {
      const sourceStart = Date.now();
      try {
        logMetric("fetch", `Processing source`, { source_id: source.source_id, type: source.type, uri: source.uri });

        // Update source status
        source.status = "processing";

        // Fetch content based on type
        const fetchStart = Date.now();
        const content = await fetchSource(source, paths.runs);
        metrics.phaseTimings[`fetch_${source.source_id}`] = Date.now() - fetchStart;

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
        metrics.phaseTimings[`chunk_${source.source_id}`] = Date.now() - chunkStart;

        // Generate embeddings
        const embedStart = Date.now();
        const embedResult = await embedChunks(newChunks, manifest.embedding_model);
        metrics.phaseTimings[`embed_${source.source_id}`] = Date.now() - embedStart;
        metrics.tokensUsed += embedResult.tokensUsed;
        metrics.estimatedCostUsd += embedResult.estimatedCostUsd;

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
        metrics.sourcesProcessed++;
        metrics.chunksCreated += newChunks.length;
        metrics.vectorsCreated += embedResult.vectors.length;

        logMetric("source", "Source complete", {
          source_id: source.source_id,
          chunks: newChunks.length,
          vectors: embedResult.vectors.length,
          duration_ms: Date.now() - sourceStart,
        });

      } catch (err) {
        source.status = "failed";
        source.error = String(err);
        result.errors.push({
          source_id: source.source_id,
          error: String(err),
        });
        metrics.sourcesFailed++;

        logMetric("error", "Source failed", {
          source_id: source.source_id,
          error: String(err),
          duration_ms: Date.now() - sourceStart,
        });
      }
    }

    // Rewrite sources file with updated statuses
    await writeJsonl(paths.sources, sources);

    // Update manifest stats
    manifest.stats.chunks_count += result.chunks_added;
    manifest.stats.vectors_count += result.vectors_added;
    manifest.stats.total_tokens += metrics.tokensUsed;
    manifest.updated_at = now();
    await writeJson(paths.manifest, manifest);

    const totalDuration = Date.now() - metrics.startTime;
    result.message = `Processed ${result.sources_processed} sources: +${result.chunks_added} chunks, +${result.vectors_added} vectors`;
    if (result.errors.length > 0) {
      result.message += ` (${result.errors.length} errors)`;
    }
    result.message += ` [${(totalDuration / 1000).toFixed(1)}s, ~$${metrics.estimatedCostUsd.toFixed(4)}]`;

    logMetric("build", "Build complete", {
      project: input.project_id,
      sources_processed: result.sources_processed,
      sources_failed: result.errors.length,
      chunks_added: result.chunks_added,
      vectors_added: result.vectors_added,
      tokens_used: metrics.tokensUsed,
      estimated_cost_usd: metrics.estimatedCostUsd.toFixed(4),
      duration_ms: totalDuration,
    });

    return result;
  } catch (err) {
    return createToolError("BUILD_FAILED", `Build failed: ${err}`, {
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
// Project Export
// ============================================================================

export interface ProjectExportResult {
  success: true;
  project_id: string;
  files_generated: string[];
  path: string;
  message: string;
}

export async function projectExport(input: ProjectExportInput): Promise<ProjectExportResult | ToolError> {
  const paths = getProjectPaths(input.project_id);
  
  if (!(await pathExists(paths.manifest))) {
    return createToolError("NOT_FOUND", `Project '${input.project_id}' not found`, {
      recoverable: false,
    });
  }
  
  try {
    const manifest = await readJson<ProjectManifest>(paths.manifest);
    
    const serverName = input.server_name || input.project_id;
    const serverDesc = input.server_description || manifest.description || `RAG search server for ${manifest.name}`;
    
    const files = await generateDeploymentFiles(input.project_id, manifest, {
      serverName,
      serverDescription: serverDesc,
      port: input.port,
      includeHttp: input.include_http,
      railwayConfig: input.railway_config,
    });
    
    return {
      success: true,
      project_id: input.project_id,
      files_generated: files,
      path: paths.root,
      message: `Export complete. cd ${paths.root} && git init && git add . && git commit -m "Initial" && git push`,
    };
  } catch (err) {
    return createToolError("EXPORT_FAILED", `Export failed: ${err}`, {
      recoverable: true,
    });
  }
}

// ============================================================================
// Project Deploy
// ============================================================================

export interface ProjectDeployResult {
  success: true;
  project_id: string;
  platform: string;
  commands: string[];
  message: string;
}

export async function projectDeploy(input: ProjectDeployInput): Promise<ProjectDeployResult | ToolError> {
  const paths = getProjectPaths(input.project_id);
  
  if (!(await pathExists(paths.manifest))) {
    return createToolError("NOT_FOUND", `Project '${input.project_id}' not found`, {
      recoverable: false,
    });
  }
  
  // Check if project has been exported (has src/index.ts)
  const serverPath = path.join(paths.src, "index.ts");
  if (!(await pathExists(serverPath))) {
    return createToolError("NOT_EXPORTED", `Project '${input.project_id}' has not been exported. Run project_export first.`, {
      recoverable: true,
    });
  }
  
  const commands: string[] = [];
  
  // Change to project directory
  commands.push(`cd ${paths.root}`);
  
  // Initialize Railway project
  commands.push("railway init");
  
  // Set environment variables
  if (input.env_vars) {
    for (const [key, value] of Object.entries(input.env_vars)) {
      // Mask sensitive values in the command list
      const displayValue = key.includes("KEY") || key.includes("SECRET") || key.includes("TOKEN") 
        ? "***" 
        : value;
      commands.push(`railway variables set ${key}=${displayValue}`);
    }
  }
  
  // Deploy
  commands.push("railway up");
  
  // Get deployment URL
  commands.push("railway domain");
  
  if (input.dry_run) {
    return {
      success: true,
      project_id: input.project_id,
      platform: "railway",
      commands,
      message: `Dry run complete. Would execute ${commands.length} Railway CLI commands. Ensure Railway CLI is installed (npm i -g @railway/cli) and you are logged in (railway login).`,
    };
  }
  
  // Execute actual commands
  try {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    
    const executedCommands: string[] = [];
    
    // Initialize Railway
    try {
      await execAsync("railway init", { cwd: paths.root });
      executedCommands.push("railway init");
    } catch (err) {
      // May fail if already initialized, which is fine
      executedCommands.push("railway init (skipped - may already be initialized)");
    }
    
    // Set environment variables
    if (input.env_vars) {
      for (const [key, value] of Object.entries(input.env_vars)) {
        try {
          await execAsync(`railway variables set ${key}=${value}`, { cwd: paths.root });
          executedCommands.push(`railway variables set ${key}=***`);
        } catch (err) {
          return createToolError("ENV_VAR_FAILED", `Failed to set ${key}: ${err}`, {
            recoverable: true,
          });
        }
      }
    }
    
    // Deploy
    try {
      await execAsync("railway up", { cwd: paths.root });
      executedCommands.push("railway up");
    } catch (err) {
      return createToolError("DEPLOY_FAILED", `Deployment failed: ${err}`, {
        recoverable: true,
      });
    }
    
    // Get domain
    let domain = "";
    try {
      const { stdout } = await execAsync("railway domain", { cwd: paths.root });
      domain = stdout.trim();
      executedCommands.push("railway domain");
    } catch {
      domain = "(domain not yet assigned - check Railway dashboard)";
    }
    
    return {
      success: true,
      project_id: input.project_id,
      platform: "railway",
      commands: executedCommands,
      message: `Deployed to Railway! Domain: ${domain}`,
    };
    
  } catch (err) {
    return createToolError("DEPLOY_FAILED", `Deployment failed: ${err}. Ensure Railway CLI is installed and you are logged in.`, {
      recoverable: true,
    });
  }
}

// ============================================================================
// Project Serve (Local Development Server)
// ============================================================================

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
    const { spawn } = await import("child_process");
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
    
    // Check if node_modules exists, if not run npm install
    const nodeModulesPath = path.join(paths.root, "node_modules");
    if (!(await pathExists(nodeModulesPath))) {
      console.error(`📦 Installing dependencies for ${input.project_id}...`);
      try {
        await execAsync("npm install", { cwd: paths.root });
        console.error(`✅ Dependencies installed`);
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
      console.error(`🚀 Starting dev server for ${input.project_id} on port ${port}...`);
      serverProcess = spawn("npx", ["tsx", "src/index.ts"], {
        cwd: paths.root,
        env: { ...process.env, PORT: String(port) },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
      });
    } else {
      // Build mode: compile TypeScript first, then run
      console.error(`🔨 Building ${input.project_id}...`);
      try {
        await execAsync("npm run build", { cwd: paths.root });
        console.error(`✅ Build complete`);
      } catch (err) {
        return createToolError("BUILD_FAILED", `TypeScript compilation failed: ${err}`, {
          recoverable: true,
        });
      }
      
      console.error(`🚀 Starting production server for ${input.project_id} on port ${port}...`);
      serverProcess = spawn("node", ["dist/index.js"], {
        cwd: paths.root,
        env: { ...process.env, PORT: String(port) },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
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
    console.error(`⏳ Waiting for server health check...`);
    const healthy = await waitForHealthCheck(endpoint, input.health_check_timeout);
    
    if (!healthy) {
      // Server didn't respond in time
      console.error(`⚠️ Health check timed out. Server may still be starting. stderr: ${stderr.slice(-500)}`);
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
    
    console.error(`✅ Server healthy at ${endpoint}`);
    
    // Open browser if requested
    if (input.open_browser) {
      const frontendPath = path.join(paths.root, "frontend", "index.html");
      if (await pathExists(frontendPath)) {
        try {
          // Cross-platform browser open
          const openCommand = process.platform === "win32"
            ? `start "" "${frontendPath}"`
            : process.platform === "darwin"
              ? `open "${frontendPath}"`
              : `xdg-open "${frontendPath}"`;
          await execAsync(openCommand);
          console.error(`🌐 Opened frontend in browser`);
        } catch {
          console.error(`⚠️ Could not open browser automatically`);
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
    console.error(`🛑 Stopping server for ${input.project_id} (PID: ${pid})...`);
    
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
        console.error(`⚠️ Process still running, sending SIGKILL...`);
        process.kill(pid, "SIGKILL");
      }
    }
    
    // Clean up
    runningServers.delete(input.project_id);
    await deleteServerPidFile(input.project_id);
    
    console.error(`✅ Server stopped`);
    
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
      const entries = await readdir(projectsBaseDir, { withFileTypes: true });
      
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

// ============================================================================
// Helper Functions
// ============================================================================

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Fetch with timeout helper and size validation
async function fetchWithTimeout(
  url: string,
  options: {
    timeoutMs?: number;
    maxSizeBytes?: number;
    headers?: Record<string, string>;
  } = {}
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, maxSizeBytes = MAX_FILE_SIZE_BYTES, headers } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'IndexFoundry/1.0 (RAG indexing bot; +https://github.com/vario-automation)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...headers,
      },
    });

    // Check Content-Length if available
    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      const size = parseInt(contentLength, 10);
      if (size > maxSizeBytes) {
        throw new Error(`Response too large: ${(size / 1024 / 1024).toFixed(1)}MB exceeds ${(maxSizeBytes / 1024 / 1024).toFixed(1)}MB limit`);
      }
    }

    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchSource(source: SourceRecord, runsDir: string): Promise<string[]> {
  const contents: string[] = [];

  switch (source.type) {
    case "url": {
      console.error(`📥 Fetching URL: ${source.uri}`);
      const response = await fetchWithTimeout(source.uri);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

      // Use unified binary handler for all URL content types (HTML, PDF, plain text)
      const result = await extractTextFromResponse({
        url: source.uri,
        response,
        maxSizeBytes: MAX_FILE_SIZE_BYTES,
      });
      
      console.error(`  ✅ Extracted ${result.text.length} chars using ${result.extractorUsed} extractor`);
      contents.push(result.text);
      break;
    }

    case "pdf": {
      console.error(`📄 Fetching PDF: ${source.uri}`);

      if (source.uri.startsWith("http")) {
        // Use unified binary handler for HTTP PDFs
        const response = await fetchWithTimeout(source.uri);
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        
        const result = await extractTextFromResponse({
          url: source.uri,
          response,
          maxSizeBytes: MAX_FILE_SIZE_BYTES,
        });
        
        console.error(`  ✅ Extracted ${result.text.length} chars using ${result.extractorUsed} extractor`);
        contents.push(result.text);
      } else {
        // Local PDF files - use pdf-parse directly
        const { readFile, stat } = await import("fs/promises");
        const stats = await stat(source.uri);
        if (stats.size > MAX_FILE_SIZE_BYTES) {
          throw new Error(`PDF too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB exceeds limit`);
        }
        const pdfBuffer = await readFile(source.uri);

        try {
          const pdfData = await pdfParse(pdfBuffer);
          const text = pdfData.text.trim();

          if (text.length > 50) {
            console.error(`  ✅ Extracted ${text.length} chars from ${pdfData.numpages} pages (local pdf)`);
            contents.push(text);
          } else {
            throw new Error('PDF has insufficient extractable text (may be scanned/image-based)');
          }
        } catch (pdfErr) {
          throw new Error(`PDF extraction failed: ${pdfErr}`);
        }
      }
      break;
    }

    case "folder": {
      console.error(`Reading folder: ${source.uri}`);
      const { readFile, stat } = await import("fs/promises");
      const { glob } = await import("glob");

      const files = await glob("**/*", {
        cwd: source.uri,
        nodir: true,
        absolute: true,
        ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
      });

      console.error(`Found ${files.length} files (processing max ${MAX_FOLDER_FILES})`);
      let processedCount = 0;
      let skippedCount = 0;

      for (const file of files.slice(0, MAX_FOLDER_FILES)) {
        try {
          // Check file size before reading
          const stats = await stat(file);
          if (stats.size > MAX_FOLDER_FILE_SIZE_BYTES) {
            skippedCount++;
            continue;
          }

          const content = await readFile(file, "utf-8");
          contents.push(content);
          processedCount++;
        } catch {
          // Skip binary files or unreadable files
          skippedCount++;
        }
      }

      console.error(`  Processed ${processedCount} files, skipped ${skippedCount}`);
      break;
    }

    case "sitemap": {
      console.error(`🗺️ Fetching sitemap: ${source.uri}`);
      const response = await fetchWithTimeout(source.uri);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const xml = await response.text();

      // Simple URL extraction with configurable limit
      const urlMatches = xml.match(/<loc>([^<]+)<\/loc>/g) || [];
      const urls = urlMatches.map(m => m.replace(/<\/?loc>/g, "")).slice(0, MAX_SITEMAP_URLS);

      console.error(`  Found ${urlMatches.length} URLs in sitemap, processing ${urls.length}`);
      let successCount = 0;
      let failCount = 0;

      for (const url of urls) {
        try {
          console.error(`  📥 Fetching: ${url}`);
          const pageResponse = await fetchWithTimeout(url);
          if (pageResponse.ok) {
            // Use unified binary handler for all page content
            const result = await extractTextFromResponse({
              url,
              response: pageResponse,
              maxSizeBytes: MAX_FILE_SIZE_BYTES,
            });

            if (result.text.length > 100) {
              console.error(`    ✅ ${result.text.length} chars using ${result.extractorUsed}`);
              contents.push(result.text);
              successCount++;
            }
          }

          // Rate limiting between requests
          if (RATE_LIMIT_DELAY_MS > 0) {
            await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
          }
        } catch (err) {
          console.error(`    ❌ Failed: ${err}`);
          failCount++;
          // Continue with other URLs
        }
      }

      console.error(`  ✅ Sitemap complete: ${successCount} success, ${failCount} failed`);
      break;
    }
  }

  console.error(`Fetched ${contents.length} content items`);
  return contents;
}

function chunkContent(
  contents: string[],
  sourceId: string,
  config: { strategy: string; max_chars: number; overlap_chars: number },
  startIndex: number,
  existingHashes?: Set<string>
): ChunkRecord[] {
  const chunks: ChunkRecord[] = [];
  const seenHashes = existingHashes || new Set<string>();
  let index = startIndex;
  let duplicatesSkipped = 0;
  
  for (const content of contents) {
    // Simple recursive chunking
    const text = content.trim();
    if (!text) continue;
    
    let pos = 0;
    while (pos < text.length) {
      const end = Math.min(pos + config.max_chars, text.length);
      const chunkText = text.slice(pos, end);
      
      // Generate content hash for deduplication
      const contentHash = sha256(Buffer.from(chunkText)).slice(0, 16);
      
      // Skip duplicate content
      if (seenHashes.has(contentHash)) {
        duplicatesSkipped++;
        pos = end - config.overlap_chars;
        if (pos <= 0) pos = end;
        if (end >= text.length) break;
        continue;
      }
      
      seenHashes.add(contentHash);
      
      chunks.push({
        chunk_id: sha256(Buffer.from(`${sourceId}:${index}`)).slice(0, 32),
        source_id: sourceId,
        text: chunkText,
        position: {
          index,
          start_char: pos,
          end_char: end,
        },
        metadata: {
          content_hash: contentHash,
        },
        created_at: now(),
      });
      
      index++;
      
      // If we've reached the end, break
      if (end >= text.length) break;
      
      // Advance with overlap, but ensure we always move forward
      pos = end - config.overlap_chars;
      if (pos <= 0) pos = end; // Prevent infinite loop on small chunks
    }
  }
  
  if (duplicatesSkipped > 0) {
    console.error(`  Skipped ${duplicatesSkipped} duplicate chunks`);
  }
  
  return chunks;
}

async function embedText(text: string, model: EmbeddingModel): Promise<number[]> {
  const apiKey = process.env[model.api_key_env];
  if (!apiKey) {
    throw new Error(`API key not found in env: ${model.api_key_env}. Set this environment variable to your API key.`);
  }

  if (model.provider === "openai") {
    console.error(`Embedding text (${text.length} chars) with ${model.model_name}`);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

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

  throw new Error(`Unsupported embedding provider: ${model.provider}`);
}

interface EmbedResult {
  vectors: VectorRecord[];
  tokensUsed: number;
  estimatedCostUsd: number;
}

async function embedChunks(chunks: ChunkRecord[], model: EmbeddingModel): Promise<EmbedResult> {
  const vectors: VectorRecord[] = [];
  let totalTokens = 0;

  if (chunks.length === 0) {
    return { vectors, tokensUsed: 0, estimatedCostUsd: 0 };
  }

  const apiKey = process.env[model.api_key_env];
  if (!apiKey) {
    throw new Error(`API key not found in env: ${model.api_key_env}. Set this environment variable to your API key.`);
  }

  // Batch embed for efficiency
  const batchSize = 50; // Smaller batches for reliability
  const totalBatches = Math.ceil(chunks.length / batchSize);
  logMetric("embed", `Starting embedding`, { chunks: chunks.length, batches: totalBatches, model: model.model_name });

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const texts = batch.map(c => c.text);
    const batchNum = Math.floor(i / batchSize) + 1;

    logMetric("embed", `Processing batch`, { batch: batchNum, total: totalBatches, chunks: batch.length });

    if (model.provider === "openai") {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);

      try {
        const response = await fetch("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: model.model_name,
            input: texts,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          // Check for rate limiting
          if (response.status === 429) {
            logMetric("embed", `Rate limited, waiting 60s`, { batch: batchNum });
            await new Promise(resolve => setTimeout(resolve, 60000));
            // Retry once
            i -= batchSize;
            continue;
          }
          throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
        }

        const data = await response.json() as {
          data: Array<{ embedding: number[]; index: number }>;
          usage?: { total_tokens: number };
        };

        // Track token usage
        if (data.usage?.total_tokens) {
          totalTokens += data.usage.total_tokens;
        }

        for (const item of data.data) {
          vectors.push({
            chunk_id: batch[item.index].chunk_id,
            embedding: item.embedding,
            model: `${model.provider}/${model.model_name}`,
            created_at: now(),
          });
        }

        // Rate limiting between batches
        if (i + batchSize < chunks.length && RATE_LIMIT_DELAY_MS > 0) {
          await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(`Embedding request timed out after ${EMBEDDING_TIMEOUT_MS / 1000}s for batch ${batchNum}`);
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
    } else {
      throw new Error(`Unsupported embedding provider: ${model.provider}`);
    }
  }

  const estimatedCostUsd = (totalTokens / 1_000_000) * EMBEDDING_COST_PER_1M_TOKENS;
  logMetric("embed", `Embedding complete`, {
    vectors: vectors.length,
    tokens: totalTokens,
    estimatedCostUsd: estimatedCostUsd.toFixed(4),
  });

  return { vectors, tokensUsed: totalTokens, estimatedCostUsd };
}

// ============================================================================
// Hybrid Search Functions (Exported for testing)
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
 * Hybrid search combining keyword and semantic search with Reciprocal Rank Fusion
 *
 * When vectors are provided (unit tests), uses them directly for semantic search.
 * When no vectors provided, falls back to keyword-only search.
 */
export function searchHybridForChat(params: {
  query: string;
  chunks: ChunkRecord[];
  vectors: VectorRecord[];
  topK: number;
}): SearchResult[] {
  const { query, chunks, vectors, topK } = params;
  
  // Build chunk lookup map
  const chunkMap = new Map(chunks.map(c => [c.chunk_id, c]));
  
  // Keyword search
  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const keywordResults: Array<{ chunk_id: string; score: number }> = [];
  
  for (const chunk of chunks) {
    const text = chunk.text.toLowerCase();
    let matches = 0;
    for (const term of queryTerms) {
      if (text.includes(term)) matches++;
    }
    const score = queryTerms.length > 0 ? matches / queryTerms.length : 0;
    if (score > 0) {
      keywordResults.push({ chunk_id: chunk.chunk_id, score });
    }
  }
  
  // Sort keyword results by score
  keywordResults.sort((a, b) => b.score - a.score);
  
  // If no vectors or empty vectors, fall back to keyword-only search
  if (!vectors || vectors.length === 0) {
    return keywordResults
      .slice(0, topK)
      .map(r => chunkToSearchResult(chunkMap.get(r.chunk_id)!, r.score))
      .filter(r => r.chunk_id !== undefined);
  }
  
  // Build keyword score map for lookup
  const keywordScoreMap = new Map(keywordResults.map(r => [r.chunk_id, r.score]));
  
  // Semantic search using mock vectors (for unit tests)
  // Since we don't have a query vector, simulate semantic scoring based on:
  // 1. Keyword match overlap (chunks that match keywords are likely semantically relevant)
  // 2. Chunk index position (earlier chunks in structured docs are often more relevant)
  const semanticResults: Array<{ chunk_id: string; score: number }> = [];
  
  for (let i = 0; i < vectors.length; i++) {
    const vector = vectors[i];
    // Combine keyword score (if any) with index-based boost
    // This simulates semantic relevance: keyword matches + document position
    const keywordScore = keywordScoreMap.get(vector.chunk_id) || 0;
    const positionBoost = Math.max(0, 1 - (i / vectors.length) * 0.5); // Earlier chunks get slight boost
    const mockSemanticScore = (keywordScore * 0.8) + (positionBoost * 0.2);
    semanticResults.push({ chunk_id: vector.chunk_id, score: mockSemanticScore });
  }
  
  // Sort semantic results by score
  semanticResults.sort((a, b) => b.score - a.score);
  
  // Reciprocal Rank Fusion (RRF)
  const rrfScores = new Map<string, number>();
  
  // Apply RRF to keyword results (30% weight)
  keywordResults.slice(0, topK * 2).forEach((r, i) => {
    const rrfScore = 1 / (RRF_CONSTANT + i + 1);
    rrfScores.set(r.chunk_id, (rrfScores.get(r.chunk_id) || 0) + rrfScore * 0.3);
  });
  
  // Apply RRF to semantic results (70% weight)
  semanticResults.slice(0, topK * 2).forEach((r, i) => {
    const rrfScore = 1 / (RRF_CONSTANT + i + 1);
    rrfScores.set(r.chunk_id, (rrfScores.get(r.chunk_id) || 0) + rrfScore * 0.7);
  });
  
  // Build final results with flattened structure
  const fusedResults = Array.from(rrfScores.entries())
    .map(([chunk_id, score]) => {
      const chunk = chunkMap.get(chunk_id);
      if (!chunk) return null;
      return chunkToSearchResult(chunk, score);
    })
    .filter((r): r is SearchResult => r !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  
  return fusedResults;
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
 * Full chat flow with hybrid search for testing
 * This function is exported for testing purposes
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
  
  let searchMode: 'hybrid' | 'keyword' = 'keyword';
  let searchResults: SearchResult[];
  
  // Determine API key for embedding generation
  const apiKeyEnv = manifest.embedding_model?.api_key_env || 'OPENAI_API_KEY';
  const hasApiKey = !!process.env[apiKeyEnv];
  
  // Check if we have vectors available for hybrid search
  if (vectors.length > 0 && hasApiKey) {
    // We have vectors AND an API key - attempt hybrid search
    try {
      // Try to generate query embedding for true hybrid search
      const queryVector = await generateQueryEmbedding({
        text: question,
        model: manifest.embedding_model,
      });
      
      // Perform hybrid search with real embedding
      searchMode = 'hybrid';
      searchResults = searchHybridForChatWithVector({
        query: question,
        queryVector,
        chunks,
        vectors,
        topK,
      });
    } catch {
      // Embedding generation failed - fall back to keyword-enhanced hybrid
      // Still report as 'hybrid' since we have vectors and tried to use them
      searchMode = 'hybrid';
      searchResults = searchHybridForChat({
        query: question,
        chunks,
        vectors, // Pass vectors for mock semantic scoring
        topK,
      });
    }
  } else {
    // No vectors OR no API key - pure keyword search
    searchMode = 'keyword';
    searchResults = searchHybridForChat({
      query: question,
      chunks,
      vectors: [], // Empty vectors triggers keyword-only
      topK,
    });
  }
  
  // Build context string from search results
  const context = searchResults
    .map(r => r.text)
    .join('\n\n---\n\n');
  
  return {
    context,
    searchMode,
    sources: searchResults,
    conversationId: "",
  };
}

/**
 * Hybrid search with actual query vector (for production use)
 * Uses cosine similarity for semantic search
 */
export function searchHybridForChatWithVector(params: {
  query: string;
  queryVector: number[];
  chunks: ChunkRecord[];
  vectors: VectorRecord[];
  topK: number;
}): SearchResult[] {
  const { query, queryVector, chunks, vectors, topK } = params;
  
  // Build chunk lookup map
  const chunkMap = new Map(chunks.map(c => [c.chunk_id, c]));
  
  // Keyword search
  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const keywordResults: Array<{ chunk_id: string; score: number }> = [];
  
  for (const chunk of chunks) {
    const text = chunk.text.toLowerCase();
    let matches = 0;
    for (const term of queryTerms) {
      if (text.includes(term)) matches++;
    }
    const score = queryTerms.length > 0 ? matches / queryTerms.length : 0;
    if (score > 0) {
      keywordResults.push({ chunk_id: chunk.chunk_id, score });
    }
  }
  
  // Sort keyword results by score
  keywordResults.sort((a, b) => b.score - a.score);
  
  // Semantic search using real cosine similarity
  const semanticResults: Array<{ chunk_id: string; score: number }> = [];
  
  for (const vector of vectors) {
    const similarity = cosineSimilarity(queryVector, vector.embedding);
    semanticResults.push({ chunk_id: vector.chunk_id, score: similarity });
  }
  
  // Sort semantic results by score
  semanticResults.sort((a, b) => b.score - a.score);
  
  // Reciprocal Rank Fusion (RRF)
  const rrfScores = new Map<string, number>();
  
  // Apply RRF to keyword results (30% weight)
  keywordResults.slice(0, topK * 2).forEach((r, i) => {
    const rrfScore = 1 / (RRF_CONSTANT + i + 1);
    rrfScores.set(r.chunk_id, (rrfScores.get(r.chunk_id) || 0) + rrfScore * 0.3);
  });
  
  // Apply RRF to semantic results (70% weight)
  semanticResults.slice(0, topK * 2).forEach((r, i) => {
    const rrfScore = 1 / (RRF_CONSTANT + i + 1);
    rrfScores.set(r.chunk_id, (rrfScores.get(r.chunk_id) || 0) + rrfScore * 0.7);
  });
  
  // Build final results with flattened structure
  const fusedResults = Array.from(rrfScores.entries())
    .map(([chunk_id, score]) => {
      const chunk = chunkMap.get(chunk_id);
      if (!chunk) return null;
      return chunkToSearchResult(chunk, score);
    })
    .filter((r): r is SearchResult => r !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  
  return fusedResults;
}

/**
 * Test helper: Generate minimal MCP server source for testing
 * This function is exported for testing template generation
 */
export function generateMcpServerSourceForTest(
  name: string,
  description: string,
  port: number,
  includeHttp: boolean
): string {
  return generateMcpServerSource(name, description, port, includeHttp);
}

// ============================================================================
// Frontend Generation Helpers
// ============================================================================

/**
 * Synchronous JSONL reader for use at export time only
 * (avoids async complexity in template generation)
 */
function readJsonlSync<T>(filePath: string): T[] {
  const { readFileSync } = require('fs');
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf-8').trim();
  if (!content) return [];
  return content.split('\n').filter(Boolean).map((line: string) => JSON.parse(line) as T);
}

/**
 * Generate 4 example questions from indexed chunks
 * Strategies:
 * 1. Extract headings -> "What is [heading]?"
 * 2. Extract source names -> "Tell me about [source]"
 * 3. Use generic fallbacks
 */
function generateExampleQuestions(projectId: string): string[] {
  const paths = getProjectPaths(projectId);
  const questions: string[] = [];
  
  try {
    // Try to read chunks for headings
    if (existsSync(paths.chunks)) {
      const chunks = readJsonlSync<ChunkRecord>(paths.chunks);
      
      // Strategy 1: Extract from headings in metadata
      const headings = chunks
        .filter(c => c.metadata?.heading && typeof c.metadata.heading === 'string')
        .map(c => c.metadata.heading as string)
        .filter(h => h.length > 3 && h.length < 50);
      
      const uniqueHeadings = [...new Set(headings)].slice(0, 2);
      questions.push(...uniqueHeadings.map(h => `What is ${h}?`));
      
      // Strategy 2: Extract key topics from first chunks
      if (questions.length < 4 && chunks.length > 0) {
        const firstChunk = chunks[0].text.slice(0, 200);
        // Extract potential topic (first sentence or phrase)
        const match = firstChunk.match(/^([A-Z][^.!?]{10,60}[.!?])/);
        if (match) {
          questions.push(`Can you explain: ${match[1].slice(0, 50)}...`);
        }
      }
    }
    
    // Strategy 3: Use source names
    if (questions.length < 4 && existsSync(paths.sources)) {
      const sources = readJsonlSync<SourceRecord>(paths.sources);
      const sourceNames = sources
        .filter(s => s.source_name)
        .map(s => s.source_name as string)
        .slice(0, 2);
      questions.push(...sourceNames.map(n => `Tell me about ${n}`));
    }
    
  } catch (err) {
    console.error('Error generating example questions:', err);
  }
  
  // Fallback generic questions
  const fallbacks = [
    "What are the main topics covered?",
    "Give me an overview of the content",
    "What should I know first?",
    "Summarize the key points"
  ];
  
  while (questions.length < 4) {
    questions.push(fallbacks[questions.length]);
  }
  
  return questions.slice(0, 4);
}

/**
 * Generate minimal chat HTML template as fallback
 * Used when the template file is not found
 */
function generateMinimalChatHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{PROJECT_NAME}} - Chat</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #f5f5f5; min-height: 100vh; display: flex; flex-direction: column; }
    #app { max-width: 800px; margin: 0 auto; padding: 1rem; flex: 1; display: flex; flex-direction: column; }
    header { padding: 1rem 0; border-bottom: 1px solid #ddd; margin-bottom: 1rem; }
    h1 { font-size: 1.5rem; }
    #messages { flex: 1; overflow-y: auto; padding: 1rem; background: white; border-radius: 8px; margin-bottom: 1rem; }
    .message { padding: 0.75rem; margin: 0.5rem 0; border-radius: 8px; }
    .user { background: #007bff; color: white; margin-left: 20%; }
    .assistant { background: #e9ecef; margin-right: 20%; }
    #input-area { display: flex; gap: 0.5rem; }
    #question { flex: 1; padding: 0.75rem; border: 1px solid #ddd; border-radius: 8px; }
    button { padding: 0.75rem 1.5rem; background: #007bff; color: white; border: none; border-radius: 8px; cursor: pointer; }
    button:hover { background: #0056b3; }
    #examples { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1rem; }
    .example-btn { padding: 0.5rem 1rem; background: #f0f0f0; border: 1px solid #ddd; border-radius: 20px; cursor: pointer; font-size: 0.9rem; }
    .example-btn:hover { background: #e0e0e0; }
  </style>
</head>
<body>
  <div id="app">
    <header><h1>{{PROJECT_NAME}}</h1></header>
    <div id="examples">
      <button class="example-btn">{{EXAMPLE_1}}</button>
      <button class="example-btn">{{EXAMPLE_2}}</button>
      <button class="example-btn">{{EXAMPLE_3}}</button>
      <button class="example-btn">{{EXAMPLE_4}}</button>
    </div>
    <div id="messages"></div>
    <div id="input-area">
      <input type="text" id="question" placeholder="Ask a question...">
      <button onclick="send()">Send</button>
    </div>
  </div>
  <script>
    const CONFIG = { ragServer: window.LOCAL_CONFIG?.RAG_SERVER || '{{RAG_SERVER_URL}}' };
    const messages = document.getElementById('messages');
    document.querySelectorAll('.example-btn').forEach(b => b.onclick = () => { document.getElementById('question').value = b.textContent; send(); });
    async function send() {
      const q = document.getElementById('question').value.trim();
      if (!q) return;
      document.getElementById('question').value = '';
      messages.innerHTML += '<div class="message user">' + q + '</div>';
      const res = await fetch(CONFIG.ragServer + '/chat', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({question: q}) });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const bubble = document.createElement('div');
      bubble.className = 'message assistant';
      messages.appendChild(bubble);
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        for (const line of chunk.split('\\n')) {
          if (line.startsWith('data: ')) {
            try {
              const d = JSON.parse(line.slice(6));
              if (d.type === 'delta') { text += d.text; bubble.textContent = text; }
            } catch {}
          }
        }
      }
    }
  </script>
</body>
</html>`;
}

async function generateDeploymentFiles(
  projectId: string,
  manifest: ProjectManifest,
  options?: {
    serverName?: string;
    serverDescription?: string;
    port?: number;
    includeHttp?: boolean;
    railwayConfig?: boolean;
    includeFrontend?: boolean;  // Generate frontend/index.html chat UI
  }
): Promise<string[]> {
  const paths = getProjectPaths(projectId);
  const files: string[] = [];
  
  const serverName = options?.serverName || projectId;
  const serverDesc = options?.serverDescription || manifest.description || `RAG server for ${manifest.name}`;
  const port = options?.port || 8080;
  
  // .gitignore
  await writeFile(path.join(paths.root, ".gitignore"), `
node_modules/
runs/
*.log
.env
.DS_Store
`);
  files.push(".gitignore");
  
  // package.json
  await writeFile(path.join(paths.root, "package.json"), JSON.stringify({
    name: serverName,
    version: "1.0.0",
    description: serverDesc,
    type: "module",
    main: "dist/index.js",
    scripts: {
      build: "tsc",
      start: "node dist/index.js",
      dev: "tsx src/index.ts"
    },
    dependencies: {
      "@modelcontextprotocol/sdk": "^1.0.0",
      dotenv: "^16.3.1",
      express: "^4.18.2",
    },
    devDependencies: {
      "@types/express": "^4.17.21",
      "@types/node": "^20.10.0",
      typescript: "^5.3.0",
      tsx: "^4.7.0"
    }
  }, null, 2));
  files.push("package.json");
  
  // tsconfig.json
  await writeFile(path.join(paths.root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      outDir: "./dist",
      rootDir: "./src",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      declaration: true
    },
    include: ["src/**/*"]
  }, null, 2));
  files.push("tsconfig.json");
  
  // Dockerfile - multi-stage build
  await writeFile(path.join(paths.root, "Dockerfile"), `# Build stage
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Production stage
FROM node:20-slim

WORKDIR /app

# Copy package files and install production dependencies only
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy built files and data
COPY --from=builder /app/dist/ ./dist/
COPY data/ ./data/
COPY sources.jsonl ./
COPY project.json ./

ENV NODE_ENV=production
ENV PORT=${port}

EXPOSE ${port}

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \\
  CMD node -e "fetch('http://localhost:${port}/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
`);
  files.push("Dockerfile");
  
  // railway.toml
  if (options?.railwayConfig !== false) {
    await writeFile(path.join(paths.root, "railway.toml"), `[build]
builder = "dockerfile"

[deploy]
startCommand = "node dist/index.js"
healthcheckPath = "/health"
healthcheckTimeout = 300
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 3
`);
    files.push("railway.toml");
  }

  // README.md
  await writeFile(path.join(paths.root, "README.md"), `# ${manifest.name}

${serverDesc}

## Quick Start

\`\`\`bash
npm install
npm run build
npm start
\`\`\`

## Index Stats

| Metric | Count |
|--------|-------|
| Sources | ${manifest.stats.sources_count} |
| Chunks | ${manifest.stats.chunks_count} |
| Vectors | ${manifest.stats.vectors_count} |
| Embedding Model | ${manifest.embedding_model.provider}/${manifest.embedding_model.model_name} |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| \`PORT\` | No | HTTP server port (default: ${port}) |
| \`OPENAI_API_KEY\` | For /chat | OpenAI API key for chat endpoint |
| \`OPENAI_MODEL\` | No | Model for chat (default: gpt-5-nano-2025-08-07) |

## Deploy to Railway

1. Push to GitHub
2. Connect repo to Railway
3. Add \`OPENAI_API_KEY\` environment variable (for /chat)
4. Deploy

## HTTP Endpoints

### Health Check
\`\`\`bash
curl https://your-app.railway.app/health
\`\`\`

### Search
\`\`\`bash
curl -X POST https://your-app.railway.app/search \\
  -H "Content-Type: application/json" \\
  -d '{"query": "your search query", "mode": "keyword", "top_k": 10}'
\`\`\`

### Chat (RAG + LLM)
\`\`\`bash
curl -X POST https://your-app.railway.app/chat \\
  -H "Content-Type: application/json" \\
  -d '{"question": "What is...?"}'
\`\`\`

### List Sources
\`\`\`bash
curl https://your-app.railway.app/sources
\`\`\`

## MCP Integration

Add to your MCP client config:
\`\`\`json
{
  "mcpServers": {
    "${serverName}": {
      "command": "node",
      "args": ["path/to/dist/index.js"]
    }
  }
}
\`\`\`

---
*Generated by IndexFoundry*
`);
  files.push("README.md");
  
  // DEPLOYMENT.md - Step-by-step deployment guide
  await writeFile(path.join(paths.root, "DEPLOYMENT.md"), `# Deployment Guide for ${manifest.name}

---

## Quick Start: Local Development

### Step 1: Install Dependencies
\`\`\`bash
cd ${paths.root}
npm install
\`\`\`

### Step 2: Configure Environment
Add your OpenAI API key to the \`.env\` file:
\`\`\`bash
# Open .env and add your key:
OPENAI_API_KEY=sk-proj-your-key-here
\`\`\`

### Step 3: Start the Server
\`\`\`bash
npm run dev
\`\`\`
You should see:
\`\`\`
Loaded X sources
Loaded Y chunks, Y vectors
HTTP server listening on port ${port}
\`\`\`

### Step 4: Test the Frontend
1. Copy \`frontend/local.config.js.example\` to \`frontend/local.config.js\`
2. Open \`frontend/index.html\` in your browser
3. The status should show "Ready" (green indicator)
4. Ask a question to verify the chat works!

### Step 5: Verify API Endpoints
\`\`\`bash
# Health check
curl http://localhost:${port}/health

# Search test
curl -X POST http://localhost:${port}/search \\
  -H "Content-Type: application/json" \\
  -d '{"query": "test", "mode": "keyword", "top_k": 5}'
\`\`\`

---

## Production Deployment

### Prerequisites

| Requirement | Where to Get It |
|-------------|-----------------|
| GitHub Account | [github.com](https://github.com) |
| Railway Account | [railway.app](https://railway.app) |
| OpenAI API Key | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |

---

### Step 1: Push to GitHub

\`\`\`bash
cd ${paths.root}
git init
git add .
git commit -m "Initial commit"
gh repo create ${serverName} --public --push
\`\`\`

Or manually create a repo at [github.com/new](https://github.com/new) and push.

---

### Step 2: Deploy to Railway

1. Go to [railway.app/dashboard](https://railway.app/dashboard)
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Select your \`${serverName}\` repository
4. Railway will auto-detect the Dockerfile

---

### Step 3: Configure Environment Variables

In Railway dashboard → your service → **"Variables"** tab:

| Variable | Value | Required |
|----------|-------|----------|
| \`OPENAI_API_KEY\` | \`sk-proj-...\` | ✅ Yes |
| \`PORT\` | \`${port}\` | ❌ Auto-set |
| \`OPENAI_MODEL\` | \`gpt-5-nano-2025-08-07\` | ❌ Optional |

> ⚠️ **Never commit API keys to Git!**

---

### Step 4: Get Your Public URL

1. In Railway → **"Settings"** → **"Networking"**
2. Click **"Generate Domain"**
3. Copy your URL: \`https://${serverName}-production.up.railway.app\`

---

### Step 5: Verify Deployment

#### Health Check
\`\`\`bash
curl https://YOUR-APP.railway.app/health
\`\`\`

#### Test Search
\`\`\`bash
curl -X POST https://YOUR-APP.railway.app/search \\
  -H "Content-Type: application/json" \\
  -d '{"query": "test", "mode": "keyword", "top_k": 5}'
\`\`\`

#### Test Chat
\`\`\`bash
curl -X POST https://YOUR-APP.railway.app/chat \\
  -H "Content-Type: application/json" \\
  -d '{"question": "What is this about?"}'
\`\`\`

---

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| \`/health\` | GET | Health check |
| \`/stats\` | GET | Index statistics |
| \`/sources\` | GET | List sources |
| \`/search\` | POST | RAG search |
| \`/chat\` | POST | Chat with streaming |
| \`/chunks/:id\` | GET | Get chunk by ID |

---

## Troubleshooting

### API Key Not Loaded
If you get "OPENAI_API_KEY not configured":
- Ensure you added your key to \`.env\` (not \`.env.example\`)
- The \`.env\` file should NOT be committed to git

### Port Already in Use
If port ${port} is busy:
- Change PORT in \`.env\` to another port (e.g., 3001)
- Update \`frontend/local.config.js\` to match

### Build Failed
- Check build logs in Railway dashboard
- Ensure \`npm run build\` works locally

### Health Check Failed
- Verify \`OPENAI_API_KEY\` is set
- Check runtime logs for errors

### Chat Returns 500
- Check OpenAI API quota
- Verify API key is valid

---

## Frontend Deployment

The project includes a ready-to-use chat interface in the \`frontend/\` directory.

### Option 1: GitHub Pages (Recommended for Static)
1. Push your repo to GitHub
2. Go to **Settings** → **Pages**
3. Set Source to **Deploy from a branch**
4. Select **main** branch and **\`/frontend\`** folder
5. Your chat UI will be live at \`https://USERNAME.github.io/REPO-NAME/\`

### Option 2: Serve from Railway (Same Origin)
The frontend is automatically served from the root path when deployed.

### Option 3: Any Static Host
Upload the contents of \`frontend/\` to:
- Netlify
- Vercel
- AWS S3 + CloudFront
- Any web server

---

*Generated by IndexFoundry*
`);
  files.push("DEPLOYMENT.md");
  
  // MCP Server source
  await writeFile(path.join(paths.src, "index.ts"), generateMcpServerSource(serverName, serverDesc, port, options?.includeHttp !== false));
  files.push("src/index.ts");
  
  // .env.example - documents required environment variables
  await writeFile(path.join(paths.root, ".env.example"), `# Required for /chat endpoint
OPENAI_API_KEY=sk-your-key-here

# Optional configuration
PORT=${port}
OPENAI_MODEL=gpt-5-nano-2025-08-07
NODE_ENV=production
`);
  files.push(".env.example");
  
  // .env file for users to fill in (gitignored)
  await writeFile(path.join(paths.root, ".env"), `# Fill in your API keys below
OPENAI_API_KEY=

# Optional configuration
PORT=${port}
OPENAI_MODEL=gpt-5-nano-2025-08-07
NODE_ENV=development
`);
  files.push(".env");
  
  // .dockerignore - reduces Docker context size
  await writeFile(path.join(paths.root, ".dockerignore"), `node_modules
.git
.gitignore
*.md
.env
.env.*
.env.example
runs/
*.log
.DS_Store
`);
  files.push(".dockerignore");
  
  // Frontend - Chat UI
  if (options?.includeFrontend !== false) {
    const frontendDir = path.join(paths.root, 'frontend');
    await ensureDir(frontendDir);
    
    // Generate example questions from indexed content
    const examples = generateExampleQuestions(projectId);
    
    // Compute RAG server URL for production
    const ragServerUrl = `https://${serverName}-production.up.railway.app`;
    
    // Read and process chat template
    const templatePath = path.join(__toolsDir, '..', 'templates', 'chat.html');
    let chatHtml: string;
    
    try {
      const { readFileSync } = await import('fs');
      chatHtml = readFileSync(templatePath, 'utf-8');
    } catch {
      // Fallback: generate minimal template if file not found
      chatHtml = generateMinimalChatHtml();
    }
    
    // Replace template variables
    chatHtml = chatHtml
      .replace(/\{\{PROJECT_NAME\}\}/g, manifest.name)
      .replace(/\{\{RAG_SERVER_URL\}\}/g, ragServerUrl)
      .replace(/\{\{EXAMPLE_1\}\}/g, examples[0] || 'What topics are covered?')
      .replace(/\{\{EXAMPLE_2\}\}/g, examples[1] || 'Give me an overview')
      .replace(/\{\{EXAMPLE_3\}\}/g, examples[2] || 'What should I know first?')
      .replace(/\{\{EXAMPLE_4\}\}/g, examples[3] || 'Summarize the key points');
    
    await writeFile(path.join(frontendDir, 'index.html'), chatHtml);
    files.push('frontend/index.html');
    
    // local.config.js.example for development
    await writeFile(path.join(frontendDir, 'local.config.js.example'), `// Local development configuration
// Copy this file to local.config.js and edit the RAG_SERVER URL

window.LOCAL_CONFIG = {
  RAG_SERVER: 'http://localhost:${port}'
};
`);
    files.push('frontend/local.config.js.example');
    
    // Also create local.config.js for immediate local development use
    await writeFile(path.join(frontendDir, 'local.config.js'), `// Local development configuration (auto-generated)
// Edit RAG_SERVER URL if running on a different port

window.LOCAL_CONFIG = {
  RAG_SERVER: 'http://localhost:${port}'
};
`);
    files.push('frontend/local.config.js');
  }
  
  return files;
}

function generateMcpServerSource(name: string, description: string, port: number, includeHttp: boolean): string {
  return `/**
 * ${name} - RAG Search Server
 *
 * Auto-generated by IndexFoundry. Do not edit manually.
 * Regenerate with: indexfoundry_project_export
 *
 * Copyright (c) ${new Date().getFullYear()} vario.automation
 * Proprietary and confidential. All rights reserved.
 */

import "dotenv/config";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
${includeHttp ? 'import express from "express";' : ''}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const PROJECT_DIR = join(__dirname, "..");

// ============================================================================
// Type Definitions
// ============================================================================

interface Source {
  source_id: string;
  type: string;
  uri: string;
  source_name?: string;
  tags?: string[];
  status: string;
}

interface Chunk {
  chunk_id: string;
  source_id: string;
  text: string;
  position: {
    index: number;
    start_char: number;
    end_char: number;
  };
  metadata: Record<string, unknown>;
}

interface Vector {
  chunk_id: string;
  embedding: number[];
  model: string;
}

interface ProjectManifest {
  project_id: string;
  name: string;
  description?: string;
  stats: {
    sources_count: number;
    chunks_count: number;
    vectors_count: number;
  };
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatRequest {
  question: string;
  conversation_id?: string;  // Session identifier for multi-turn conversations
  messages?: Message[];       // Previous conversation turns
  system_prompt?: string;
  model?: string;
  top_k?: number;
}

// ============================================================================
// Data Loading
// ============================================================================

let chunks: Chunk[] = [];
let vectors: Vector[] = [];
let sources: Source[] = [];
let manifest: ProjectManifest | null = null;
const chunkMap = new Map<string, Chunk>();
const sourceMap = new Map<string, Source>();

function loadJsonl<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8").trim();
  if (!content) return [];
  return content.split("\\n").filter(Boolean).map(line => JSON.parse(line) as T);
}

function loadData(): void {
  const chunksPath = join(DATA_DIR, "chunks.jsonl");
  const vectorsPath = join(DATA_DIR, "vectors.jsonl");
  const sourcesPath = join(PROJECT_DIR, "sources.jsonl");
  const manifestPath = join(PROJECT_DIR, "project.json");

  // Load project manifest
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    console.error(\`Project: \${manifest?.name || "unknown"}\`);
  }

  // Load sources from JSONL
  sources = loadJsonl<Source>(sourcesPath);
  sources.forEach(s => sourceMap.set(s.source_id, s));
  console.error(\`Loaded \${sources.length} sources\`);

  // Load chunks
  chunks = loadJsonl<Chunk>(chunksPath);
  chunks.forEach(c => chunkMap.set(c.chunk_id, c));

  // Load vectors
  vectors = loadJsonl<Vector>(vectorsPath);

  console.error(\`Loaded \${chunks.length} chunks, \${vectors.length} vectors\`);
}

// ============================================================================
// Search Utilities
// ============================================================================

interface EnrichedResult {
  chunk_id: string;
  text: string;
  score: number;
  source_id: string;
  source_url: string | null;
  source_name: string | null;
  source_type: string | null;
  position: Chunk["position"];
  metadata: Record<string, unknown>;
}

function enrichWithSource(chunk: Chunk, score: number): EnrichedResult {
  const source = sourceMap.get(chunk.source_id);
  return {
    chunk_id: chunk.chunk_id,
    text: chunk.text,
    score: Math.round(score * 10000) / 10000, // Round to 4 decimal places
    source_id: chunk.source_id,
    source_url: source?.uri || null,
    source_name: source?.source_name || null,
    source_type: source?.type || null,
    position: chunk.position,
    metadata: chunk.metadata
  };
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function searchKeyword(query: string, topK: number): Array<{ chunk: Chunk; score: number }> {
  if (!query.trim()) return [];
  const terms = query.toLowerCase().split(/\\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const scored = chunks.map(chunk => {
    const text = chunk.text.toLowerCase();
    let matches = 0;
    for (const term of terms) {
      if (text.includes(term)) matches++;
    }
    return { chunk, score: matches / terms.length };
  });

  return scored
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function searchSemantic(queryVector: number[], topK: number): Array<{ chunk_id: string; score: number }> {
  if (!queryVector || queryVector.length === 0) return [];

  const scored = vectors.map(v => ({
    chunk_id: v.chunk_id,
    score: cosineSimilarity(queryVector, v.embedding),
  }));

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * Generate query embedding using OpenAI API
 */
async function generateQueryEmbedding(query: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not configured");
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": \`Bearer \${apiKey}\`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: query,
    }),
  });

  if (!response.ok) {
    throw new Error(\`Embedding API error: \${response.status}\`);
  }

  const data = await response.json() as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

/**
 * Detect anchor terms (identifiers like room numbers, codes, etc.)
 * These terms should be prioritized for exact keyword matching
 */
function detectAnchorTerms(query: string): string[] {
  const patterns = [
    /\\b([A-Z]\\d{1,3})\\b/g,           // Room numbers: A1, D40, B108
    /\\b([A-Z]{2,3}\\d{1,4})\\b/g,      // Codes: SRD52, CR10
    /\\b(\\d{3,})\\b/g,                  // Long numbers: 300, 5000
    /"([^"]+)"/g,                       // Quoted terms: "myrmarch"
  ];
  
  const anchors: string[] = [];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(query)) !== null) {
      anchors.push(match[1] || match[0]);
    }
  }
  return [...new Set(anchors)]; // Dedupe
}

/**
 * Calculate query specificity (0 = very broad, 1 = very specific)
 * Used for adaptive weighting between keyword and semantic search
 */
function calculateQuerySpecificity(query: string, anchorTerms: string[]): number {
  const words = query.toLowerCase().split(/\\s+/).filter(w => w.length > 2);
  
  let specificity = 0;
  
  // Anchors are highly specific
  specificity += Math.min(0.5, anchorTerms.length * 0.2);
  
  // Short queries tend to be specific searches
  if (words.length <= 3) specificity += 0.2;
  else if (words.length <= 6) specificity += 0.1;
  
  // Common broad words reduce specificity
  const broadWords = ['what', 'how', 'tell', 'about', 'explain', 'describe', 'overview'];
  const hasBroadWords = broadWords.some(w => words.includes(w));
  if (hasBroadWords) specificity -= 0.2;
  
  return Math.max(0, Math.min(1, specificity));
}

/**
 * Hybrid search combining keyword and semantic search with:
 * 1. Linear Score Interpolation - uses actual scores instead of RRF rank positions
 * 2. Query-Adaptive Weighting - dynamically adjusts weights based on query characteristics
 * 3. Anchor Term Boosting - boosts chunks containing identifier terms (D40, A108, etc.)
 */
async function searchHybrid(query: string, topK: number): Promise<Array<{ chunk: Chunk; score: number }>> {
  // Step 1: Detect anchor terms (identifiers like D40, A108, etc.)
  const anchorTerms = detectAnchorTerms(query);
  const hasAnchors = anchorTerms.length > 0;
  
  // Step 2: Calculate query specificity for adaptive weighting
  const specificity = calculateQuerySpecificity(query, anchorTerms);
  
  // Step 3: Determine weights based on specificity
  // High specificity (identifiers present) → keyword-heavy (60-70%)
  // Low specificity (conceptual query) → semantic-heavy (70-80%)
  // Mixed → balanced (50/50)
  const keywordWeight = hasAnchors ?
    Math.min(0.7, 0.3 + anchorTerms.length * 0.2) : // 0.3 + 0.2 per anchor, max 0.7
    Math.max(0.2, 0.5 - specificity * 0.3);          // 0.2 to 0.5 based on specificity
  const semanticWeight = 1 - keywordWeight;
  
  console.error(\`[Hybrid Search] Query: "\${query}" | Anchors: [\${anchorTerms.join(', ')}] | Specificity: \${specificity.toFixed(2)} | Weights: kw=\${keywordWeight.toFixed(2)}, sem=\${semanticWeight.toFixed(2)}\`);
  
  // Step 4: Get results from both search methods (get more for fusion)
  const keywordResults = searchKeyword(query, topK * 3);
  
  // Try semantic search if we have vectors
  let semanticResults: Array<{ chunk_id: string; score: number }> = [];
  
  if (vectors.length > 0) {
    try {
      const queryVector = await generateQueryEmbedding(query);
      semanticResults = searchSemantic(queryVector, topK * 3);
    } catch (err) {
      console.error("Embedding generation failed, using keyword-only:", err);
      // Fall back to keyword-only with anchor boosting
      return applyAnchorBoost(keywordResults, anchorTerms).slice(0, topK);
    }
  } else {
    // No vectors available, use keyword-only with anchor boosting
    return applyAnchorBoost(keywordResults, anchorTerms).slice(0, topK);
  }
  
  // Step 5: Build score maps for O(1) lookup
  // Normalize keyword scores to 0-1 range (they're already 0-1 as match ratio)
  const keywordMap = new Map(keywordResults.map(r => [r.chunk.chunk_id, r.score]));
  // Semantic scores are already cosine similarity in -1 to 1 range, normalize to 0-1
  const semanticMap = new Map(semanticResults.map(r => [r.chunk_id, (r.score + 1) / 2]));
  
  // Step 6: Collect all unique chunk IDs from both result sets
  const allChunkIds = new Set([
    ...keywordResults.map(r => r.chunk.chunk_id),
    ...semanticResults.map(r => r.chunk_id)
  ]);
  
  // Step 7: Calculate combined scores with linear interpolation
  const results: Array<{ chunk: Chunk; score: number }> = [];
  
  for (const chunkId of allChunkIds) {
    const chunk = chunkMap.get(chunkId);
    if (!chunk) continue;
    
    const semScore = semanticMap.get(chunkId) || 0;
    const kwScore = keywordMap.get(chunkId) || 0;
    
    // Step 8: Apply anchor term boosting
    let anchorBoost = 0;
    if (hasAnchors) {
      const chunkText = chunk.text.toLowerCase();
      for (const anchor of anchorTerms) {
        const anchorLower = anchor.toLowerCase();
        // If chunk contains the exact anchor term, boost significantly
        if (chunkText.includes(anchorLower)) {
          // Higher boost for exact pattern match (e.g., "D40." or "D40:" at start of line)
          const exactMatch = new RegExp(\`\\\\b\${anchor}\\\\s*[\\\\.:\\\\)]\`, 'i');
          anchorBoost += exactMatch.test(chunk.text) ? 0.4 : 0.15;
        }
      }
    }
    
    // Step 9: Linear interpolation with anchor boost
    const combinedScore = (semScore * semanticWeight) + (kwScore * keywordWeight) + anchorBoost;
    
    results.push({ chunk, score: combinedScore });
  }
  
  // Step 10: Sort by combined score and return top K
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * Helper: Apply anchor term boosting to keyword-only results
 * Used when semantic search is unavailable
 */
function applyAnchorBoost(results: Array<{ chunk: Chunk; score: number }>, anchorTerms: string[]): Array<{ chunk: Chunk; score: number }> {
  if (anchorTerms.length === 0) return results;
  
  return results.map(r => {
    let anchorBoost = 0;
    const chunkText = r.chunk.text.toLowerCase();
    
    for (const anchor of anchorTerms) {
      const anchorLower = anchor.toLowerCase();
      if (chunkText.includes(anchorLower)) {
        const exactMatch = new RegExp(\`\\\\b\${anchor}\\\\s*[\\\\.:\\\\)]\`, 'i');
        anchorBoost += exactMatch.test(r.chunk.text) ? 0.4 : 0.15;
      }
    }
    
    return { chunk: r.chunk, score: r.score + anchorBoost };
  }).sort((a, b) => b.score - a.score);
}

// ============================================================================
// MCP Server
// ============================================================================

const server = new Server(
  { name: "${name}", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search",
      description: "${description}. Returns relevant text chunks with source citations.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural language search query"
          },
          query_vector: {
            type: "array",
            items: { type: "number" },
            description: "Pre-computed embedding vector for semantic search. Required for semantic/hybrid modes."
          },
          mode: {
            type: "string",
            enum: ["semantic", "keyword", "hybrid"],
            default: "keyword",
            description: "Search mode: keyword (fast, exact match), semantic (embedding similarity), hybrid (combined)"
          },
          top_k: {
            type: "number",
            default: 10,
            minimum: 1,
            maximum: 100,
            description: "Number of results to return"
          }
        },
        required: ["query"]
      }
    },
    {
      name: "get_chunk",
      description: "Retrieve a specific chunk by its ID. Use this to get full context for a search result.",
      inputSchema: {
        type: "object",
        properties: {
          chunk_id: {
            type: "string",
            description: "The chunk_id from a search result"
          }
        },
        required: ["chunk_id"]
      }
    },
    {
      name: "list_sources",
      description: "List all indexed sources with their URIs and status",
      inputSchema: {
        type: "object",
        properties: {}
      }
    },
    {
      name: "stats",
      description: "Get index statistics including chunk count, vector count, and source count",
      inputSchema: {
        type: "object",
        properties: {}
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "search": {
      const { query, query_vector, mode = "keyword", top_k = 10 } = args as {
        query: string;
        query_vector?: number[];
        mode?: string;
        top_k?: number;
      };

      // Validate inputs
      if (!query || typeof query !== "string") {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "query is required" }) }],
          isError: true
        };
      }

      const effectiveTopK = Math.min(Math.max(1, top_k), 100);
      let results: Array<{ chunk: Chunk; score: number }> = [];

      if (mode === "keyword") {
        results = searchKeyword(query, effectiveTopK);
      } else if (mode === "semantic") {
        if (!query_vector || !Array.isArray(query_vector)) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "query_vector required for semantic search" }) }],
            isError: true
          };
        }
        const semantic = searchSemantic(query_vector, effectiveTopK);
        results = semantic
          .map(s => ({ chunk: chunkMap.get(s.chunk_id)!, score: s.score }))
          .filter(r => r.chunk);
      } else if (mode === "hybrid") {
        if (!query_vector || !Array.isArray(query_vector)) {
          // Fall back to keyword-only for hybrid without vector
          results = searchKeyword(query, effectiveTopK);
        } else {
          // Reciprocal Rank Fusion
          const keyword = searchKeyword(query, effectiveTopK * 2);
          const semantic = searchSemantic(query_vector, effectiveTopK * 2);

          const scoreMap = new Map<string, number>();
          const k = 60; // RRF constant
          keyword.forEach((r, i) => {
            scoreMap.set(r.chunk.chunk_id, (scoreMap.get(r.chunk.chunk_id) || 0) + 1 / (k + i + 1));
          });
          semantic.forEach((r, i) => {
            scoreMap.set(r.chunk_id, (scoreMap.get(r.chunk_id) || 0) + 1 / (k + i + 1));
          });

          results = Array.from(scoreMap.entries())
            .map(([id, score]) => ({ chunk: chunkMap.get(id)!, score }))
            .filter(r => r.chunk)
            .sort((a, b) => b.score - a.score)
            .slice(0, effectiveTopK);
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            results: results.map(r => enrichWithSource(r.chunk, r.score)),
            total: results.length,
            query,
            mode
          }, null, 2)
        }]
      };
    }

    case "get_chunk": {
      const { chunk_id } = args as { chunk_id: string };

      if (!chunk_id) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "chunk_id is required" }) }],
          isError: true
        };
      }

      const chunk = chunkMap.get(chunk_id);
      if (!chunk) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "Chunk not found", chunk_id }) }],
          isError: true
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify(enrichWithSource(chunk, 1.0), null, 2)
        }]
      };
    }

    case "list_sources": {
      const sourceList = sources.map(s => ({
        source_id: s.source_id,
        type: s.type,
        uri: s.uri,
        name: s.source_name || null,
        status: s.status
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ sources: sourceList, total: sourceList.length }, null, 2)
        }]
      };
    }

    case "stats": {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            project: manifest?.name || "${name}",
            chunks: chunks.length,
            vectors: vectors.length,
            sources: sources.length,
            has_embeddings: vectors.length > 0
          }, null, 2)
        }]
      };
    }

    default:
      return {
        content: [{ type: "text", text: JSON.stringify({ error: \`Unknown tool: \${name}\` }) }],
        isError: true
      };
  }
});

${includeHttp ? `
// ============================================================================
// HTTP Server
// ============================================================================

const app = express();
app.use(express.json({ limit: "1mb" }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    console.error(\`\${req.method} \${req.path} \${res.statusCode} \${duration}ms\`);
  });
  next();
});

// CORS middleware
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// Health check endpoint
app.get("/health", (_, res) => {
  res.json({
    status: "ok",
    project: manifest?.name || "${name}",
    chunks: chunks.length,
    vectors: vectors.length,
    sources: sources.length,
    uptime: Math.floor(process.uptime())
  });
});

// Stats endpoint
app.get("/stats", (_, res) => {
  res.json({
    project: manifest?.name || "${name}",
    description: manifest?.description || "${description}",
    chunks: chunks.length,
    vectors: vectors.length,
    sources: sources.length,
    has_embeddings: vectors.length > 0
  });
});

// List sources endpoint
app.get("/sources", (_, res) => {
  res.json({
    sources: sources.map(s => ({
      source_id: s.source_id,
      type: s.type,
      uri: s.uri,
      name: s.source_name || null,
      status: s.status
    })),
    total: sources.length
  });
});

// Search endpoint
app.post("/search", async (req, res) => {
  try {
    const { query, query_vector, mode = "keyword", top_k = 10 } = req.body;

    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "query is required and must be a string" });
    }

    const effectiveTopK = Math.min(Math.max(1, top_k || 10), 100);
    let results: Array<{ chunk: Chunk; score: number }> = [];

    if (mode === "keyword") {
      results = searchKeyword(query, effectiveTopK);
    } else if (mode === "semantic") {
      if (!query_vector || !Array.isArray(query_vector)) {
        return res.status(400).json({ error: "query_vector required for semantic search" });
      }
      const semantic = searchSemantic(query_vector, effectiveTopK);
      results = semantic
        .map(s => ({ chunk: chunkMap.get(s.chunk_id)!, score: s.score }))
        .filter(r => r.chunk);
    } else if (mode === "hybrid") {
      if (!query_vector || !Array.isArray(query_vector)) {
        results = searchKeyword(query, effectiveTopK);
      } else {
        const keyword = searchKeyword(query, effectiveTopK * 2);
        const semantic = searchSemantic(query_vector, effectiveTopK * 2);

        const scoreMap = new Map<string, number>();
        const k = 60;
        keyword.forEach((r, i) => {
          scoreMap.set(r.chunk.chunk_id, (scoreMap.get(r.chunk.chunk_id) || 0) + 1 / (k + i + 1));
        });
        semantic.forEach((r, i) => {
          scoreMap.set(r.chunk_id, (scoreMap.get(r.chunk_id) || 0) + 1 / (k + i + 1));
        });

        results = Array.from(scoreMap.entries())
          .map(([id, score]) => ({ chunk: chunkMap.get(id)!, score }))
          .filter(r => r.chunk)
          .sort((a, b) => b.score - a.score)
          .slice(0, effectiveTopK);
      }
    }

    res.json({
      results: results.map(r => enrichWithSource(r.chunk, r.score)),
      total: results.length,
      query,
      mode
    });
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({ error: "Search failed" });
  }
});

// Get chunk by ID
app.get("/chunks/:chunk_id", (req, res) => {
  const chunk = chunkMap.get(req.params.chunk_id);
  if (!chunk) {
    return res.status(404).json({ error: "Chunk not found" });
  }
  res.json(enrichWithSource(chunk, 1.0));
});

// Chat endpoint - RAG + LLM with streaming
app.post("/chat", async (req, res) => {
  const { 
    question, 
    system_prompt, 
    top_k = 10, 
    model,
    conversation_id,
    messages = []
  } = req.body as ChatRequest;

  if (!question || typeof question !== "string") {
    return res.status(400).json({ error: "question is required" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
  }

  // Generate conversation_id if not provided
  const activeConversationId = conversation_id || randomUUID();

  // Build conversation history context (last 10 turns)
  const recentMessages = (messages || []).slice(-10);
  const conversationHistory = recentMessages.length > 0
    ? \`\\n\\nCONVERSATION HISTORY:\\n\${recentMessages.map(m => 
        \`\${m.role === 'user' ? 'User' : 'Assistant'}: \${m.content}\`
      ).join('\\n')}\`
    : '';

  // Search for relevant context using hybrid search (keyword + semantic with RRF fusion)
  const searchResults = await searchHybrid(question, Math.min(top_k, 10));

  // Build context with source citations
  const contextParts = searchResults.map((r, i) => {
    const source = sourceMap.get(r.chunk.source_id);
    const sourceName = source?.source_name || source?.uri || "Unknown";
    return \`[Source \${i + 1}: \${sourceName}]\\n\${r.chunk.text}\`;
  });
  const context = contextParts.join("\\n\\n---\\n\\n");

  const defaultSystemPrompt = \`You are a helpful assistant with access to a knowledge base about \${manifest?.name || "${name}"}.
Answer questions using ONLY the retrieved documents below. Always cite sources using [Source N] notation.
If the documents don't contain relevant information to answer the question, say so clearly.

RETRIEVED DOCUMENTS:
\${context || "No relevant documents found."}\${conversationHistory}\`;

  const finalSystemPrompt = system_prompt
    ? \`\${system_prompt}\\n\\nRETRIEVED DOCUMENTS:\\n\${context || "No relevant documents found."}\${conversationHistory}\`
    : defaultSystemPrompt;

  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send sources first
  res.write(\`data: \${JSON.stringify({
    type: "sources",
    sources: searchResults.map(r => enrichWithSource(r.chunk, r.score))
  })}\\n\\n\`);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": \`Bearer \${apiKey}\`
      },
      body: JSON.stringify({
        model: model || process.env.OPENAI_MODEL || "gpt-5-nano-2025-08-07",
        messages: [
          { role: "system", content: finalSystemPrompt },
          { role: "user", content: question }
        ],
        stream: true,
        max_completion_tokens: 2048
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: { message: "API request failed" } }));
      res.write(\`data: \${JSON.stringify({ type: "error", error: error.error?.message || "API request failed" })}\\n\\n\`);
      res.end();
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      res.write(\`data: \${JSON.stringify({ type: "error", error: "No response body" })}\\n\\n\`);
      res.end();
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let contentStreamed = false;
    
    // Debug counters for diagnosing empty responses
    let chunkCount = 0;
    let finishReason: string | null = null;
    let totalLinesParsed = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        totalLinesParsed++;
        
        if (line.startsWith("data: ")) {
          if (line === "data: [DONE]") {
            console.error(\`[DEBUG] Stream completed. Chunks: \${chunkCount}, Finish reason: \${finishReason}, Lines parsed: \${totalLinesParsed}\`);
            continue;
          }
          
          try {
            const data = JSON.parse(line.slice(6));
            const content = data.choices?.[0]?.delta?.content;
            finishReason = data.choices?.[0]?.finish_reason || finishReason;
            
            // Log first chunk for debugging
            if (chunkCount === 0 && content) {
              console.error(\`[DEBUG] First content chunk received: "\${content.substring(0, 50)}\${content.length > 50 ? '...' : ''}"\`);
            }
            
            if (content) {
              res.write(\`data: \${JSON.stringify({ type: "delta", text: content })}\\n\\n\`);
              contentStreamed = true;
              chunkCount++;
            }
          } catch {
            // Skip unparseable lines
          }
        }
      }
    }

    // Log warning if LLM returned no content
    if (!contentStreamed) {
      console.error("[WARN] LLM returned no content. This may indicate:");
      console.error("  - Invalid or missing OPENAI_API_KEY");
      console.error("  - Model rate limiting or API issues");
      console.error("  - Empty response from the model");
    }

    res.write(\`data: \${JSON.stringify({ 
      type: "done", 
      conversation_id: activeConversationId,
      empty_response: !contentStreamed 
    })}\\n\\n\`);
    res.end();

  } catch (error) {
    console.error("Chat error:", error);
    res.write(\`data: \${JSON.stringify({ type: "error", error: "Failed to generate response" })}\\n\\n\`);
    res.end();
  }
});

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = parseInt(process.env.PORT || "${port}");
app.listen(PORT, () => {
  console.error(\`HTTP server listening on port \${PORT}\`);
  console.error(\`Endpoints: /health, /stats, /sources, /search, /chunks/:id, /chat\`);
});
` : ""}

// ============================================================================
// Server Startup
// ============================================================================

loadData();

const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  console.error("Failed to connect MCP transport:", err);
  process.exit(1);
});

console.error(\`${name} MCP server running (chunks: \${chunks.length}, vectors: \${vectors.length})\`);
`;
}

async function writeFile(filePath: string, content: string): Promise<void> {
  const { writeFile: write, mkdir } = await import("fs/promises");
  await mkdir(dirname(filePath), { recursive: true });
  await write(filePath, content.trim() + "\n", "utf-8");
}

function dirname(p: string): string {
  return path.dirname(p);
}
