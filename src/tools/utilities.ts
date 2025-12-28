/**
 * IndexFoundry-MCP: Utility Tools
 *
 * Run management utilities: status, list, diff, cleanup.
 *
 * Copyright (c) 2024 vario.automation
 * Proprietary and confidential. All rights reserved.
 */

import * as path from "path";
import * as fs from "fs/promises";
import type { RunManifest, ToolError } from "../types.js";
import type { 
  RunStatusInput, 
  RunListInput, 
  RunDiffInput, 
  RunCleanupInput 
} from "../schemas.js";
import {
  pathExists,
  readJson,
  readJsonl,
  createToolError,
} from "../utils.js";
import { getRunManager } from "../run-manager.js";

// ============================================================================
// Run Status
// ============================================================================

export interface RunStatusResult {
  run_id: string;
  status: RunManifest["status"];
  created_at: string;
  completed_at?: string;
  phases: {
    [key: string]: {
      status: string;
      duration_ms?: number;
      inputs?: number;
      outputs?: number;
      errors?: number;
    };
  };
  totals: RunManifest["totals"];
  timing: RunManifest["timing"];
}

export async function runStatus(input: RunStatusInput): Promise<RunStatusResult | ToolError> {
  const manager = getRunManager();
  
  try {
    const { manifest } = await manager.getRun(input.run_id);
    
    // Build phase summary
    const phases: RunStatusResult["phases"] = {};
    
    for (const [phaseName, phaseData] of Object.entries(manifest.phases)) {
      if (phaseData) {
        const startTime = new Date(phaseData.started_at).getTime();
        const endTime = phaseData.completed_at 
          ? new Date(phaseData.completed_at).getTime() 
          : Date.now();
        
        phases[phaseName] = {
          status: phaseData.status,
          duration_ms: endTime - startTime,
          inputs: phaseData.inputs.count,
          outputs: phaseData.outputs.count,
          errors: phaseData.errors.length,
        };
      }
    }
    
    return {
      run_id: manifest.run_id,
      status: manifest.status,
      created_at: manifest.created_at,
      completed_at: manifest.completed_at,
      phases,
      totals: manifest.totals,
      timing: manifest.timing,
    };
  } catch (err) {
    if (String(err).includes("not found")) {
      return createToolError("RUN_NOT_FOUND", `Run not found: ${input.run_id}`, {
        recoverable: false,
      });
    }
    throw err;
  }
}

// ============================================================================
// Run List
// ============================================================================

export interface RunListResult {
  runs: Array<{
    run_id: string;
    status: string;
    created_at: string;
    sources?: number;
    chunks?: number;
  }>;
  total: number;
  filtered: number;
}

export async function runList(input: RunListInput): Promise<RunListResult | ToolError> {
  const manager = getRunManager();
  
  try {
    const runs = await manager.listRuns({
      status: input.status === "all" ? undefined : input.status,
      limit: input.limit,
      before: input.before,
      after: input.after,
    });
    
    // Enrich with totals
    const enriched = await Promise.all(
      runs.map(async run => {
        try {
          const { manifest } = await manager.getRun(run.run_id);
          return {
            run_id: run.run_id,
            status: run.status,
            created_at: run.created_at,
            sources: manifest.totals.sources_fetched,
            chunks: manifest.totals.chunks_created,
          };
        } catch {
          return {
            run_id: run.run_id,
            status: run.status,
            created_at: run.created_at,
          };
        }
      })
    );
    
    return {
      runs: enriched,
      total: enriched.length,
      filtered: input.status !== "all" ? enriched.length : enriched.length,
    };
  } catch (err) {
    return createToolError("FETCH_FAILED", `Failed to list runs: ${err}`, {
      recoverable: true,
    });
  }
}

// ============================================================================
// Run Diff
// ============================================================================

export interface RunDiffResult {
  run_a: { run_id: string; created_at: string };
  run_b: { run_id: string; created_at: string };
  config_changed: boolean;
  sources: {
    added: string[];
    removed: string[];
    unchanged: number;
  };
  chunks?: {
    added: number;
    removed: number;
    unchanged: number;
  };
  summary: string;
}

export async function runDiff(input: RunDiffInput): Promise<RunDiffResult | ToolError> {
  const manager = getRunManager();
  
  try {
    const { manifest: manifestA, runDir: runDirA } = await manager.getRun(input.run_id_a);
    const { manifest: manifestB, runDir: runDirB } = await manager.getRun(input.run_id_b);
    
    // Compare config hashes
    const configChanged = manifestA.config_hash !== manifestB.config_hash;
    
    // Compare sources
    const rawManifestPathA = path.join(runDirA, "raw", "raw_manifest.jsonl");
    const rawManifestPathB = path.join(runDirB, "raw", "raw_manifest.jsonl");
    
    let sourcesA: Array<{ uri: string; sha256: string }> = [];
    let sourcesB: Array<{ uri: string; sha256: string }> = [];
    
    if (await pathExists(rawManifestPathA)) {
      sourcesA = await readJsonl(rawManifestPathA);
    }
    if (await pathExists(rawManifestPathB)) {
      sourcesB = await readJsonl(rawManifestPathB);
    }
    
    const urisA = new Set(sourcesA.map(s => s.uri));
    const urisB = new Set(sourcesB.map(s => s.uri));
    
    const added = [...urisB].filter(u => !urisA.has(u));
    const removed = [...urisA].filter(u => !urisB.has(u));
    const unchanged = [...urisA].filter(u => urisB.has(u)).length;
    
    // Compare chunks if requested
    let chunkDiff: RunDiffResult["chunks"] | undefined;
    
    if (input.include_chunks) {
      const chunksPathA = path.join(runDirA, "normalized", "chunks.jsonl");
      const chunksPathB = path.join(runDirB, "normalized", "chunks.jsonl");
      
      let chunksA: Array<{ chunk_id: string }> = [];
      let chunksB: Array<{ chunk_id: string }> = [];
      
      if (await pathExists(chunksPathA)) {
        chunksA = await readJsonl(chunksPathA);
      }
      if (await pathExists(chunksPathB)) {
        chunksB = await readJsonl(chunksPathB);
      }
      
      const chunkIdsA = new Set(chunksA.map(c => c.chunk_id));
      const chunkIdsB = new Set(chunksB.map(c => c.chunk_id));
      
      chunkDiff = {
        added: [...chunkIdsB].filter(id => !chunkIdsA.has(id)).length,
        removed: [...chunkIdsA].filter(id => !chunkIdsB.has(id)).length,
        unchanged: [...chunkIdsA].filter(id => chunkIdsB.has(id)).length,
      };
    }
    
    // Generate summary
    const summaryParts: string[] = [];
    if (configChanged) summaryParts.push("Config changed");
    if (added.length) summaryParts.push(`+${added.length} sources`);
    if (removed.length) summaryParts.push(`-${removed.length} sources`);
    if (chunkDiff) {
      if (chunkDiff.added) summaryParts.push(`+${chunkDiff.added} chunks`);
      if (chunkDiff.removed) summaryParts.push(`-${chunkDiff.removed} chunks`);
    }
    
    return {
      run_a: { run_id: manifestA.run_id, created_at: manifestA.created_at },
      run_b: { run_id: manifestB.run_id, created_at: manifestB.created_at },
      config_changed: configChanged,
      sources: { added, removed, unchanged },
      chunks: chunkDiff,
      summary: summaryParts.length ? summaryParts.join(", ") : "No changes detected",
    };
  } catch (err) {
    if (String(err).includes("not found")) {
      return createToolError("RUN_NOT_FOUND", `One or both runs not found`, {
        recoverable: false,
      });
    }
    throw err;
  }
}

// ============================================================================
// Run Cleanup
// ============================================================================

export interface RunCleanupResult {
  dry_run: boolean;
  runs_checked: number;
  runs_deleted: string[];
  space_freed_mb?: number;
  errors: string[];
}

export async function runCleanup(input: RunCleanupInput): Promise<RunCleanupResult | ToolError> {
  const manager = getRunManager();
  
  try {
    const result = await manager.cleanup({
      older_than_days: input.older_than_days,
      keep_manifests: input.keep_manifests,
      dry_run: input.dry_run,
    });
    
    return {
      dry_run: input.dry_run,
      runs_checked: result.deleted.length + result.errors.length,
      runs_deleted: result.deleted,
      errors: result.errors,
    };
  } catch (err) {
    return createToolError("FETCH_FAILED", `Failed to cleanup runs: ${err}`, {
      recoverable: true,
    });
  }
}
