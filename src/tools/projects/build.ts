/** Project build and checkpoint operations. */

import path from "path";
import { v4 as uuidv4 } from "uuid";
import {
  ProjectBuildInput,
  ProjectBuildStatusInput,
  ProjectManifest,
  SourceRecord,
  ChunkRecord,
  VectorRecord,
  ChunkOptions,
  BuildCheckpoint,
} from "../../schemas-projects.js";
import {
  ensureDir,
  pathExists,
  readJson,
  readJsonl,
  appendJsonl,
  writeJsonl,
  writeJson,
  createToolError,
  sha256,
  now,
} from "../../utils.js";
import { fetchSource, chunkContent, embedChunks } from "./ingest.js";
import {
  getProjectPaths,
  createBuildMetrics,
  logMetric,
  EMBEDDING_COST_PER_1M_TOKENS,
} from "./config.js";
import type { ToolError } from "../../types.js";

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
