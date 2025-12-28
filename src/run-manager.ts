/**
 * IndexFoundry-MCP: Run Manager
 *
 * Manages run directories, manifests, and phase coordination.
 * Ensures isolated, immutable workspaces for each pipeline run.
 *
 * Copyright (c) 2024 vario.automation
 * Proprietary and confidential. All rights reserved.
 */

import * as path from "path";
import * as fs from "fs/promises";
import type { RunManifest, PhaseManifest, IndexFoundryConfig } from "./types.js";
import {
  generateRunId,
  ensureDir,
  pathExists,
  writeJson,
  readJson,
  hashConfig,
  now,
  RunLogger,
} from "./utils.js";

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: IndexFoundryConfig = {
  version: "1.0.0",
  
  storage: {
    runs_dir: "./runs",
    max_runs: 100,
    cleanup_policy: "fifo",
  },
  
  defaults: {
    connect: {
      timeout_ms: 30000,
      max_file_size_mb: 50,
      user_agent: "IndexFoundry/1.0",
    },
    extract: {
      pdf_extractor: "pdf-parse",
      pdf_mode: "layout",
      ocr_engine: "tesseract",
    },
    normalize: {
      chunk_strategy: "recursive",
      max_chars: 1500,
      overlap_chars: 150,
    },
    index: {
      embedding_provider: "openai",
      embedding_model: "text-embedding-3-small",
      batch_size: 100,
    },
  },
  
  pinned_versions: {
    "pdf-parse": "1.1.1",
    "cheerio": "1.0.0",
  },
  
  security: {
    allowed_domains: [],
    blocked_domains: ["localhost", "127.0.0.1"],
    max_concurrent_fetches: 5,
  },
};

// ============================================================================
// Run Manager Class
// ============================================================================

export class RunManager {
  private baseDir: string;
  private config: IndexFoundryConfig;
  
  constructor(baseDir: string, config?: Partial<IndexFoundryConfig>) {
    this.baseDir = baseDir;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  
  // --------------------------------------------------------------------------
  // Run Lifecycle
  // --------------------------------------------------------------------------
  
  /**
   * Create a new run directory with all subdirectories
   */
  async createRun(runId?: string): Promise<{ runId: string; runDir: string; logger: RunLogger }> {
    const id = runId || generateRunId();
    const runDir = this.getRunDir(id);
    
    // Create directory structure
    await ensureDir(path.join(runDir, "raw"));
    await ensureDir(path.join(runDir, "extracted"));
    await ensureDir(path.join(runDir, "normalized"));
    await ensureDir(path.join(runDir, "indexed"));
    await ensureDir(path.join(runDir, "served"));
    await ensureDir(path.join(runDir, "logs"));
    
    // Initialize manifest
    const manifest: RunManifest = {
      run_id: id,
      created_at: now(),
      status: "running",
      config_hash: hashConfig(this.config),
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
    
    await writeJson(path.join(runDir, "manifest.json"), manifest);
    await writeJson(path.join(runDir, "config.json"), this.config);
    
    const logger = new RunLogger(runDir);
    await logger.init();
    
    return { runId: id, runDir, logger };
  }
  
  /**
   * Ensure a run exists, creating it if necessary.
   * This is the method tools should call to guarantee run infrastructure exists.
   */
  async ensureRun(runId: string): Promise<{ runId: string; runDir: string; isNew: boolean }> {
    const runDir = this.getRunDir(runId);
    const manifestPath = path.join(runDir, "manifest.json");
    
    // Check if run already exists
    if (await pathExists(manifestPath)) {
      return { runId, runDir, isNew: false };
    }
    
    // Create the run
    await this.createRun(runId);
    return { runId, runDir, isNew: true };
  }
  
  /**
   * Get an existing run's context
   */
  async getRun(runId: string): Promise<{ runDir: string; manifest: RunManifest; logger: RunLogger }> {
    const runDir = this.getRunDir(runId);
    
    if (!await pathExists(runDir)) {
      throw new Error(`Run not found: ${runId}`);
    }
    
    const manifest = await readJson<RunManifest>(path.join(runDir, "manifest.json"));
    const logger = new RunLogger(runDir);
    
    return { runDir, manifest, logger };
  }
  
  /**
   * Update run manifest
   */
  async updateManifest(runId: string, updates: Partial<RunManifest>): Promise<RunManifest> {
    const runDir = this.getRunDir(runId);
    const manifest = await readJson<RunManifest>(path.join(runDir, "manifest.json"));
    
    const updated: RunManifest = {
      ...manifest,
      ...updates,
      totals: { ...manifest.totals, ...updates.totals },
      timing: { ...manifest.timing, ...updates.timing },
      phases: { ...manifest.phases, ...updates.phases },
    };
    
    await writeJson(path.join(runDir, "manifest.json"), updated);
    return updated;
  }
  
  /**
   * Mark a phase as started
   */
  async startPhase(
    runId: string,
    phaseName: keyof RunManifest["phases"]
  ): Promise<PhaseManifest> {
    const phase: PhaseManifest = {
      started_at: now(),
      status: "running",
      inputs: { count: 0, hashes: [] },
      outputs: { count: 0, hashes: [] },
      tool_version: this.config.version,
      errors: [],
    };
    
    await this.updateManifest(runId, {
      phases: { [phaseName]: phase },
    });
    
    return phase;
  }
  
  /**
   * Mark a phase as completed
   */
  async completePhase(
    runId: string,
    phaseName: keyof RunManifest["phases"],
    result: Partial<PhaseManifest>
  ): Promise<void> {
    const { manifest } = await this.getRun(runId);
    const phase = manifest.phases[phaseName]!;
    
    const completed: PhaseManifest = {
      ...phase,
      ...result,
      completed_at: now(),
      status: result.errors?.length ? "failed" : "completed",
    };
    
    // Calculate phase duration
    const startTime = new Date(phase.started_at).getTime();
    const endTime = new Date(completed.completed_at!).getTime();
    const duration = endTime - startTime;
    
    await this.updateManifest(runId, {
      phases: { [phaseName]: completed },
      timing: {
        total_duration_ms: manifest.timing.total_duration_ms,
        phase_durations: {
          ...manifest.timing.phase_durations,
          [phaseName]: duration,
        },
      },
    });
  }
  
  /**
   * Complete the entire run
   */
  async completeRun(runId: string, status: RunManifest["status"]): Promise<RunManifest> {
    const { manifest } = await this.getRun(runId);
    
    const completedAt = now();
    const startTime = new Date(manifest.created_at).getTime();
    const endTime = new Date(completedAt).getTime();
    const totalDuration = endTime - startTime;
    
    return this.updateManifest(runId, {
      completed_at: completedAt,
      status,
      timing: {
        ...manifest.timing,
        total_duration_ms: totalDuration,
      },
    });
  }
  
  // --------------------------------------------------------------------------
  // Path Helpers
  // --------------------------------------------------------------------------
  
  getRunDir(runId: string): string {
    return path.join(this.baseDir, this.config.storage.runs_dir, runId);
  }
  
  getRawDir(runId: string): string {
    return path.join(this.getRunDir(runId), "raw");
  }
  
  getExtractedDir(runId: string): string {
    return path.join(this.getRunDir(runId), "extracted");
  }
  
  getNormalizedDir(runId: string): string {
    return path.join(this.getRunDir(runId), "normalized");
  }
  
  getIndexedDir(runId: string): string {
    return path.join(this.getRunDir(runId), "indexed");
  }
  
  getServedDir(runId: string): string {
    return path.join(this.getRunDir(runId), "served");
  }
  
  // --------------------------------------------------------------------------
  // Run Queries
  // --------------------------------------------------------------------------
  
  /**
   * List all runs
   */
  async listRuns(options?: {
    status?: "all" | "completed" | "running" | "failed";
    limit?: number;
    before?: string;
    after?: string;
  }): Promise<Array<{ run_id: string; status: string; created_at: string }>> {
    const runsDir = path.join(this.baseDir, this.config.storage.runs_dir);
    
    if (!await pathExists(runsDir)) {
      return [];
    }
    
    const entries = await fs.readdir(runsDir, { withFileTypes: true });
    const runs: Array<{ run_id: string; status: string; created_at: string }> = [];
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      const manifestPath = path.join(runsDir, entry.name, "manifest.json");
      if (!await pathExists(manifestPath)) continue;
      
      try {
        const manifest = await readJson<RunManifest>(manifestPath);
        
        // Apply filters
        if (options?.status && options.status !== "all" && manifest.status !== options.status) {
          continue;
        }
        
        if (options?.before && manifest.created_at >= options.before) {
          continue;
        }
        
        if (options?.after && manifest.created_at <= options.after) {
          continue;
        }
        
        runs.push({
          run_id: manifest.run_id,
          status: manifest.status,
          created_at: manifest.created_at,
        });
      } catch {
        // Skip invalid manifests
      }
    }
    
    // Sort by created_at descending (newest first)
    runs.sort((a, b) => b.created_at.localeCompare(a.created_at));
    
    // Apply limit
    if (options?.limit) {
      return runs.slice(0, options.limit);
    }
    
    return runs;
  }
  
  /**
   * Cleanup old runs
   */
  async cleanup(options: {
    older_than_days: number;
    keep_manifests?: boolean;
    dry_run?: boolean;
  }): Promise<{ deleted: string[]; errors: string[] }> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - options.older_than_days);
    const cutoffIso = cutoff.toISOString();
    
    const runs = await this.listRuns({ before: cutoffIso });
    const deleted: string[] = [];
    const errors: string[] = [];
    
    for (const run of runs) {
      const runDir = this.getRunDir(run.run_id);
      
      if (options.dry_run) {
        deleted.push(run.run_id);
        continue;
      }
      
      try {
        if (options.keep_manifests) {
          // Delete everything except manifest.json
          const entries = await fs.readdir(runDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name === "manifest.json") continue;
            const fullPath = path.join(runDir, entry.name);
            await fs.rm(fullPath, { recursive: true });
          }
        } else {
          await fs.rm(runDir, { recursive: true });
        }
        deleted.push(run.run_id);
      } catch (e) {
        errors.push(`Failed to delete ${run.run_id}: ${e}`);
      }
    }
    
    return { deleted, errors };
  }
  
  // --------------------------------------------------------------------------
  // Configuration Access
  // --------------------------------------------------------------------------
  
  getConfig(): IndexFoundryConfig {
    return this.config;
  }
  
  getDefaults(): IndexFoundryConfig["defaults"] {
    return this.config.defaults;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalManager: RunManager | null = null;

export function initRunManager(baseDir: string, config?: Partial<IndexFoundryConfig>): RunManager {
  globalManager = new RunManager(baseDir, config);
  return globalManager;
}

export function getRunManager(): RunManager {
  if (!globalManager) {
    throw new Error("RunManager not initialized. Call initRunManager first.");
  }
  return globalManager;
}
