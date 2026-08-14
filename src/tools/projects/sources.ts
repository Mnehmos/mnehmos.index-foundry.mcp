/** Project source management operations. */

import {
  ProjectAddSourceInput,
  ProjectRemoveSourceInput,
  ProjectManifest,
  SourceRecord,
  ChunkRecord,
  VectorRecord,
} from "../../schemas-projects.js";
import {
  pathExists,
  readJson,
  readJsonl,
  appendJsonl,
  writeJsonl,
  writeJson,
  createToolError,
  now,
  sha256,
} from "../../utils.js";
import { getProjectPaths } from "./config.js";
import type { ToolError } from "../../types.js";

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

type RemovalTarget = {
  source_id?: string;
  source_uri?: string;
};

interface RemovalSelection {
  success: true;
  removed: RemoveSourceResult["removed"];
  notFound: string[];
  sourceIdsToRemove: string[];
}

async function readWithRetry<T>(filePath: string, maxRetries = 3): Promise<T[]> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (!(await pathExists(filePath))) return [];
      return await readJsonl<T>(filePath);
    } catch {
      if (attempt === maxRetries - 1) return [];
      await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
  return [];
}

function validateRemovalInput(
  input: ProjectRemoveSourceInput,
  removeChunks: boolean,
  removeVectors: boolean
): ToolError | null {
  const hasSingleSource = Boolean(input.source_id || input.source_uri);
  const hasBatch = Boolean(input.batch && input.batch.length > 0);

  if (!hasSingleSource && !hasBatch) {
    return createToolError("NO_SOURCE", "Must provide source_id, source_uri, OR batch array", {
      recoverable: true,
    });
  }

  if ((removeChunks || removeVectors) && !input.confirm) {
    return createToolError(
      "CONFIRMATION_REQUIRED",
      "Set confirm: true to remove source and associated chunks/vectors",
      { recoverable: true }
    );
  }

  return null;
}

function getRemovalTargets(input: ProjectRemoveSourceInput): RemovalTarget[] {
  const targets: RemovalTarget[] = [];

  if (input.source_id || input.source_uri) {
    targets.push({ source_id: input.source_id, source_uri: input.source_uri });
  }

  if (input.batch && input.batch.length > 0) {
    targets.push(...input.batch);
  }

  return targets;
}

function selectSourcesForRemoval(
  existingSources: SourceRecord[],
  targets: RemovalTarget[]
): RemovalSelection | ToolError {
  const removed: RemovalSelection["removed"] = [];
  const notFound: string[] = [];
  const sourceIdsToRemove: string[] = [];

  for (const target of targets) {
    const source = existingSources.find(candidate =>
      (target.source_id && candidate.source_id === target.source_id) ||
      (target.source_uri && candidate.uri === target.source_uri)
    );
    const identifier = target.source_id || target.source_uri || "unknown";

    if (!source) {
      notFound.push(identifier);
      continue;
    }

    if (source.status === "processing") {
      return createToolError(
        "SOURCE_PROCESSING",
        `Cannot remove source '${source.source_id}' while it is being processed`,
        { recoverable: true }
      );
    }

    sourceIdsToRemove.push(source.source_id);
    removed.push({
      source_id: source.source_id,
      uri: source.uri,
      chunks_removed: 0,
      vectors_removed: 0,
    });
  }

  return { success: true, removed, notFound, sourceIdsToRemove };
}

function incrementRemovalCount(
  removed: RemoveSourceResult["removed"],
  sourceId: string,
  field: "chunks_removed" | "vectors_removed"
): void {
  const entry = removed.find(item => item.source_id === sourceId);
  if (entry) entry[field]++;
}

async function removeCascadeData(
  paths: ReturnType<typeof getProjectPaths>,
  sourceIdsToRemove: string[],
  removed: RemoveSourceResult["removed"],
  removeChunks: boolean,
  removeVectors: boolean
): Promise<void> {
  if (sourceIdsToRemove.length === 0 || (!removeChunks && !removeVectors)) return;

  const sourceIdSet = new Set(sourceIdsToRemove);
  const chunkIdsToRemove = new Set<string>();
  const chunkToSourceMap = new Map<string, string>();

  if (await pathExists(paths.chunks)) {
    const existingChunks = await readJsonl<ChunkRecord>(paths.chunks);

    for (const chunk of existingChunks) {
      if (sourceIdSet.has(chunk.source_id)) {
        chunkIdsToRemove.add(chunk.chunk_id);
        chunkToSourceMap.set(chunk.chunk_id, chunk.source_id);
      }
    }

    if (removeChunks) {
      const remainingChunks = existingChunks.filter(chunk => {
        if (!sourceIdSet.has(chunk.source_id)) return true;
        incrementRemovalCount(removed, chunk.source_id, "chunks_removed");
        return false;
      });
      await writeJsonl(paths.chunks, remainingChunks);
    }
  }

  if (removeVectors && await pathExists(paths.vectors)) {
    const existingVectors = await readJsonl<VectorRecord>(paths.vectors);
    const remainingVectors = existingVectors.filter(vector => {
      const sourceId = chunkToSourceMap.get(vector.chunk_id);
      if (!sourceId || !chunkIdsToRemove.has(vector.chunk_id)) return true;
      incrementRemovalCount(removed, sourceId, "vectors_removed");
      return false;
    });
    await writeJsonl(paths.vectors, remainingVectors);
  }
}

async function persistSourceRemoval(
  paths: ReturnType<typeof getProjectPaths>,
  existingSources: SourceRecord[],
  sourceIdsToRemove: string[],
  removeChunks: boolean,
  removeVectors: boolean
): Promise<void> {
  const sourceIdSet = new Set(sourceIdsToRemove);
  const remainingSources = existingSources.filter(source => !sourceIdSet.has(source.source_id));

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeJsonl(paths.sources, remainingSources);
      break;
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const manifest = await readJson<ProjectManifest>(paths.manifest);
      manifest.stats.sources_count = remainingSources.length;

      if (removeChunks && await pathExists(paths.chunks)) {
        manifest.stats.chunks_count = (await readJsonl<ChunkRecord>(paths.chunks)).length;
      }
      if (removeVectors && await pathExists(paths.vectors)) {
        manifest.stats.vectors_count = (await readJsonl<VectorRecord>(paths.vectors)).length;
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

export async function projectRemoveSource(input: ProjectRemoveSourceInput): Promise<RemoveSourceResult | ToolError> {
  const paths = getProjectPaths(input.project_id);
  const removeChunks = input.remove_chunks ?? true;
  const removeVectors = input.remove_vectors ?? true;

  if (!(await pathExists(paths.manifest))) {
    return createToolError("NOT_FOUND", `Project '${input.project_id}' not found`, {
      recoverable: false,
    });
  }

  const validationError = validateRemovalInput(input, removeChunks, removeVectors);
  if (validationError) return validationError;

  try {
    const existingSources = await readWithRetry<SourceRecord>(paths.sources);
    const selection = selectSourcesForRemoval(existingSources, getRemovalTargets(input));
    if (!selection.success) return selection;

    await removeCascadeData(
      paths,
      selection.sourceIdsToRemove,
      selection.removed,
      removeChunks,
      removeVectors
    );

    if (selection.sourceIdsToRemove.length > 0) {
      await persistSourceRemoval(
        paths,
        existingSources,
        selection.sourceIdsToRemove,
        removeChunks,
        removeVectors
      );
    }

    const totalChunks = selection.removed.reduce((sum, item) => sum + item.chunks_removed, 0);
    const totalVectors = selection.removed.reduce((sum, item) => sum + item.vectors_removed, 0);

    return {
      success: true,
      project_id: input.project_id,
      removed: selection.removed,
      not_found: selection.notFound,
      message: `Removed ${selection.removed.length} source(s), ${totalChunks} chunks, ${totalVectors} vectors. ${selection.notFound.length} not found.`,
    };
  } catch (err) {
    return createToolError("REMOVE_FAILED", `Failed to remove sources: ${err}`, {
      recoverable: true,
    });
  }
}
