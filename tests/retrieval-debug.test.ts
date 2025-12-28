/**
 * Retrieval Debugging Tool Tests
 * 
 * These tests define the contract for the retrieval debugging feature in IndexFoundry.
 * The tool provides trace logging and expected vs actual comparison for diagnosing
 * RAG retrieval quality issues.
 * 
 * Feature Requirements:
 * - Trace query pipeline (embed, search, rerank, filter steps)
 * - Show similarity scores for each result
 * - Compare expected vs actual results
 * - Diagnose issues (low scores, missing content, etc.)
 * - Export debug reports for analysis
 * 
 * Integration Points:
 * - src/tools/debug.ts - New debug functions
 * - src/schemas.ts - Debug query schemas
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs/promises';
import * as path from 'path';

// Import debug functions (do not exist yet - tests will fail)
import {
  debugQuery,
  DebugQueryInputSchema,
  type DebugQueryResult,
  type DebugTraceStep,
  type DebugResultItem,
  type DebugComparison,
  type DebugDiagnostics
} from '../src/tools/debug.js';

// Import types for test data
import type { DocumentChunk } from '../src/types.js';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Read JSONL file and parse each line as JSON
 */
async function readJsonl<T>(filePath: string): Promise<T[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  return content
    .trim()
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as T);
}

/**
 * Create sample DocumentChunk for testing
 */
function createTestChunk(overrides: { chunk_id: string; chunk_index: number; doc_id?: string; text?: string }): DocumentChunk {
  return {
    doc_id: overrides.doc_id ?? 'test-doc-001',
    chunk_id: overrides.chunk_id,
    chunk_index: overrides.chunk_index,
    hierarchy_level: 0,
    source: {
      type: 'markdown',
      uri: 'test://document.md',
      retrieved_at: new Date().toISOString(),
      content_hash: `hash-${overrides.chunk_id}`
    },
    content: {
      text: overrides.text ?? `Content for ${overrides.chunk_id}. This is test content for retrieval debugging.`,
      text_hash: `text-hash-${overrides.chunk_id}`,
      char_count: 100,
      token_count_approx: 25
    },
    position: {
      byte_start: overrides.chunk_index * 100,
      byte_end: (overrides.chunk_index + 1) * 100
    },
    metadata: {
      content_type: 'text/markdown'
    }
  };
}

/**
 * Create mock embeddings for test chunks
 */
function createMockEmbedding(dimensions: number = 1536): number[] {
  return Array.from({ length: dimensions }, () => Math.random() * 2 - 1);
}

/**
 * Validate ISO timestamp format
 */
function isValidISOTimestamp(timestamp: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(timestamp);
}

// ============================================================================
// Test Data Setup
// ============================================================================

describe('Retrieval Debugging Tool', () => {
  const testRunId = uuidv4();
  const invalidRunId = uuidv4();
  const runsDir = path.join(process.cwd(), '.indexfoundry', 'runs', testRunId);
  const normalizedDir = path.join(runsDir, 'normalized');
  const indexedDir = path.join(runsDir, 'indexed');
  const chunksPath = path.join(normalizedDir, 'chunks.jsonl');
  const embeddingsPath = path.join(indexedDir, 'embeddings.jsonl');

  // Test chunks with varying content for retrieval testing
  const testChunks: DocumentChunk[] = [
    createTestChunk({
      chunk_id: 'chunk-1',
      chunk_index: 0,
      text: 'Machine learning is a subset of artificial intelligence focused on training algorithms.'
    }),
    createTestChunk({
      chunk_id: 'chunk-2',
      chunk_index: 1,
      text: 'Deep learning uses neural networks with multiple layers for pattern recognition.'
    }),
    createTestChunk({
      chunk_id: 'chunk-3',
      chunk_index: 2,
      text: 'Natural language processing enables computers to understand human language.'
    }),
    createTestChunk({
      chunk_id: 'chunk-4',
      chunk_index: 3,
      text: 'Computer vision allows machines to interpret and analyze visual information.'
    }),
    createTestChunk({
      chunk_id: 'chunk-5',
      chunk_index: 4,
      text: 'Reinforcement learning trains agents through reward and punishment signals.'
    }),
    createTestChunk({
      chunk_id: 'chunk-6',
      chunk_index: 5,
      doc_id: 'test-doc-002',
      text: 'Safety regulations for mining operations require proper ventilation systems.'
    }),
    createTestChunk({
      chunk_id: 'chunk-7',
      chunk_index: 6,
      doc_id: 'test-doc-002',
      text: 'Emergency procedures must be clearly posted and regularly practiced.'
    })
  ];

  // Mock embeddings for test chunks
  const testEmbeddings = testChunks.map(chunk => ({
    chunk_id: chunk.chunk_id,
    embedding: createMockEmbedding(1536)
  }));

  beforeAll(async () => {
    // Setup test run directory with chunks and embeddings
    await fs.mkdir(normalizedDir, { recursive: true });
    await fs.mkdir(indexedDir, { recursive: true });

    // Write test chunks
    const chunksContent = testChunks.map(c => JSON.stringify(c)).join('\n');
    await fs.writeFile(chunksPath, chunksContent, 'utf-8');

    // Write test embeddings
    const embeddingsContent = testEmbeddings.map(e => JSON.stringify(e)).join('\n');
    await fs.writeFile(embeddingsPath, embeddingsContent, 'utf-8');
  });

  afterAll(async () => {
    // Cleanup test directories
    try {
      await fs.rm(runsDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // ============================================================================
  // Schema Validation Tests
  // ============================================================================

  describe('Schema Validation', () => {
    it('should accept valid debug query input with minimal parameters', () => {
      const input = {
        run_id: testRunId,
        query: 'What is machine learning?'
      };

      const result = DebugQueryInputSchema.safeParse(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.run_id).toBe(testRunId);
        expect(result.data.query).toBe('What is machine learning?');
      }
    });

    it('should accept valid debug query input with all parameters', () => {
      const input = {
        run_id: testRunId,
        query: 'test query',
        expected: {
          chunk_ids: ['chunk-1', 'chunk-2'],
          doc_ids: ['test-doc-001'],
          keywords: ['machine', 'learning'],
          min_matches: 2
        },
        options: {
          top_k: 20,
          include_embeddings: true,
          include_all_scores: true,
          trace_level: 'verbose',
          export_report: true
        }
      };

      const result = DebugQueryInputSchema.safeParse(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.expected?.chunk_ids).toEqual(['chunk-1', 'chunk-2']);
        expect(result.data.options?.trace_level).toBe('verbose');
      }
    });

    it('should require run_id field', () => {
      const input = {
        query: 'test query'
      };

      const result = DebugQueryInputSchema.safeParse(input);

      expect(result.success).toBe(false);
    });

    it('should require query field', () => {
      const input = {
        run_id: testRunId
      };

      const result = DebugQueryInputSchema.safeParse(input);

      expect(result.success).toBe(false);
    });

    it('should reject empty query string', () => {
      const input = {
        run_id: testRunId,
        query: ''
      };

      const result = DebugQueryInputSchema.safeParse(input);

      expect(result.success).toBe(false);
    });

    it('should reject invalid run_id format (non-UUID)', () => {
      const input = {
        run_id: 'not-a-valid-uuid',
        query: 'test query'
      };

      const result = DebugQueryInputSchema.safeParse(input);

      expect(result.success).toBe(false);
    });

    it('should validate trace_level enum values', () => {
      const validLevels = ['minimal', 'standard', 'verbose'];
      
      for (const level of validLevels) {
        const input = {
          run_id: testRunId,
          query: 'test',
          options: { trace_level: level }
        };
        const result = DebugQueryInputSchema.safeParse(input);
        expect(result.success).toBe(true);
      }
    });

    it('should reject invalid trace_level value', () => {
      const input = {
        run_id: testRunId,
        query: 'test',
        options: { trace_level: 'invalid_level' }
      };

      const result = DebugQueryInputSchema.safeParse(input);

      expect(result.success).toBe(false);
    });

    it('should validate top_k minimum value (1)', () => {
      const input = {
        run_id: testRunId,
        query: 'test',
        options: { top_k: 0 }
      };

      const result = DebugQueryInputSchema.safeParse(input);

      expect(result.success).toBe(false);
    });

    it('should validate top_k maximum value (100)', () => {
      const input = {
        run_id: testRunId,
        query: 'test',
        options: { top_k: 101 }
      };

      const result = DebugQueryInputSchema.safeParse(input);

      expect(result.success).toBe(false);
    });

    it('should accept top_k within valid range', () => {
      const input = {
        run_id: testRunId,
        query: 'test',
        options: { top_k: 50 }
      };

      const result = DebugQueryInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('should default min_matches to 1 when not specified', () => {
      const input = {
        run_id: testRunId,
        query: 'test',
        expected: {
          chunk_ids: ['chunk-1']
        }
      };

      const result = DebugQueryInputSchema.safeParse(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.expected?.min_matches ?? 1).toBe(1);
      }
    });

    it('should accept expected with only chunk_ids', () => {
      const input = {
        run_id: testRunId,
        query: 'test',
        expected: {
          chunk_ids: ['chunk-1', 'chunk-2']
        }
      };

      const result = DebugQueryInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('should accept expected with only doc_ids', () => {
      const input = {
        run_id: testRunId,
        query: 'test',
        expected: {
          doc_ids: ['test-doc-001']
        }
      };

      const result = DebugQueryInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('should accept expected with only keywords', () => {
      const input = {
        run_id: testRunId,
        query: 'test',
        expected: {
          keywords: ['machine', 'learning']
        }
      };

      const result = DebugQueryInputSchema.safeParse(input);

      expect(result.success).toBe(true);
    });

    it('should reject additional unknown properties (strict mode)', () => {
      const input = {
        run_id: testRunId,
        query: 'test',
        unknown_field: 'should fail'
      };

      const result = DebugQueryInputSchema.safeParse(input);

      expect(result.success).toBe(false);
    });
  });

  // ============================================================================
  // Debug Trace Generation Tests
  // ============================================================================

  describe('Debug Trace Generation', () => {
    it('should generate trace steps for query pipeline', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'What is machine learning?'
      });

      expect(result.trace).toBeDefined();
      expect(result.trace.length).toBeGreaterThan(0);
      expect(result.trace.some(t => t.step === 'embed')).toBe(true);
      expect(result.trace.some(t => t.step === 'search')).toBe(true);
    });

    it('should include embed step in trace', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      const embedStep = result.trace.find(t => t.step === 'embed');
      expect(embedStep).toBeDefined();
      expect(embedStep?.details).toBeDefined();
    });

    it('should include search step in trace', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      const searchStep = result.trace.find(t => t.step === 'search');
      expect(searchStep).toBeDefined();
      expect(searchStep?.details).toBeDefined();
    });

    it('should include rerank step when applicable', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query',
        options: { trace_level: 'verbose' }
      });

      // Rerank step may or may not be present depending on configuration
      if (result.trace.some(t => t.step === 'rerank')) {
        const rerankStep = result.trace.find(t => t.step === 'rerank');
        expect(rerankStep?.details).toBeDefined();
      }
    });

    it('should record ISO timestamps for each step', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      result.trace.forEach(step => {
        expect(step.timestamp).toBeDefined();
        expect(isValidISOTimestamp(step.timestamp)).toBe(true);
      });
    });

    it('should calculate duration in milliseconds for each step', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      result.trace.forEach(step => {
        expect(step.duration_ms).toBeDefined();
        expect(typeof step.duration_ms).toBe('number');
        expect(step.duration_ms).toBeGreaterThanOrEqual(0);
      });
    });

    it('should order trace steps chronologically', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      for (let i = 1; i < result.trace.length; i++) {
        const prevTime = new Date(result.trace[i - 1].timestamp).getTime();
        const currTime = new Date(result.trace[i].timestamp).getTime();
        expect(currTime).toBeGreaterThanOrEqual(prevTime);
      }
    });

    it('should include only key steps with trace_level="minimal"', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query',
        options: { trace_level: 'minimal' }
      });

      // Minimal should only include embed and search
      expect(result.trace.length).toBeLessThanOrEqual(3);
      expect(result.trace.some(t => t.step === 'embed')).toBe(true);
      expect(result.trace.some(t => t.step === 'search')).toBe(true);
    });

    it('should include standard details with trace_level="standard"', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query',
        options: { trace_level: 'standard' }
      });

      const searchStep = result.trace.find(t => t.step === 'search');
      expect(searchStep?.details).toBeDefined();
      expect(Object.keys(searchStep?.details ?? {}).length).toBeGreaterThan(0);
    });

    it('should include all internal details with trace_level="verbose"', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query',
        options: { trace_level: 'verbose' }
      });

      // Verbose should have more trace steps
      expect(result.trace.length).toBeGreaterThanOrEqual(2);
      
      // Each step should have detailed information
      result.trace.forEach(step => {
        expect(step.details).toBeDefined();
      });
    });

    it('should include query text in result', async () => {
      const queryText = 'What is deep learning?';
      const result = await debugQuery({
        run_id: testRunId,
        query: queryText
      });

      expect(result.query).toBe(queryText);
    });
  });

  // ============================================================================
  // Results with Scores Tests
  // ============================================================================

  describe('Results with Scores', () => {
    it('should return ranked results ordered by similarity score', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'machine learning algorithms',
        options: { top_k: 5 }
      });

      expect(result.results).toBeDefined();
      expect(result.results.length).toBeLessThanOrEqual(5);

      // Verify descending order by score
      for (let i = 1; i < result.results.length; i++) {
        expect(result.results[i - 1].score).toBeGreaterThanOrEqual(result.results[i].score);
      }
    });

    it('should include similarity scores between 0 and 1', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      result.results.forEach(r => {
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
      });
    });

    it('should include rank for each result', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query',
        options: { top_k: 5 }
      });

      result.results.forEach((r, index) => {
        expect(r.rank).toBe(index + 1);
      });
    });

    it('should include chunk_id for each result', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      result.results.forEach(r => {
        expect(r.chunk_id).toBeDefined();
        expect(typeof r.chunk_id).toBe('string');
        expect(r.chunk_id.length).toBeGreaterThan(0);
      });
    });

    it('should include doc_id for each result', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      result.results.forEach(r => {
        expect(r.doc_id).toBeDefined();
        expect(typeof r.doc_id).toBe('string');
      });
    });

    it('should include text_preview for each result', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      result.results.forEach(r => {
        expect(r.text_preview).toBeDefined();
        expect(typeof r.text_preview).toBe('string');
        expect(r.text_preview.length).toBeLessThanOrEqual(200);
      });
    });

    it('should include metadata for each result', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      result.results.forEach(r => {
        expect(r.metadata).toBeDefined();
        expect(typeof r.metadata).toBe('object');
      });
    });

    it('should respect top_k limit', async () => {
      const topK = 3;
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query',
        options: { top_k: topK }
      });

      expect(result.results.length).toBeLessThanOrEqual(topK);
    });

    it('should return default top_k (10) when not specified', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      expect(result.results.length).toBeLessThanOrEqual(10);
    });

    it('should include all scores when include_all_scores=true', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query',
        options: { include_all_scores: true }
      });

      result.results.forEach(r => {
        expect(r.score).toBeDefined();
      });
    });

    it('should return unique chunk_ids (no duplicates)', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      const chunkIds = result.results.map(r => r.chunk_id);
      const uniqueIds = new Set(chunkIds);
      expect(uniqueIds.size).toBe(chunkIds.length);
    });
  });

  // ============================================================================
  // Expected vs Actual Comparison Tests
  // ============================================================================

  describe('Expected vs Actual Comparison', () => {
    it('should identify expected chunks found in results', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'machine learning',
        expected: {
          chunk_ids: ['chunk-1', 'chunk-2']
        }
      });

      expect(result.comparison).toBeDefined();
      expect(result.comparison!.expected_found).toBeInstanceOf(Array);
    });

    it('should report missing expected chunks', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'machine learning',
        expected: {
          chunk_ids: ['chunk-1', 'non-existent-chunk']
        }
      });

      expect(result.comparison).toBeDefined();
      expect(result.comparison!.expected_missing).toBeInstanceOf(Array);
      expect(result.comparison!.expected_missing).toContain('non-existent-chunk');
    });

    it('should report unexpected chunks in top results', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query',
        expected: {
          chunk_ids: ['chunk-1']
        },
        options: { top_k: 5 }
      });

      expect(result.comparison).toBeDefined();
      expect(result.comparison!.unexpected_top).toBeInstanceOf(Array);
    });

    it('should calculate precision correctly', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'machine learning',
        expected: {
          chunk_ids: ['chunk-1', 'chunk-2']
        },
        options: { top_k: 5 }
      });

      expect(result.comparison).toBeDefined();
      expect(result.comparison!.precision).toBeGreaterThanOrEqual(0);
      expect(result.comparison!.precision).toBeLessThanOrEqual(1);
    });

    it('should calculate recall correctly', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'machine learning',
        expected: {
          chunk_ids: ['chunk-1', 'chunk-2']
        }
      });

      expect(result.comparison).toBeDefined();
      expect(result.comparison!.recall).toBeGreaterThanOrEqual(0);
      expect(result.comparison!.recall).toBeLessThanOrEqual(1);
    });

    it('should return precision = 1 when all results are expected', async () => {
      // Query specifically for expected results
      const result = await debugQuery({
        run_id: testRunId,
        query: 'machine learning',
        expected: {
          chunk_ids: ['chunk-1', 'chunk-2', 'chunk-3', 'chunk-4', 'chunk-5', 'chunk-6', 'chunk-7']
        },
        options: { top_k: 7 }
      });

      // If all returned results are in expected, precision should be 1
      if (result.comparison!.expected_found.length === result.results.length) {
        expect(result.comparison!.precision).toBe(1);
      }
    });

    it('should return recall = 1 when all expected are found', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'machine learning',
        expected: {
          chunk_ids: ['chunk-1']
        },
        options: { top_k: 10 }
      });

      // If all expected are found, recall should be 1
      if (result.comparison!.expected_found.length === 1 && 
          result.comparison!.expected_missing.length === 0) {
        expect(result.comparison!.recall).toBe(1);
      }
    });

    it('should compare by doc_ids when specified', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'safety regulations',
        expected: {
          doc_ids: ['test-doc-002']
        }
      });

      expect(result.comparison).toBeDefined();
      // Should compare documents, not individual chunks
    });

    it('should check for keyword presence when specified', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'neural networks',
        expected: {
          keywords: ['neural', 'networks', 'deep']
        }
      });

      expect(result.comparison).toBeDefined();
      // Should report which keywords were found in results
    });

    it('should skip comparison when no expected provided', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      expect(result.comparison).toBeUndefined();
    });

    it('should handle empty expected arrays gracefully', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query',
        expected: {
          chunk_ids: []
        }
      });

      // Empty expected should either skip comparison or handle gracefully
      if (result.comparison) {
        expect(result.comparison.expected_found).toEqual([]);
        expect(result.comparison.expected_missing).toEqual([]);
      }
    });

    it('should meet min_matches requirement check', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'machine learning',
        expected: {
          chunk_ids: ['chunk-1', 'chunk-2', 'chunk-3'],
          min_matches: 2
        }
      });

      expect(result.comparison).toBeDefined();
      // Diagnostics should indicate if min_matches was met
    });
  });

  // ============================================================================
  // Diagnostics Tests
  // ============================================================================

  describe('Diagnostics', () => {
    it('should identify issue when all scores are low (< 0.5)', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'completely unrelated topic xyz123'
      });

      // If all scores are low, diagnostics should flag this
      if (result.results.every(r => r.score < 0.5)) {
        expect(result.diagnostics.issue).toBeDefined();
        expect(result.diagnostics.issue).toContain('low');
      }
    });

    it('should identify missing content issue', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query',
        expected: {
          chunk_ids: ['non-existent-chunk-xyz']
        }
      });

      // Should identify that expected content was not found
      if (result.comparison?.expected_missing.length ?? 0 > 0) {
        expect(result.diagnostics.issue).toBeDefined();
      }
    });

    it('should provide improvement suggestions', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      expect(result.diagnostics.suggestions).toBeDefined();
      expect(result.diagnostics.suggestions).toBeInstanceOf(Array);
    });

    it('should calculate score distribution min', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      expect(result.diagnostics.score_distribution).toBeDefined();
      expect(result.diagnostics.score_distribution.min).toBeDefined();
      expect(typeof result.diagnostics.score_distribution.min).toBe('number');
    });

    it('should calculate score distribution max', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      expect(result.diagnostics.score_distribution.max).toBeDefined();
      expect(typeof result.diagnostics.score_distribution.max).toBe('number');
    });

    it('should calculate score distribution mean', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      expect(result.diagnostics.score_distribution.mean).toBeDefined();
      expect(typeof result.diagnostics.score_distribution.mean).toBe('number');
    });

    it('should calculate score distribution median', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      expect(result.diagnostics.score_distribution.median).toBeDefined();
      expect(typeof result.diagnostics.score_distribution.median).toBe('number');
    });

    it('should have min <= mean <= max in score distribution', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      const { min, max, mean } = result.diagnostics.score_distribution;
      expect(min).toBeLessThanOrEqual(mean);
      expect(mean).toBeLessThanOrEqual(max);
    });

    it('should have min <= median <= max in score distribution', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      const { min, max, median } = result.diagnostics.score_distribution;
      expect(min).toBeLessThanOrEqual(median);
      expect(median).toBeLessThanOrEqual(max);
    });

    it('should suggest chunking adjustments when scores vary widely', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query',
        options: { trace_level: 'verbose' }
      });

      const { min, max } = result.diagnostics.score_distribution;
      const range = max - min;

      // If wide score range, should suggest chunking adjustments
      if (range > 0.5) {
        expect(result.diagnostics.suggestions.some(
          s => s.toLowerCase().includes('chunk')
        )).toBe(true);
      }
    });

    it('should suggest embedding model changes for consistently low scores', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'unrelated xyz query 123'
      });

      if (result.diagnostics.score_distribution.max < 0.4) {
        expect(result.diagnostics.suggestions.some(
          s => s.toLowerCase().includes('embed')
        )).toBe(true);
      }
    });
  });

  // ============================================================================
  // Embedding Tests
  // ============================================================================

  describe('Embedding Tests', () => {
    it('should include query_embedding when include_embeddings=true', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query',
        options: { include_embeddings: true }
      });

      expect(result.query_embedding).toBeDefined();
      expect(result.query_embedding).toBeInstanceOf(Array);
    });

    it('should not include query_embedding when include_embeddings=false', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query',
        options: { include_embeddings: false }
      });

      expect(result.query_embedding).toBeUndefined();
    });

    it('should not include query_embedding by default', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      expect(result.query_embedding).toBeUndefined();
    });

    it('should return correct embedding dimension', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query',
        options: { include_embeddings: true }
      });

      if (result.query_embedding) {
        // Standard OpenAI embedding dimension
        expect(result.query_embedding.length).toBe(1536);
      }
    });

    it('should return normalized embedding values', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query',
        options: { include_embeddings: true }
      });

      if (result.query_embedding) {
        // L2 normalized vectors have magnitude ~1
        const magnitude = Math.sqrt(
          result.query_embedding.reduce((sum, v) => sum + v * v, 0)
        );
        expect(magnitude).toBeCloseTo(1, 1);
      }
    });
  });

  // ============================================================================
  // Export Report Tests
  // ============================================================================

  describe('Export Report', () => {
    it('should create JSON report when export_report=true', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query',
        options: { export_report: true }
      });

      expect(result.report_path).toBeDefined();
      expect(typeof result.report_path).toBe('string');
    });

    it('should return report_path in result', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query',
        options: { export_report: true }
      });

      expect(result.report_path).toBeDefined();
      expect(result.report_path?.endsWith('.json')).toBe(true);
    });

    it('should not create report when export_report=false', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query',
        options: { export_report: false }
      });

      expect(result.report_path).toBeUndefined();
    });

    it('should not create report by default', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      expect(result.report_path).toBeUndefined();
    });

    it('should save report with full trace information', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query',
        options: { export_report: true }
      });

      if (result.report_path) {
        const reportContent = await fs.readFile(result.report_path, 'utf-8');
        const report = JSON.parse(reportContent);

        expect(report.trace).toBeDefined();
        expect(report.trace.length).toBeGreaterThan(0);
      }
    });

    it('should save report with results and scores', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query',
        options: { export_report: true }
      });

      if (result.report_path) {
        const reportContent = await fs.readFile(result.report_path, 'utf-8');
        const report = JSON.parse(reportContent);

        expect(report.results).toBeDefined();
        expect(report.results.length).toBeGreaterThan(0);
      }
    });

    it('should save report with diagnostics', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query',
        options: { export_report: true }
      });

      if (result.report_path) {
        const reportContent = await fs.readFile(result.report_path, 'utf-8');
        const report = JSON.parse(reportContent);

        expect(report.diagnostics).toBeDefined();
        expect(report.diagnostics.score_distribution).toBeDefined();
      }
    });

    it('should include timestamp in report filename', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query',
        options: { export_report: true }
      });

      if (result.report_path) {
        // Report filename should contain date/time info
        const filename = path.basename(result.report_path);
        expect(filename).toMatch(/debug.*\d{4}.*\.json/);
      }
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('Edge Cases', () => {
    it('should handle empty results gracefully', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'xyznonexistentquery123456789'
      });

      expect(result.results).toBeDefined();
      expect(result.results).toBeInstanceOf(Array);
      expect(result.diagnostics).toBeDefined();
    });

    it('should throw error for invalid run_id', async () => {
      await expect(
        debugQuery({
          run_id: invalidRunId,
          query: 'test query'
        })
      ).rejects.toThrow();
    });

    it('should handle very long query text', async () => {
      const longQuery = 'machine learning '.repeat(100);
      const result = await debugQuery({
        run_id: testRunId,
        query: longQuery
      });

      expect(result).toBeDefined();
      expect(result.query).toBe(longQuery);
    });

    it('should handle special characters in query', async () => {
      const specialQuery = 'test@#$%^&*()query"with\'special<chars>';
      const result = await debugQuery({
        run_id: testRunId,
        query: specialQuery
      });

      expect(result).toBeDefined();
    });

    it('should handle unicode in query', async () => {
      const unicodeQuery = '机器学习 машинное обучение 機械学習';
      const result = await debugQuery({
        run_id: testRunId,
        query: unicodeQuery
      });

      expect(result).toBeDefined();
      expect(result.query).toBe(unicodeQuery);
    });

    it('should handle all results with very low scores', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'completely unrelated topic that wont match'
      });

      expect(result.diagnostics).toBeDefined();
      // Should still provide useful diagnostics even with poor matches
    });

    it('should handle single result', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query',
        options: { top_k: 1 }
      });

      expect(result.results.length).toBeLessThanOrEqual(1);
      expect(result.diagnostics.score_distribution).toBeDefined();
    });

    it('should handle empty expected lists', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query',
        expected: {}
      });

      expect(result).toBeDefined();
    });

    it('should handle timeout gracefully', async () => {
      // Long query that might timeout - should handle gracefully
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query for timeout handling'
      });

      expect(result).toBeDefined();
    });

    it('should handle concurrent debug queries', async () => {
      const queries = [
        debugQuery({ run_id: testRunId, query: 'query 1' }),
        debugQuery({ run_id: testRunId, query: 'query 2' }),
        debugQuery({ run_id: testRunId, query: 'query 3' })
      ];

      const results = await Promise.all(queries);

      expect(results).toHaveLength(3);
      results.forEach(r => {
        expect(r.results).toBeDefined();
      });
    });

    it('should preserve result order stability', async () => {
      // Same query should return same order
      const result1 = await debugQuery({
        run_id: testRunId,
        query: 'machine learning'
      });

      const result2 = await debugQuery({
        run_id: testRunId,
        query: 'machine learning'
      });

      expect(result1.results.map(r => r.chunk_id))
        .toEqual(result2.results.map(r => r.chunk_id));
    });
  });

  // ============================================================================
  // Output Structure Tests
  // ============================================================================

  describe('Output Structure', () => {
    it('should return DebugQueryResult with all required fields', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      // Check required fields
      expect(result).toHaveProperty('query');
      expect(result).toHaveProperty('trace');
      expect(result).toHaveProperty('results');
      expect(result).toHaveProperty('diagnostics');
    });

    it('should have correct trace step structure', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      result.trace.forEach(step => {
        expect(step).toHaveProperty('step');
        expect(step).toHaveProperty('timestamp');
        expect(step).toHaveProperty('duration_ms');
        expect(step).toHaveProperty('details');
      });
    });

    it('should have correct result item structure', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      result.results.forEach(item => {
        expect(item).toHaveProperty('rank');
        expect(item).toHaveProperty('chunk_id');
        expect(item).toHaveProperty('doc_id');
        expect(item).toHaveProperty('score');
        expect(item).toHaveProperty('text_preview');
        expect(item).toHaveProperty('metadata');
      });
    });

    it('should have correct comparison structure when expected provided', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query',
        expected: { chunk_ids: ['chunk-1'] }
      });

      expect(result.comparison).toBeDefined();
      expect(result.comparison).toHaveProperty('expected_found');
      expect(result.comparison).toHaveProperty('expected_missing');
      expect(result.comparison).toHaveProperty('unexpected_top');
      expect(result.comparison).toHaveProperty('precision');
      expect(result.comparison).toHaveProperty('recall');
    });

    it('should have correct diagnostics structure', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      expect(result.diagnostics).toHaveProperty('suggestions');
      expect(result.diagnostics).toHaveProperty('score_distribution');
      expect(result.diagnostics.score_distribution).toHaveProperty('min');
      expect(result.diagnostics.score_distribution).toHaveProperty('max');
      expect(result.diagnostics.score_distribution).toHaveProperty('mean');
      expect(result.diagnostics.score_distribution).toHaveProperty('median');
    });

    it('should return string query field', async () => {
      const queryText = 'What is machine learning?';
      const result = await debugQuery({
        run_id: testRunId,
        query: queryText
      });

      expect(typeof result.query).toBe('string');
      expect(result.query).toBe(queryText);
    });

    it('should return array trace field', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      expect(Array.isArray(result.trace)).toBe(true);
    });

    it('should return array results field', async () => {
      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query'
      });

      expect(Array.isArray(result.results)).toBe(true);
    });
  });

  // ============================================================================
  // Performance Tests
  // ============================================================================

  describe('Performance', () => {
    it('should complete debug query within 5 seconds', async () => {
      const startTime = Date.now();

      await debugQuery({
        run_id: testRunId,
        query: 'machine learning test'
      });

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(5000);
    });

    it('should handle top_k=100 efficiently', async () => {
      const startTime = Date.now();

      const result = await debugQuery({
        run_id: testRunId,
        query: 'test query',
        options: { top_k: 100 }
      });

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(10000);
      expect(result.results.length).toBeLessThanOrEqual(100);
    });

    it('should not significantly slow with verbose trace level', async () => {
      const startTime = Date.now();

      await debugQuery({
        run_id: testRunId,
        query: 'test query',
        options: { trace_level: 'verbose' }
      });

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(5000);
    });

    it('should efficiently handle large expected lists', async () => {
      const largeExpected = Array.from(
        { length: 50 },
        (_, i) => `chunk-${i + 1}`
      );

      const startTime = Date.now();

      await debugQuery({
        run_id: testRunId,
        query: 'test query',
        expected: { chunk_ids: largeExpected }
      });

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(5000);
    });
  });
});
