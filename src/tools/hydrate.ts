/**
 * Context Expansion / Chunk Hydration
 * 
 * This module provides context expansion for search results by fetching
 * adjacent and parent chunks to provide fuller context for retrieved results.
 * 
 * Features:
 * - 📖 Fetch adjacent chunks (before/after a retrieved chunk)
 * - 🔗 Fetch parent chunks using parent_id (from hierarchical chunking)
 * - 🌳 Build hierarchy path from chunk to root
 * - ⚙️ Configure expansion depth and strategy
 * 
 * @module tools/hydrate
 * 
 * Copyright (c) 2024 vario.automation
 * Proprietary and confidential. All rights reserved.
 */

import { z } from 'zod';
import * as path from 'path';
import type { DocumentChunk } from '../types.js';
import { readJsonl, createToolError } from '../utils.js';

// ============================================================================
// Types
// ============================================================================

/** Strategy for context expansion: adjacent chunks, parent hierarchy, or both */
export type ExpandContextStrategy = 'adjacent' | 'parent' | 'both';

/**
 * Options for hydrating chunks with context.
 * Controls which context chunks are fetched and limits.
 */
export interface HydrateOptions {
  /** Whether context expansion is enabled */
  enabled: boolean;
  /** Strategy: 'adjacent' (siblings), 'parent' (hierarchy), or 'both' */
  strategy: ExpandContextStrategy;
  /** Number of chunks to fetch before the target chunk */
  adjacent_before: number;
  /** Number of chunks to fetch after the target chunk */
  adjacent_after: number;
  /** Whether to include the immediate parent chunk */
  include_parent: boolean;
  /** Maximum total context chunks to return (for limiting response size) */
  max_total_chunks: number;
}

/**
 * Context information attached to a hydrated search result.
 * Contains adjacent siblings and parent hierarchy information.
 */
export interface HydratedContext {
  /** Immediate parent chunk (if include_parent=true and parent exists) */
  parent?: DocumentChunk;
  /** Chunks appearing before the target in document order */
  siblings_before: DocumentChunk[];
  /** Chunks appearing after the target in document order */
  siblings_after: DocumentChunk[];
  /** Path of chunk_ids from root to target: [root, ..., parent, target] */
  hierarchy_path?: string[];
}

/**
 * A search result enhanced with context information.
 * Combines the original chunk/score with hydrated context.
 */
export interface HydratedSearchResult {
  /** The original matched chunk */
  chunk: DocumentChunk;
  /** Relevance score from search */
  score: number;
  /** Hydrated context (adjacent chunks, parent, hierarchy) */
  context: HydratedContext;
}

/**
 * Input format for search results before hydration.
 */
export interface SearchResultInput {
  /** The matched chunk */
  chunk: DocumentChunk;
  /** Relevance score */
  score: number;
}

// ============================================================================
// Schema
// ============================================================================

/**
 * Zod schema for context expansion options.
 * Used in ServeQueryInputSchema and validated at tool boundaries.
 */
export const ExpandContextInputSchema = z.object({
  enabled: z.boolean().default(false)
    .describe("🔗 Enable context expansion to fetch related chunks"),
  strategy: z.enum(['adjacent', 'parent', 'both']).default('both')
    .describe("📚 Strategy: 'adjacent' (siblings), 'parent' (hierarchy), or 'both'"),
  adjacent_before: z.number().int().min(0).max(5).default(1)
    .describe("⬆️ Number of chunks to fetch before the target (0-5)"),
  adjacent_after: z.number().int().min(0).max(5).default(1)
    .describe("⬇️ Number of chunks to fetch after the target (0-5)"),
  include_parent: z.boolean().default(true)
    .describe("🌳 Include the immediate parent chunk in context"),
  max_total_chunks: z.number().int().min(1).max(20).default(10)
    .describe("📊 Maximum total context chunks to return (1-20)")
});

/** Inferred type from ExpandContextInputSchema */
export type ExpandContextInput = z.infer<typeof ExpandContextInputSchema>;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Find adjacent chunks (before/after) for a given chunk within the same document.
 * Chunks are ordered by chunk_index to ensure deterministic results.
 * 
 * @param chunk - The target chunk to find neighbors for
 * @param allChunks - All chunks available (typically from the same run)
 * @param before - Number of chunks to retrieve before the target
 * @param after - Number of chunks to retrieve after the target
 * @returns Object with before and after chunk arrays
 * 
 * @example
 * const { before, after } = findAdjacentChunks(targetChunk, allChunks, 2, 2);
 * // before: [chunk at index-2, chunk at index-1]
 * // after: [chunk at index+1, chunk at index+2]
 */
function findAdjacentChunks(
  chunk: DocumentChunk,
  allChunks: DocumentChunk[],
  before: number,
  after: number
): { before: DocumentChunk[]; after: DocumentChunk[] } {
  // Filter chunks from same document (same doc_id)
  const sameDocChunks = allChunks.filter(c => c.doc_id === chunk.doc_id);
  
  // Sort by chunk_index for deterministic ordering
  sameDocChunks.sort((a, b) => a.chunk_index - b.chunk_index);
  
  // Find current chunk position
  const currentIdx = sameDocChunks.findIndex(c => c.chunk_id === chunk.chunk_id);
  
  if (currentIdx === -1) {
    return { before: [], after: [] };
  }
  
  // Get before chunks (limit by available and requested)
  const beforeChunks = sameDocChunks.slice(Math.max(0, currentIdx - before), currentIdx);
  
  // Get after chunks
  const afterChunks = sameDocChunks.slice(currentIdx + 1, currentIdx + 1 + after);
  
  return { before: beforeChunks, after: afterChunks };
}

/**
 * Find the parent chain from a chunk to the root.
 * Traverses parent_id references to build the ancestor chain.
 * Includes circular reference detection to prevent infinite loops.
 * 
 * @param chunk - The starting chunk
 * @param allChunks - All chunks available for parent lookup
 * @returns Array of parent chunks ordered [immediate parent, grandparent, ...]
 * 
 * @example
 * // For chunk c7 with hierarchy: c1 -> c5 -> c6 -> c7
 * const chain = findParentChain(c7, allChunks);
 * // Returns: [c6, c5, c1]
 */
function findParentChain(
  chunk: DocumentChunk,
  allChunks: DocumentChunk[]
): DocumentChunk[] {
  const chain: DocumentChunk[] = [];
  const visited = new Set<string>(); // Prevent circular references
  let current = chunk;
  
  while (current.parent_id) {
    // Detect circular reference
    if (visited.has(current.parent_id)) {
      break;
    }
    visited.add(current.chunk_id);
    
    const parent = allChunks.find(c => c.chunk_id === current.parent_id);
    if (!parent) break;
    
    chain.push(parent);
    current = parent;
  }
  
  return chain; // Ordered: [immediate parent, grandparent, ...]
}

/**
 * Build hierarchy path from root to current chunk.
 * Returns an array of chunk_ids representing the path.
 * 
 * @param chunk - The target chunk
 * @param allChunks - All chunks available for parent lookup
 * @returns Array of chunk_ids from root to target, or undefined if no hierarchy
 * 
 * @example
 * // For chunk c7 with hierarchy: c1 -> c5 -> c6 -> c7
 * const path = buildHierarchyPath(c7, allChunks);
 * // Returns: ['c1', 'c5', 'c6', 'c7']
 */
function buildHierarchyPath(
  chunk: DocumentChunk,
  allChunks: DocumentChunk[]
): string[] | undefined {
  // If chunk has no parent_id and hierarchy_level is 0 or undefined, no hierarchy
  if (!chunk.parent_id && (!chunk.hierarchy_level || chunk.hierarchy_level === 0)) {
    return undefined;
  }
  
  const chain = findParentChain(chunk, allChunks);
  
  // If no parents found, just return current chunk
  if (chain.length === 0) {
    return [chunk.chunk_id];
  }
  
  // Return chunk_ids from root to current
  return [...chain.map(c => c.chunk_id).reverse(), chunk.chunk_id];
}

/**
 * Enforce max_total_chunks limit on context.
 * Prioritizes: parent > immediate siblings > distant siblings.
 * 
 * @param context - The context object to limit
 * @param maxTotal - Maximum total chunks allowed
 * @returns Limited context with chunks trimmed to fit limit
 * 
 * @example
 * const limited = enforceMaxChunks({ parent: p, siblings_before: [a,b,c], siblings_after: [d,e] }, 3);
 * // Returns: { parent: p, siblings_before: [c], siblings_after: [d] } (parent + 2 closest siblings)
 */
function enforceMaxChunks(
  context: {
    parent?: DocumentChunk;
    siblings_before: DocumentChunk[];
    siblings_after: DocumentChunk[];
  },
  maxTotal: number
): typeof context {
  // Parent has highest priority
  let count = context.parent ? 1 : 0;
  
  if (count >= maxTotal) {
    return {
      parent: context.parent,
      siblings_before: [],
      siblings_after: []
    };
  }
  
  const remaining = maxTotal - count;
  
  // Distribute remaining evenly between before and after, prioritizing closer chunks
  const halfRemaining = Math.floor(remaining / 2);
  const otherHalf = remaining - halfRemaining;
  
  // Before chunks: take the last N (closest to current)
  const beforeCount = Math.min(context.siblings_before.length, halfRemaining);
  const trimmedBefore = context.siblings_before.slice(-beforeCount);
  
  // After chunks: take the first N (closest to current)
  const afterCount = Math.min(context.siblings_after.length, otherHalf);
  const trimmedAfter = context.siblings_after.slice(0, afterCount);
  
  return {
    parent: context.parent,
    siblings_before: trimmedBefore,
    siblings_after: trimmedAfter
  };
}

/**
 * Safely read chunks JSONL file with error handling.
 * Returns empty array if file doesn't exist or can't be read.
 * 
 * @param chunksPath - Path to the chunks.jsonl file
 * @returns Array of DocumentChunks, or empty array on error
 */
async function loadChunksFromFile(chunksPath: string): Promise<DocumentChunk[]> {
  try {
    return await readJsonl<DocumentChunk>(chunksPath);
  } catch {
    // File doesn't exist or is unreadable - return empty array
    // This allows hydration to work gracefully with empty context
    return [];
  }
}

// ============================================================================
// Main Functions
// ============================================================================

/**
 * Hydrate a single chunk with context (adjacent and/or parent chunks).
 * 
 * This function enriches a search result with surrounding context,
 * making it easier to understand the chunk in its original document context.
 * 
 * @param chunk - The source chunk to hydrate
 * @param allChunks - All chunks from the document/run for context lookup
 * @param options - Hydration options (strategy, limits, etc.)
 * @param score - Optional relevance score (defaults to 0)
 * @returns Hydrated result with context chunks attached
 * 
 * @example
 * const hydrated = await hydrateChunk(chunk, allChunks, {
 *   enabled: true,
 *   strategy: 'both',
 *   adjacent_before: 2,
 *   adjacent_after: 2,
 *   include_parent: true,
 *   max_total_chunks: 10
 * });
 * 
 * console.log(hydrated.context.siblings_before); // 2 chunks before
 * console.log(hydrated.context.parent?.content.text); // Parent heading
 */
export async function hydrateChunk(
  chunk: DocumentChunk,
  allChunks: DocumentChunk[],
  options: HydrateOptions,
  score?: number
): Promise<HydratedSearchResult> {
  // If hydration is disabled, return empty context
  if (!options.enabled) {
    return {
      chunk,
      score: score ?? 0,
      context: {
        siblings_before: [],
        siblings_after: [],
        parent: undefined,
        hierarchy_path: undefined
      }
    };
  }

  let siblings_before: DocumentChunk[] = [];
  let siblings_after: DocumentChunk[] = [];
  let parent: DocumentChunk | undefined;
  let hierarchy_path: string[] | undefined;

  // Handle adjacent strategy
  if (options.strategy === 'adjacent' || options.strategy === 'both') {
    const adjacent = findAdjacentChunks(
      chunk,
      allChunks,
      options.adjacent_before,
      options.adjacent_after
    );
    siblings_before = adjacent.before;
    siblings_after = adjacent.after;
  }

  // Handle parent strategy
  if (options.strategy === 'parent' || options.strategy === 'both') {
    if (options.include_parent && chunk.parent_id) {
      parent = allChunks.find(c => c.chunk_id === chunk.parent_id);
    }
    
    // Always build hierarchy path when using parent strategy
    hierarchy_path = buildHierarchyPath(chunk, allChunks);
  }

  // Apply max_total_chunks limit
  const limitedContext = enforceMaxChunks(
    { parent, siblings_before, siblings_after },
    options.max_total_chunks
  );

  return {
    chunk,
    score: score ?? 0,
    context: {
      ...limitedContext,
      hierarchy_path
    }
  };
}

/**
 * Hydrate multiple search results with context.
 * 
 * This function processes an array of search results, adding context
 * to each one. It handles deduplication to ensure context chunks
 * don't duplicate chunks already in the main results.
 * 
 * @param results - Array of search results to hydrate
 * @param runId - Run ID for locating the chunks.jsonl file
 * @param options - Hydration options (strategy, limits, etc.)
 * @returns Array of hydrated search results with context
 * 
 * @example
 * const results = await searchVectors(query, { top_k: 5 });
 * const hydrated = await hydrateSearchResults(results, runId, {
 *   enabled: true,
 *   strategy: 'both',
 *   adjacent_before: 1,
 *   adjacent_after: 1,
 *   include_parent: true,
 *   max_total_chunks: 5
 * });
 * 
 * // Each result now has context.siblings_before, context.siblings_after, etc.
 * for (const r of hydrated) {
 *   console.log(`Chunk: ${r.chunk.chunk_id}, Parent: ${r.context.parent?.chunk_id}`);
 * }
 */
export async function hydrateSearchResults(
  results: SearchResultInput[],
  runId: string,
  options: HydrateOptions
): Promise<HydratedSearchResult[]> {
  // Handle empty results
  if (results.length === 0) {
    return [];
  }

  // Load all chunks from the run's JSONL file
  const runsDir = path.join(process.cwd(), '.indexfoundry', 'runs', runId);
  const chunksPath = path.join(runsDir, 'normalized', 'chunks.jsonl');
  
  const allChunks = await loadChunksFromFile(chunksPath);

  // Collect all result chunk IDs for deduplication
  const resultChunkIds = new Set(results.map(r => r.chunk.chunk_id));

  // Hydrate each result
  const hydratedResults: HydratedSearchResult[] = [];

  for (const result of results) {
    const score = result.score ?? 0;
    
    const hydrated = await hydrateChunk(
      result.chunk,
      allChunks,
      options,
      score
    );

    // Filter out chunks that are already in the main results (deduplication)
    hydrated.context.siblings_before = hydrated.context.siblings_before.filter(
      c => !resultChunkIds.has(c.chunk_id)
    );
    hydrated.context.siblings_after = hydrated.context.siblings_after.filter(
      c => !resultChunkIds.has(c.chunk_id)
    );

    hydratedResults.push(hydrated);
  }

  return hydratedResults;
}
