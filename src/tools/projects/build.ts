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

interface BuildRunState {
  paths: ReturnType<typeof getProjectPaths>;
  manifest: ProjectManifest;
  chunkOptions: Required<ChunkOptions>;
  buildMetrics: ReturnType<typeof createBuildMetrics>;
  result: ProjectBuildResult;
  existingHashes: Set<string>;
  chunkIndex: number;
  newlyCompletedSourceIds: string[];
  resumedTokens: number;
  resumedDuration: number;
  totalFetchTime: number;
  totalChunkTime: number;
  totalEmbedTime: number;
}

interface EmbeddedSourceResult {
  chunks: ChunkRecord[];
  vectors: VectorRecord[];
  fetchDuration: number;
  chunkDuration: number;
  embedDuration: number;
}

async function fetchChunkAndEmbed(
  source: SourceRecord,
  state: BuildRunState
): Promise<EmbeddedSourceResult> {
  logMetric("fetch", "Processing source", {
    source_id: source.source_id,
    type: source.type,
    uri: source.uri,
  });
  source.status = "processing";

  const fetchStart = Date.now();
  const content = await fetchSource(source, state.paths.runs);
  const fetchDuration = Date.now() - fetchStart;
  state.buildMetrics.phaseTimings[`fetch_${source.source_id}`] = fetchDuration;
  state.totalFetchTime += fetchDuration;

  const chunkStart = Date.now();
  const chunks = chunkContent(
    content,
    source.source_id,
    state.manifest.chunk_config,
    state.chunkIndex,
    state.existingHashes
  );
  state.chunkIndex += chunks.length;
  const chunkDuration = Date.now() - chunkStart;
  state.buildMetrics.phaseTimings[`chunk_${source.source_id}`] = chunkDuration;
  state.totalChunkTime += chunkDuration;

  const embedStart = Date.now();
  const embedResult = await embedChunks(chunks, state.manifest.embedding_model);
  const embedDuration = Date.now() - embedStart;
  state.buildMetrics.phaseTimings[`embed_${source.source_id}`] = embedDuration;
  state.totalEmbedTime += embedDuration;
  state.buildMetrics.tokensUsed += embedResult.tokensUsed;
  state.buildMetrics.estimatedCostUsd += embedResult.estimatedCostUsd;

  return {
    chunks,
    vectors: embedResult.vectors,
    fetchDuration,
    chunkDuration,
    embedDuration,
  };
}

function recordSourceSuccess(
  source: SourceRecord,
  processed: EmbeddedSourceResult,
  sourceStart: number,
  state: BuildRunState
): void {
  source.status = "completed";
  source.processed_at = now();
  source.stats = {
    files_fetched: 1,
    chunks_created: processed.chunks.length,
    vectors_created: processed.vectors.length,
  };

  state.result.sources_processed++;
  state.result.chunks_added += processed.chunks.length;
  state.result.vectors_added += processed.vectors.length;
  state.buildMetrics.sourcesProcessed++;
  state.buildMetrics.chunksCreated += processed.chunks.length;
  state.buildMetrics.vectorsCreated += processed.vectors.length;
  state.newlyCompletedSourceIds.push(source.source_id);

  logMetric("source", "Source complete", {
    source_id: source.source_id,
    chunks: processed.chunks.length,
    vectors: processed.vectors.length,
    duration_ms: Date.now() - sourceStart,
  });
}

function recordSourceFailure(
  source: SourceRecord,
  error: unknown,
  sourceStart: number,
  state: BuildRunState
): void {
  source.status = "failed";
  source.error = String(error);
  state.result.errors.push({
    source_id: source.source_id,
    error: String(error),
  });
  state.buildMetrics.sourcesFailed++;
  state.newlyCompletedSourceIds.push(source.source_id);

  logMetric("error", "Source failed", {
    source_id: source.source_id,
    error: String(error),
    duration_ms: Date.now() - sourceStart,
  });
}

async function processBuildSource(
  source: SourceRecord,
  state: BuildRunState,
  projectId: string
): Promise<void> {
  const sourceStart = Date.now();

  try {
    const processed = await fetchChunkAndEmbed(source, state);
    if (processed.chunks.length > 0) {
      await appendJsonl(state.paths.chunks, processed.chunks);
      await appendJsonl(state.paths.vectors, processed.vectors);
    }

    recordSourceSuccess(source, processed, sourceStart, state);
    await saveBuildCheckpointForProject(projectId, state);
  } catch (err) {
    recordSourceFailure(source, err, sourceStart, state);
    await saveBuildCheckpointForProject(projectId, state);
  }
}

async function saveBuildCheckpointForProject(
  projectId: string,
  state: BuildRunState
): Promise<void> {
  if (!state.chunkOptions.enable_checkpointing) return;

  const checkpoint: BuildCheckpoint = {
    checkpoint_id: uuidv4(),
    project_id: projectId,
    created_at: now(),
    completed_source_ids: state.newlyCompletedSourceIds,
    stats: {
      chunks_added: state.result.chunks_added,
      vectors_added: state.result.vectors_added,
      tokens_used: state.buildMetrics.tokensUsed + state.resumedTokens,
      duration_ms: Date.now() - state.buildMetrics.startTime + state.resumedDuration,
    },
  };
  await saveCheckpoint(projectId, checkpoint);
  state.result.progress.checkpoint_id = checkpoint.checkpoint_id;
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
    const chunkOptions: Required<ChunkOptions> = {
      ...getDefaultChunkOptions(),
      ...input.chunk_options,
    };

    let completedSourceIds = new Set<string>();
    let resumedChunks = 0;
    let resumedVectors = 0;
    let resumedTokens = 0;
    let resumedDuration = 0;

    if (input.resume_from_checkpoint) {
      const checkpoint = await loadCheckpoint(input.project_id);
      if (checkpoint) {
        completedSourceIds = new Set(checkpoint.completed_source_ids);
        resumedChunks = checkpoint.stats.chunks_added;
        resumedVectors = checkpoint.stats.vectors_added;
        resumedTokens = checkpoint.stats.tokens_used;
        resumedDuration = checkpoint.stats.duration_ms;
        logMetric("checkpoint", "Resuming from checkpoint", {
          checkpoint_id: checkpoint.checkpoint_id,
          completed_sources: completedSourceIds.size,
        });
      }
    }

    const allPending = allSources.filter(source =>
      completedSourceIds.has(source.source_id)
        ? false
        : input.force || source.status === "pending" || source.status === "failed"
    );
    const totalSources = allSources.length;
    const sourcesToProcess = allPending.slice(0, chunkOptions.max_sources_per_build);
    const remainingAfterThisRun = allPending.length - sourcesToProcess.length;

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
      return createEmptyResult(
        `Dry run: would process ${sourcesToProcess.length} of ${allPending.length} pending sources`
      );
    }

    if (sourcesToProcess.length === 0) {
      if (chunkOptions.enable_checkpointing) {
        await clearCheckpoint(input.project_id);
      }
      return createEmptyResult("No pending sources to process");
    }

    const buildMetrics = createBuildMetrics();
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

    const existingChunks = await pathExists(paths.chunks)
      ? await readJsonl<ChunkRecord>(paths.chunks)
      : [];
    const existingHashes = new Set<string>();
    for (const chunk of existingChunks) {
      existingHashes.add(
        chunk.metadata?.content_hash as string ||
        sha256(Buffer.from(chunk.text)).slice(0, 16)
      );
    }

    const state: BuildRunState = {
      paths,
      manifest,
      chunkOptions,
      buildMetrics,
      result,
      existingHashes,
      chunkIndex: existingChunks.length,
      newlyCompletedSourceIds: [...completedSourceIds],
      resumedTokens,
      resumedDuration,
      totalFetchTime: 0,
      totalChunkTime: 0,
      totalEmbedTime: 0,
    };

    for (const source of sourcesToProcess) {
      await processBuildSource(source, state, input.project_id);
    }

    await writeJsonl(paths.sources, allSources);
    manifest.stats.chunks_count += result.chunks_added - resumedChunks;
    manifest.stats.vectors_count += result.vectors_added - resumedVectors;
    manifest.stats.total_tokens += buildMetrics.tokensUsed;
    manifest.updated_at = now();
    await writeJson(paths.manifest, manifest);

    const totalDuration = Date.now() - buildMetrics.startTime;
    result.progress.processed_this_run = result.sources_processed + result.errors.length;
    result.progress.remaining = remainingAfterThisRun;
    result.progress.has_more = remainingAfterThisRun > 0;

    if (result.sources_processed > 0 && remainingAfterThisRun > 0) {
      result.progress.estimated_remaining_ms = Math.round(
        (totalDuration / result.sources_processed) * remainingAfterThisRun
      );
    }

    result.metrics = {
      duration_ms: totalDuration + resumedDuration,
      fetch_time_ms: state.totalFetchTime,
      chunk_time_ms: state.totalChunkTime,
      embed_time_ms: state.totalEmbedTime,
      tokens_used: buildMetrics.tokensUsed + resumedTokens,
      estimated_cost_usd:
        (buildMetrics.tokensUsed + resumedTokens) / 1_000_000 * EMBEDDING_COST_PER_1M_TOKENS,
      avg_source_time_ms:
        result.sources_processed > 0
          ? Math.round(totalDuration / result.sources_processed)
          : 0,
    };

    result.message = `Processed ${result.sources_processed} sources: +${result.chunks_added - resumedChunks} chunks, +${result.vectors_added - resumedVectors} vectors`;
    if (result.errors.length > 0) result.message += ` (${result.errors.length} errors)`;
    if (result.progress.has_more) result.message += ` [${remainingAfterThisRun} remaining]`;
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
