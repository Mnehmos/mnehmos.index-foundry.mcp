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
