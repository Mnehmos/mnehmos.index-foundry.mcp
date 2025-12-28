/**
 * 🔍 Retrieval Debugging Tool
 *
 * Provides trace logging and expected vs actual comparison for diagnosing
 * RAG retrieval quality issues. Helps identify why certain queries don't
 * return expected results.
 *
 * Features:
 * - Pipeline tracing (embed, search, rerank steps with timing)
 * - Similarity score analysis
 * - Expected vs actual result comparison
 * - Diagnostic suggestions for improvement
 * - Export debug reports for analysis
 *
 * Copyright (c) 2024 vario.automation
 * Proprietary and confidential. All rights reserved.
 */

import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { DocumentChunk } from '../types.js';
import {
  readJsonl,
  createToolError,
  generateMockEmbedding,
  cosineSimilarity,
} from '../utils.js';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * A single step in the debug trace pipeline.
 * Records timing and details for each phase of query processing.
 */
export interface DebugTraceStep {
  /** Step name: "embed", "search", "rerank", "filter", "load" */
  step: string;
  /** ISO timestamp when step completed */
  timestamp: string;
  /** Duration of step in milliseconds */
  duration_ms: number;
  /** Step-specific details (varies by step type) */
  details: Record<string, unknown>;
}

/**
 * A single result item with scoring and metadata.
 * Represents a chunk that was retrieved for the query.
 */
export interface DebugResultItem {
  /** Rank position (1 = highest score) */
  rank: number;
  /** Unique chunk identifier */
  chunk_id: string;
  /** Parent document identifier */
  doc_id: string;
  /** Cosine similarity score [0, 1] */
  score: number;
  /** First 200 characters of chunk text */
  text_preview: string;
  /** Chunk metadata */
  metadata: Record<string, unknown>;
}

/**
 * Comparison results between expected and actual results.
 * Tracks precision, recall, and which expected items were found/missing.
 */
export interface DebugComparison {
  /** Expected IDs that were found in results */
  expected_found: string[];
  /** Expected IDs that were NOT found in results */
  expected_missing: string[];
  /** Top results that weren't in expected list */
  unexpected_top: string[];
  /** Precision: expected_found / results.length */
  precision: number;
  /** Recall: expected_found / expected.length */
  recall: number;
}

/**
 * Diagnostic analysis of the retrieval results.
 * Provides suggestions for improving retrieval quality.
 */
export interface DebugDiagnostics {
  /** Primary issue identified (if any) */
  issue?: string;
  /** Actionable recommendations for improvement */
  suggestions: string[];
  /** Statistical summary of similarity scores */
  score_distribution: {
    min: number;
    max: number;
    mean: number;
    median: number;
  };
}

/**
 * Complete debug query result with trace, results, and analysis.
 * Main output structure for the debugQuery function.
 */
export interface DebugQueryResult {
  /** Original query text */
  query: string;
  /** Query embedding vector (only if include_embeddings=true) */
  query_embedding?: number[];
  /** Pipeline execution trace */
  trace: DebugTraceStep[];
  /** Ranked retrieval results with scores */
  results: DebugResultItem[];
  /** Expected vs actual comparison (if expected provided) */
  comparison?: DebugComparison;
  /** Diagnostic analysis and suggestions */
  diagnostics: DebugDiagnostics;
  /** Path to exported report file (if export_report=true) */
  report_path?: string;
}

// ============================================================================
// Internal Types
// ============================================================================

interface EmbeddingRecord {
  chunk_id: string;
  embedding: number[];
}

interface ChunkWithEmbedding {
  chunk: DocumentChunk;
  embedding: number[];
}

// ============================================================================
// Schema Definition
// ============================================================================

/**
 * Input schema for the debug query tool.
 * Validates and types all input parameters.
 */
export const DebugQueryInputSchema = z.object({
  // Required parameters
  run_id: z.string().uuid()
    .describe("🔑 Run directory UUID identifying the indexed data to query"),
  query: z.string().min(1)
    .describe("🔍 Query text to debug through the retrieval pipeline"),

  // Expected results for comparison
  expected: z.object({
    chunk_ids: z.array(z.string()).optional()
      .describe("📋 Expected chunk IDs that should appear in results"),
    doc_ids: z.array(z.string()).optional()
      .describe("📄 Expected document IDs that should appear in results"),
    keywords: z.array(z.string()).optional()
      .describe("🏷️ Keywords that should appear in result text"),
    min_matches: z.number().int().min(0).default(1)
      .describe("✅ Minimum number of expected items that must match"),
  }).optional()
    .describe("🎯 Expected results for comparison (chunk_ids, doc_ids, keywords)"),

  // Debug options
  options: z.object({
    top_k: z.number().int().min(1).max(100).default(10)
      .describe("📊 Number of top results to return (1-100)"),
    include_embeddings: z.boolean().default(false)
      .describe("🧮 Include raw embedding vectors in output"),
    include_all_scores: z.boolean().default(true)
      .describe("📈 Include similarity scores for all results"),
    trace_level: z.enum(["minimal", "standard", "verbose"]).default("standard")
      .describe("📝 Level of detail in pipeline trace (minimal|standard|verbose)"),
    export_report: z.boolean().default(false)
      .describe("💾 Export debug report to JSON file"),
  }).optional()
    .describe("⚙️ Debug options (top_k, trace_level, export_report)"),
}).strict();

export type DebugQueryInput = z.infer<typeof DebugQueryInputSchema>;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Record a trace step with timing information.
 *
 * @param stepName - Name of the pipeline step
 * @param startTime - Step start time (from Date.now())
 * @param details - Step-specific details
 * @returns Formatted trace step object
 */
function recordStep(
  stepName: string,
  startTime: number,
  details: Record<string, unknown>
): DebugTraceStep {
  return {
    step: stepName,
    timestamp: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
    details,
  };
}

/**
 * Compare actual results against expected results.
 * Calculates precision, recall, and identifies missing/unexpected items.
 *
 * @param results - Actual retrieval results
 * @param expected - Expected chunk_ids, doc_ids, and/or keywords
 * @returns Comparison metrics and item lists
 */
function compareResults(
  results: DebugResultItem[],
  expected: { chunk_ids?: string[]; doc_ids?: string[]; keywords?: string[] }
): DebugComparison {
  const resultChunkIds = new Set(results.map(r => r.chunk_id));
  const resultDocIds = new Set(results.map(r => r.doc_id));

  const expectedChunkIds = expected.chunk_ids ?? [];
  const expectedDocIds = expected.doc_ids ?? [];

  // Find expected chunks that were found
  const foundChunks = expectedChunkIds.filter(id => resultChunkIds.has(id));
  const missingChunks = expectedChunkIds.filter(id => !resultChunkIds.has(id));

  // For doc_ids comparison, count how many expected docs are represented
  const foundDocs = expectedDocIds.filter(id => resultDocIds.has(id));
  const missingDocs = expectedDocIds.filter(id => !resultDocIds.has(id));

  // Combine found/missing from both chunk_ids and doc_ids
  const allFound = [...foundChunks, ...foundDocs];
  const allMissing = [...missingChunks, ...missingDocs];

  // Unexpected are top results not in expected chunk_ids
  const unexpected = results
    .slice(0, 5)
    .filter(r => !expectedChunkIds.includes(r.chunk_id))
    .map(r => r.chunk_id);

  // Calculate precision and recall
  let precision = 0;
  let recall = 0;

  if (results.length > 0) {
    precision = foundChunks.length / results.length;
  }

  if (expectedChunkIds.length > 0) {
    recall = foundChunks.length / expectedChunkIds.length;
  }

  return {
    expected_found: allFound,
    expected_missing: allMissing,
    unexpected_top: unexpected,
    precision,
    recall,
  };
}

/**
 * Generate diagnostics based on results and comparison.
 * Identifies issues and provides actionable suggestions.
 *
 * @param results - Retrieval results with scores
 * @param comparison - Optional comparison with expected results
 * @returns Diagnostic analysis with suggestions
 */
function generateDiagnostics(
  results: DebugResultItem[],
  comparison?: DebugComparison
): DebugDiagnostics {
  const scores = results.map(r => r.score);

  // Calculate score distribution
  const sortedScores = [...scores].sort((a, b) => a - b);
  const min = sortedScores[0] ?? 0;
  const max = sortedScores[sortedScores.length - 1] ?? 0;
  const mean = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const medianIndex = Math.floor(sortedScores.length / 2);
  const median = sortedScores[medianIndex] ?? 0;

  const suggestions: string[] = [];
  let issue: string | undefined;

  // Identify issues based on results
  if (scores.length === 0) {
    issue = 'No results returned';
    suggestions.push('Check if embeddings exist for the run');
    suggestions.push('Try a broader query');
  } else if (max < 0.5) {
    issue = 'All similarity scores are low';
    suggestions.push('Consider using a different embedding model');
    suggestions.push('Check if content is properly chunked');
  } else if (comparison?.expected_missing && comparison.expected_missing.length > 0) {
    issue = 'Expected chunks not found in results';
    suggestions.push('Increase top_k to retrieve more results');
    suggestions.push('Check if expected chunks are indexed');
  }

  // Add suggestion for wide score range
  const range = max - min;
  if (range > 0.5) {
    suggestions.push('Consider adjusting chunk size for more consistent retrieval');
  }

  // Ensure we always have at least one suggestion
  if (suggestions.length === 0) {
    suggestions.push('Results look reasonable; consider fine-tuning if needed');
  }

  return {
    issue,
    suggestions,
    score_distribution: { min, max, mean, median },
  };
}

/**
 * Export debug report to a JSON file in the run's debug directory.
 *
 * @param result - Debug query result to export
 * @param runDir - Run directory path
 * @returns Path to the exported report file
 */
async function exportReport(
  result: DebugQueryResult,
  runDir: string
): Promise<string> {
  const debugDir = path.join(runDir, 'debug');
  await fs.mkdir(debugDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(debugDir, `query-debug-${timestamp}.json`);

  await fs.writeFile(reportPath, JSON.stringify(result, null, 2));
  return reportPath;
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Debug a retrieval query by tracing the full pipeline and comparing
 * against expected results.
 *
 * This function executes a query through the retrieval pipeline and provides
 * detailed trace information, similarity scores, and diagnostic suggestions.
 * It's designed to help diagnose why certain queries don't return expected results.
 *
 * @param input - Debug query input with query, expected results, and options
 * @returns Debug result with trace, scores, comparison, and diagnostics
 *
 * @throws {ToolError} When run directory doesn't exist or data can't be loaded
 *
 * @example
 * ```typescript
 * const result = await debugQuery({
 *   run_id: 'abc-123-def-456',
 *   query: 'What is machine learning?',
 *   expected: { chunk_ids: ['chunk-1', 'chunk-2'] },
 *   options: { trace_level: 'verbose', top_k: 10 }
 * });
 *
 * console.log(`Found ${result.comparison?.expected_found.length} expected chunks`);
 * console.log(`Max score: ${result.diagnostics.score_distribution.max}`);
 * ```
 */
export async function debugQuery(input: DebugQueryInput): Promise<DebugQueryResult> {
  // Parse and validate input
  const validated = DebugQueryInputSchema.parse(input);
  const { run_id, query, expected } = validated;

  // Apply defaults for options
  const topK: number = validated.options?.top_k ?? 10;
  const includeEmbeddings: boolean = validated.options?.include_embeddings ?? false;
  const traceLevel: "minimal" | "standard" | "verbose" = validated.options?.trace_level ?? 'standard';
  const exportReportOption: boolean = validated.options?.export_report ?? false;

  const trace: DebugTraceStep[] = [];

  // Determine run directory paths
  const runsDir = path.join(process.cwd(), '.indexfoundry', 'runs', run_id);
  const normalizedDir = path.join(runsDir, 'normalized');
  const indexedDir = path.join(runsDir, 'indexed');
  const chunksPath = path.join(normalizedDir, 'chunks.jsonl');
  const embeddingsPath = path.join(indexedDir, 'embeddings.jsonl');

  // Step 1: Load chunks and embeddings
  const loadStartTime = Date.now();
  let chunks: DocumentChunk[];
  let embeddings: EmbeddingRecord[];

  try {
    chunks = await readJsonl<DocumentChunk>(chunksPath);
    embeddings = await readJsonl<EmbeddingRecord>(embeddingsPath);
  } catch (error) {
    throw createToolError(
      'RUN_NOT_FOUND',
      `Failed to load data for run ${run_id}: ${(error as Error).message}`,
      {
        recoverable: false,
        suggestion: 'Ensure the run exists and has completed indexing',
        details: { run_id, error: (error as Error).message },
      }
    );
  }

  // Create embedding lookup map
  const embeddingMap = new Map<string, number[]>();
  for (const e of embeddings) {
    embeddingMap.set(e.chunk_id, e.embedding);
  }

  // Combine chunks with embeddings
  const chunksWithEmbeddings: ChunkWithEmbedding[] = [];
  for (const chunk of chunks) {
    const embedding = embeddingMap.get(chunk.chunk_id);
    if (embedding) {
      chunksWithEmbeddings.push({ chunk, embedding });
    }
  }

  if (traceLevel !== 'minimal') {
    trace.push(recordStep('load', loadStartTime, {
      chunks_loaded: chunks.length,
      embeddings_loaded: embeddings.length,
      chunks_with_embeddings: chunksWithEmbeddings.length,
    }));
  }

  // Step 2: Generate query embedding
  const embedStartTime = Date.now();
  const dimension = chunksWithEmbeddings[0]?.embedding.length ?? 1536;
  const queryEmbedding = generateMockEmbedding(query, dimension);

  trace.push(recordStep('embed', embedStartTime, {
    query_length: query.length,
    embedding_dimension: dimension,
    model: 'mock-embedding',
  }));

  // Step 3: Search for similar chunks
  const searchStartTime = Date.now();
  const scoredChunks = chunksWithEmbeddings.map(cwe => ({
    chunk: cwe.chunk,
    score: cosineSimilarity(queryEmbedding, cwe.embedding),
  }));

  // Sort by score descending
  scoredChunks.sort((a, b) => b.score - a.score);

  // Take top_k results
  const topResults = scoredChunks.slice(0, topK);

  trace.push(recordStep('search', searchStartTime, {
    total_candidates: chunksWithEmbeddings.length,
    top_k: topK,
    results_returned: topResults.length,
    max_score: topResults[0]?.score ?? 0,
    min_score: topResults[topResults.length - 1]?.score ?? 0,
  }));

  // Add rerank step for verbose trace level
  if (traceLevel === 'verbose') {
    const rerankStartTime = Date.now();
    // In a real implementation, this might apply cross-encoder reranking
    trace.push(recordStep('rerank', rerankStartTime, {
      reranker: 'none',
      scores_adjusted: false,
    }));
  }

  // Step 4: Build result items
  const results: DebugResultItem[] = topResults.map((item, index) => ({
    rank: index + 1,
    chunk_id: item.chunk.chunk_id,
    doc_id: item.chunk.doc_id,
    score: Math.max(0, Math.min(1, item.score)), // Clamp to [0, 1]
    text_preview: item.chunk.content.text.slice(0, 200),
    metadata: item.chunk.metadata as Record<string, unknown>,
  }));

  // Step 5: Compare with expected (if provided)
  let comparison: DebugComparison | undefined;
  if (expected && (expected.chunk_ids?.length || expected.doc_ids?.length || expected.keywords?.length)) {
    comparison = compareResults(results, expected);
  }

  // Step 6: Generate diagnostics
  const diagnostics = generateDiagnostics(results, comparison);

  // Build result object
  const result: DebugQueryResult = {
    query,
    trace,
    results,
    diagnostics,
  };

  // Include query embedding if requested
  if (includeEmbeddings) {
    result.query_embedding = queryEmbedding;
  }

  // Include comparison if we have expected values
  if (comparison) {
    result.comparison = comparison;
  }

  // Step 7: Export report (if requested)
  if (exportReportOption) {
    result.report_path = await exportReport(result, runsDir);
  }

  return result;
}
