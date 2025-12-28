/**
 * IndexFoundry-MCP Pipeline Tools
 * 
 * Orchestration tools for running and managing pipeline runs.
 */

import type { 
  PipelineRunInput, 
  RunStatusInput, 
  RunListInput,
  RunDiffInput,
  RunCleanupInput 
} from "../schemas/index.js";
import type { RunManifest, PhaseResult, PipelineResult } from "../types.js";
import { 
  createRunDirectory, 
  getRunDirectory,
  createInitialManifest,
  saveManifest,
  loadManifest,
  hashString,
  Timer,
  RunLogger,
} from "../utils.js";
import { v7 as uuidv7 } from "uuid";
import { promises as fs } from "fs";
import { join } from "path";

const RUNS_DIR = process.env.INDEXFOUNDRY_RUNS_DIR ?? "./runs";

export async function handlePipelineRun(
  params: PipelineRunInput
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown }> {
  const timer = new Timer();
  const runId = params.run_id ?? uuidv7();
  
  try {
    // Create run directory
    const runDir = await createRunDirectory(RUNS_DIR, runId);
    const logger = new RunLogger(runDir.paths.logs);
    logger.setContext("pipeline", "run");
    
    // Save config
    const configHash = hashString(JSON.stringify(params));
    await fs.writeFile(runDir.paths.config, JSON.stringify(params, null, 2));
    
    // Create initial manifest
    const manifest = createInitialManifest(runId, configHash);
    await saveManifest(runDir.paths.manifest, manifest);
    
    await logger.info(`Pipeline run started: ${runId}`);
    
    // Phase results tracking
    const phaseResults: Record<string, PhaseResult> = {};
    
    // TODO: Execute each phase
    // For now, return stub results
    
    const phases = ["connect", "extract", "normalize", "index"];
    if (params.serve?.auto_start) {
      phases.push("serve");
    }
    
    for (const phase of phases) {
      phaseResults[phase] = {
        status: "skipped",
        duration_ms: 0,
        artifacts_created: 0,
        errors: ["Not yet implemented"]
      };
    }
    
    // Update manifest
    manifest.status = "partial";
    manifest.completed_at = new Date().toISOString();
    manifest.timing.total_duration_ms = timer.elapsedMs();
    await saveManifest(runDir.paths.manifest, manifest);
    
    await logger.info(`Pipeline run completed (stub): ${runId}`);
    
    const result: PipelineResult = {
      run_id: runId,
      status: "partial",
      manifest_path: runDir.paths.manifest,
      phases: phaseResults as PipelineResult["phases"],
      summary: {
        sources_fetched: 0,
        chunks_indexed: 0,
        duration_ms: timer.elapsedMs(),
        errors: phases.length
      }
    };
    
    return {
      content: [{ type: "text", text: `Pipeline run created: ${runId} (implementation pending)` }],
      structuredContent: result
    };
    
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      structuredContent: {
        success: false,
        error: { code: "PIPELINE_ERROR", message }
      }
    };
  }
}

export async function handleRunStatus(
  params: RunStatusInput
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown }> {
  try {
    const runDir = await getRunDirectory(RUNS_DIR, params.run_id);
    if (!runDir) {
      return {
        content: [{ type: "text", text: `Run not found: ${params.run_id}` }],
        structuredContent: {
          success: false,
          error: { code: "RUN_NOT_FOUND", message: `Run ${params.run_id} does not exist` }
        }
      };
    }
    
    const manifest = await loadManifest(runDir.paths.manifest);
    
    return {
      content: [{ type: "text", text: `Run ${params.run_id}: ${manifest.status}` }],
      structuredContent: {
        success: true,
        manifest
      }
    };
    
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      structuredContent: {
        success: false,
        error: { code: "READ_ERROR", message }
      }
    };
  }
}

export async function handleRunList(
  params: RunListInput
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown }> {
  try {
    // List run directories
    const entries = await fs.readdir(RUNS_DIR, { withFileTypes: true });
    const runDirs = entries
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort()
      .reverse(); // Newest first (UUIDv7 is time-sorted)
    
    const runs: Array<{ run_id: string; status: string; created_at: string }> = [];
    
    for (const runId of runDirs.slice(0, params.limit)) {
      try {
        const manifestPath = join(RUNS_DIR, runId, "manifest.json");
        const manifest = await loadManifest(manifestPath);
        
        // Filter by status
        if (params.status !== "all" && manifest.status !== params.status) {
          continue;
        }
        
        // Filter by date
        if (params.before && manifest.created_at >= params.before) {
          continue;
        }
        if (params.after && manifest.created_at <= params.after) {
          continue;
        }
        
        runs.push({
          run_id: runId,
          status: manifest.status,
          created_at: manifest.created_at
        });
      } catch {
        // Skip invalid runs
      }
    }
    
    return {
      content: [{ type: "text", text: `Found ${runs.length} runs` }],
      structuredContent: {
        success: true,
        runs,
        total: runs.length
      }
    };
    
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      structuredContent: {
        success: false,
        error: { code: "LIST_ERROR", message }
      }
    };
  }
}

export async function handleRunDiff(
  params: RunDiffInput
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown }> {
  // TODO: Implement run comparison
  return {
    content: [{ type: "text", text: `[STUB] Would compare runs ${params.run_id_a} and ${params.run_id_b}` }],
    structuredContent: {
      success: false,
      error: { code: "NOT_IMPLEMENTED", message: "Run diff not yet implemented" }
    }
  };
}

export async function handleRunCleanup(
  params: RunCleanupInput
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown }> {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - params.older_than_days);
    const cutoffIso = cutoffDate.toISOString();
    
    const entries = await fs.readdir(RUNS_DIR, { withFileTypes: true });
    const toDelete: string[] = [];
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      try {
        const manifestPath = join(RUNS_DIR, entry.name, "manifest.json");
        const manifest = await loadManifest(manifestPath);
        
        if (manifest.created_at < cutoffIso) {
          toDelete.push(entry.name);
        }
      } catch {
        // Skip invalid runs
      }
    }
    
    if (params.dry_run) {
      return {
        content: [{ type: "text", text: `[DRY RUN] Would delete ${toDelete.length} runs` }],
        structuredContent: {
          success: true,
          dry_run: true,
          runs_to_delete: toDelete.length,
          run_ids: toDelete
        }
      };
    }
    
    // Actually delete
    let deleted = 0;
    for (const runId of toDelete) {
      const runPath = join(RUNS_DIR, runId);
      
      if (params.keep_manifests) {
        // Delete everything except manifest.json
        const files = await fs.readdir(runPath);
        for (const file of files) {
          if (file !== "manifest.json") {
            await fs.rm(join(runPath, file), { recursive: true, force: true });
          }
        }
      } else {
        await fs.rm(runPath, { recursive: true, force: true });
      }
      
      deleted++;
    }
    
    return {
      content: [{ type: "text", text: `Deleted ${deleted} runs` }],
      structuredContent: {
        success: true,
        dry_run: false,
        runs_deleted: deleted
      }
    };
    
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      structuredContent: {
        success: false,
        error: { code: "CLEANUP_ERROR", message }
      }
    };
  }
}
