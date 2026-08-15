/**
 * Retrieval algorithms for IndexFoundry projects.
 *
 * This module is deliberately pure: it holds no module-level state and performs
 * no I/O, so the exact code that runs in an exported server is what the test
 * suite exercises. `index.ts` supplies the loaded corpus and an embedding
 * function; nothing here knows about files, HTTP, or API keys.
 *
 * It is copied into exported projects alongside index.ts.
 *
 * Copyright (c) vario.automation
 * Proprietary and confidential. All rights reserved.
 */

export interface Chunk {
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

export interface Vector {
  chunk_id: string;
  embedding: number[];
  model: string;
}

export interface ScoredChunk {
  chunk: Chunk;
  score: number;
}

/** The corpus a search runs against. */
export interface SearchContext {
  chunks: Chunk[];
  vectors: Vector[];
  chunkMap: Map<string, Chunk>;
}

/** Standard RRF constant, balancing keyword and semantic contributions. */
export const RRF_CONSTANT = 60;

export function buildSearchContext(chunks: Chunk[], vectors: Vector[]): SearchContext {
  return {
    chunks,
    vectors,
    chunkMap: new Map(chunks.map((c) => [c.chunk_id, c])),
  };
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function searchKeyword(ctx: SearchContext, query: string, topK: number): ScoredChunk[] {
  if (!query.trim()) return [];
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const scored = ctx.chunks.map((chunk) => {
    const text = chunk.text.toLowerCase();
    let matches = 0;
    for (const term of terms) {
      if (text.includes(term)) matches++;
    }
    return { chunk, score: matches / terms.length };
  });

  return scored
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export function searchSemantic(
  ctx: SearchContext,
  queryVector: number[],
  topK: number
): Array<{ chunk_id: string; score: number }> {
  if (!queryVector || queryVector.length === 0) return [];

  return ctx.vectors
    .map((v) => ({
      chunk_id: v.chunk_id,
      score: cosineSimilarity(queryVector, v.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * Detect anchor terms (identifiers like room numbers, codes, etc.)
 * These terms should be prioritized for exact keyword matching.
 */
export function detectAnchorTerms(query: string): string[] {
  const patterns = [
    /\b([A-Z]\d{1,3})\b/g, // Room numbers: A1, D40, B108
    /\b([A-Z]{2,3}\d{1,4})\b/g, // Codes: SRD52, CR10
    /\b(\d{3,})\b/g, // Long numbers: 300, 5000
    /"([^"]+)"/g, // Quoted terms: "myrmarch"
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
 * Calculate query specificity (0 = very broad, 1 = very specific).
 * Used for adaptive weighting between keyword and semantic search.
 */
export function calculateQuerySpecificity(query: string, anchorTerms: string[]): number {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);

  let specificity = 0;

  // Anchors are highly specific
  specificity += Math.min(0.5, anchorTerms.length * 0.2);

  // Short queries tend to be specific searches
  if (words.length <= 3) specificity += 0.2;
  else if (words.length <= 6) specificity += 0.1;

  // Common broad words reduce specificity
  const broadWords = ["what", "how", "tell", "about", "explain", "describe", "overview"];
  const hasBroadWords = broadWords.some((w) => words.includes(w));
  if (hasBroadWords) specificity -= 0.2;

  return Math.max(0, Math.min(1, specificity));
}

/** How much a chunk containing an anchor term is boosted. */
function anchorBoostFor(text: string, anchorTerms: string[]): number {
  let boost = 0;
  const lowered = text.toLowerCase();
  for (const anchor of anchorTerms) {
    if (lowered.includes(anchor.toLowerCase())) {
      // Higher boost for an exact pattern match (e.g. "D40." or "D40:")
      const exactMatch = new RegExp(`\\b${anchor}\\s*[\\.:\\)]`, "i");
      boost += exactMatch.test(text) ? 0.4 : 0.15;
    }
  }
  return boost;
}

/**
 * Apply anchor term boosting to keyword-only results.
 * Used when semantic search is unavailable.
 */
export function applyAnchorBoost(results: ScoredChunk[], anchorTerms: string[]): ScoredChunk[] {
  if (anchorTerms.length === 0) return results;

  return results
    .map((r) => ({ chunk: r.chunk, score: r.score + anchorBoostFor(r.chunk.text, anchorTerms) }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Reciprocal Rank Fusion over precomputed keyword and semantic result lists.
 */
export function fuseWithRrf(
  ctx: SearchContext,
  keyword: ScoredChunk[],
  semantic: Array<{ chunk_id: string; score: number }>,
  topK: number
): ScoredChunk[] {
  const scoreMap = new Map<string, number>();

  keyword.forEach((r, i) => {
    scoreMap.set(
      r.chunk.chunk_id,
      (scoreMap.get(r.chunk.chunk_id) || 0) + 1 / (RRF_CONSTANT + i + 1)
    );
  });
  semantic.forEach((r, i) => {
    scoreMap.set(r.chunk_id, (scoreMap.get(r.chunk_id) || 0) + 1 / (RRF_CONSTANT + i + 1));
  });

  return Array.from(scoreMap.entries())
    .map(([id, score]) => ({ chunk: ctx.chunkMap.get(id), score }))
    .filter((r): r is ScoredChunk => r.chunk !== undefined)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * Caller-supplied-vector search, backing the MCP `search` tool and `/search`.
 * Throws if a mode requiring a vector is used without one.
 */
export function runSearch(
  ctx: SearchContext,
  params: { query: string; queryVector?: number[]; mode: string; topK: number }
): ScoredChunk[] {
  const { query, queryVector, mode, topK } = params;

  if (mode === "semantic") {
    if (!queryVector || !Array.isArray(queryVector)) {
      throw new Error("query_vector required for semantic search");
    }
    return searchSemantic(ctx, queryVector, topK)
      .map((s) => ({ chunk: ctx.chunkMap.get(s.chunk_id), score: s.score }))
      .filter((r): r is ScoredChunk => r.chunk !== undefined);
  }

  if (mode === "hybrid") {
    if (!queryVector || !Array.isArray(queryVector)) {
      // Fall back to keyword-only for hybrid without a vector
      return searchKeyword(ctx, query, topK);
    }
    return fuseWithRrf(
      ctx,
      searchKeyword(ctx, query, topK * 2),
      searchSemantic(ctx, queryVector, topK * 2),
      topK
    );
  }

  return searchKeyword(ctx, query, topK);
}

export interface HybridSearchDiagnostics {
  anchorTerms: string[];
  specificity: number;
  keywordWeight: number;
  semanticWeight: number;
  mode: "hybrid" | "keyword";
}

export interface HybridSearchOutcome {
  results: ScoredChunk[];
  diagnostics: HybridSearchDiagnostics;
}

/**
 * Server-side hybrid search: the server embeds the query itself.
 *
 * Combines keyword and semantic search with:
 * 1. Linear score interpolation - uses actual scores, not RRF rank positions
 * 2. Query-adaptive weighting - weights shift with query characteristics
 * 3. Anchor term boosting - favours chunks containing identifiers (D40, A108)
 *
 * `embed` is injected so this stays pure and testable; the exported server
 * passes its OpenAI-backed implementation. If `embed` throws, the search
 * degrades to keyword-only rather than failing.
 */
export async function searchHybrid(
  ctx: SearchContext,
  query: string,
  topK: number,
  embed: (query: string) => Promise<number[]>,
  onDiagnostics?: (message: string) => void
): Promise<HybridSearchOutcome> {
  const anchorTerms = detectAnchorTerms(query);
  const hasAnchors = anchorTerms.length > 0;
  const specificity = calculateQuerySpecificity(query, anchorTerms);

  // High specificity (identifiers present) → keyword-heavy (60-70%)
  // Low specificity (conceptual query)     → semantic-heavy (70-80%)
  const keywordWeight = hasAnchors
    ? Math.min(0.7, 0.3 + anchorTerms.length * 0.2)
    : Math.max(0.2, 0.5 - specificity * 0.3);
  const semanticWeight = 1 - keywordWeight;

  onDiagnostics?.(
    `[Hybrid Search] Query: "${query}" | Anchors: [${anchorTerms.join(", ")}] | ` +
      `Specificity: ${specificity.toFixed(2)} | ` +
      `Weights: kw=${keywordWeight.toFixed(2)}, sem=${semanticWeight.toFixed(2)}`
  );

  const keywordResults = searchKeyword(ctx, query, topK * 3);

  const keywordOnly = (): HybridSearchOutcome => ({
    results: applyAnchorBoost(keywordResults, anchorTerms).slice(0, topK),
    diagnostics: {
      anchorTerms,
      specificity,
      keywordWeight,
      semanticWeight,
      mode: "keyword",
    },
  });

  if (ctx.vectors.length === 0) return keywordOnly();

  let semanticResults: Array<{ chunk_id: string; score: number }>;
  try {
    const queryVector = await embed(query);
    semanticResults = searchSemantic(ctx, queryVector, topK * 3);
  } catch (err) {
    onDiagnostics?.(`Embedding generation failed, using keyword-only: ${String(err)}`);
    return keywordOnly();
  }

  // Keyword scores are already a 0-1 match ratio; cosine similarity is -1..1,
  // so it is rescaled to 0-1 before interpolation.
  const keywordMap = new Map(keywordResults.map((r) => [r.chunk.chunk_id, r.score]));
  const semanticMap = new Map(semanticResults.map((r) => [r.chunk_id, (r.score + 1) / 2]));

  const allChunkIds = new Set([
    ...keywordResults.map((r) => r.chunk.chunk_id),
    ...semanticResults.map((r) => r.chunk_id),
  ]);

  const results: ScoredChunk[] = [];
  for (const chunkId of allChunkIds) {
    const chunk = ctx.chunkMap.get(chunkId);
    if (!chunk) continue;

    const semScore = semanticMap.get(chunkId) || 0;
    const kwScore = keywordMap.get(chunkId) || 0;
    const boost = hasAnchors ? anchorBoostFor(chunk.text, anchorTerms) : 0;

    results.push({
      chunk,
      score: semScore * semanticWeight + kwScore * keywordWeight + boost,
    });
  }

  return {
    results: results.sort((a, b) => b.score - a.score).slice(0, topK),
    diagnostics: {
      anchorTerms,
      specificity,
      keywordWeight,
      semanticWeight,
      mode: "hybrid",
    },
  };
}
