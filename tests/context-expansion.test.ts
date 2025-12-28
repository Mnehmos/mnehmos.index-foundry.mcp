/**
 * Context Expansion / Chunk Hydration Tests
 * 
 * These tests define the contract for context expansion in IndexFoundry.
 * The feature fetches adjacent and parent chunks at query time to provide
 * fuller context for retrieved results.
 * 
 * Feature Requirements:
 * - Fetch adjacent chunks (before/after a retrieved chunk)
 * - Fetch parent chunks using parent_id (from hierarchical chunking)
 * - Hydrate context in query results for better context
 * - Configure expansion depth and strategy
 * 
 * Integration Points:
 * - src/tools/serve.ts - Query results need hydration options
 * - src/tools/hydrate.ts - New hydration functions
 * - src/schemas.ts - New schema options for hydration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs/promises';
import * as path from 'path';

// Import schemas (expand_context option does not exist yet - tests will fail)
import { ServeQueryInputSchema } from '../src/schemas.js';
import type { DocumentChunk } from '../src/types.js';

// Import hydration functions (do not exist yet - tests will fail)
import {
  hydrateChunk,
  hydrateSearchResults,
  ExpandContextInputSchema,
  type HydrateOptions,
  type HydratedSearchResult,
  type ExpandContextStrategy
} from '../src/tools/hydrate.js';

// Import serveQuery for integration tests (needs expansion support)
import { serveQuery } from '../src/tools/serve.js';

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
function createTestChunk(overrides: Partial<DocumentChunk> & { chunk_id: string; chunk_index: number }): DocumentChunk {
  return {
    doc_id: 'test-doc-001',
    chunk_id: overrides.chunk_id,
    chunk_index: overrides.chunk_index,
    parent_id: overrides.parent_id,
    parent_context: overrides.parent_context,
    hierarchy_level: overrides.hierarchy_level ?? 0,
    source: {
      type: 'markdown',
      uri: 'test://document.md',
      retrieved_at: new Date().toISOString(),
      content_hash: 'abc123'
    },
    content: {
      text: overrides.content?.text ?? `Chunk content for ${overrides.chunk_id}`,
      text_hash: `hash-${overrides.chunk_id}`,
      char_count: 100,
      token_count_approx: 25
    },
    position: {
      byte_start: overrides.chunk_index * 100,
      byte_end: (overrides.chunk_index + 1) * 100,
      ...overrides.position
    },
    metadata: {
      content_type: 'text/markdown',
      ...overrides.metadata
    }
  };
}

/**
 * Create hydrate options with defaults
 */
function createHydrateOptions(overrides: Partial<HydrateOptions> = {}): HydrateOptions {
  return {
    enabled: true,
    strategy: 'both',
    adjacent_before: 1,
    adjacent_after: 1,
    include_parent: true,
    max_total_chunks: 10,
    ...overrides
  };
}

// ============================================================================
// Test Data
// ============================================================================

describe('Context Expansion / Chunk Hydration', () => {
  const testRunId = uuidv4();
  const runsDir = path.join(process.cwd(), '.indexfoundry', 'runs', testRunId);
  const normalizedDir = path.join(runsDir, 'normalized');
  const chunksPath = path.join(normalizedDir, 'chunks.jsonl');

  // Sample chunks with hierarchy for testing
  // Structure:
  //   c1 (h1 - Main Title, level 1, no parent)
  //   ├── c2 (h2 - Section A, level 2, parent: c1)
  //   │   ├── c3 (h3 - Subsection A1, level 3, parent: c2)
  //   │   └── c4 (h3 - Subsection A2, level 3, parent: c2)
  //   └── c5 (h2 - Section B, level 2, parent: c1)
  //       └── c6 (h3 - Subsection B1, level 3, parent: c5)
  //           └── c7 (h4 - Deep B1a, level 4, parent: c6)
  //   c8 (standalone chunk, level 0, no parent - different document)
  
  const testChunks: DocumentChunk[] = [
    createTestChunk({
      chunk_id: 'c1',
      chunk_index: 0,
      hierarchy_level: 1,
      parent_id: undefined,
      content: { text: '# Main Title\nIntroduction to the document.', text_hash: 'h1', char_count: 40, token_count_approx: 10 }
    }),
    createTestChunk({
      chunk_id: 'c2',
      chunk_index: 1,
      hierarchy_level: 2,
      parent_id: 'c1',
      parent_context: '# Main Title',
      content: { text: '## Section A\nContent for section A.', text_hash: 'h2', char_count: 35, token_count_approx: 8 }
    }),
    createTestChunk({
      chunk_id: 'c3',
      chunk_index: 2,
      hierarchy_level: 3,
      parent_id: 'c2',
      parent_context: '## Section A',
      content: { text: '### Subsection A1\nDetailed content for A1.', text_hash: 'h3', char_count: 42, token_count_approx: 10 }
    }),
    createTestChunk({
      chunk_id: 'c4',
      chunk_index: 3,
      hierarchy_level: 3,
      parent_id: 'c2',
      parent_context: '## Section A',
      content: { text: '### Subsection A2\nMore details for A2.', text_hash: 'h4', char_count: 38, token_count_approx: 9 }
    }),
    createTestChunk({
      chunk_id: 'c5',
      chunk_index: 4,
      hierarchy_level: 2,
      parent_id: 'c1',
      parent_context: '# Main Title',
      content: { text: '## Section B\nDifferent topic in section B.', text_hash: 'h5', char_count: 43, token_count_approx: 10 }
    }),
    createTestChunk({
      chunk_id: 'c6',
      chunk_index: 5,
      hierarchy_level: 3,
      parent_id: 'c5',
      parent_context: '## Section B',
      content: { text: '### Subsection B1\nDetails under section B.', text_hash: 'h6', char_count: 43, token_count_approx: 10 }
    }),
    createTestChunk({
      chunk_id: 'c7',
      chunk_index: 6,
      hierarchy_level: 4,
      parent_id: 'c6',
      parent_context: '### Subsection B1',
      content: { text: '#### Deep B1a\nDeeply nested content.', text_hash: 'h7', char_count: 36, token_count_approx: 8 }
    }),
    // Different document - standalone chunk
    {
      ...createTestChunk({
        chunk_id: 'c8',
        chunk_index: 0,
        hierarchy_level: 0,
        parent_id: undefined
      }),
      doc_id: 'test-doc-002',
      content: { text: 'Standalone document content.', text_hash: 'h8', char_count: 28, token_count_approx: 5 }
    }
  ];

  beforeAll(async () => {
    // Setup test run directory
    await fs.mkdir(normalizedDir, { recursive: true });
    
    // Write test chunks
    const jsonlContent = testChunks.map(c => JSON.stringify(c)).join('\n');
    await fs.writeFile(chunksPath, jsonlContent, 'utf-8');
  });

  afterAll(async () => {
    // Cleanup
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
    it('should accept valid expand_context options in ServeQueryInputSchema', () => {
      const input = {
        run_id: testRunId,
        query: 'test query',
        expand_context: {
          enabled: true,
          strategy: 'both',
          adjacent_before: 2,
          adjacent_after: 2,
          include_parent: true,
          max_total_chunks: 10
        }
      };

      const result = ServeQueryInputSchema.safeParse(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.expand_context).toBeDefined();
        expect(result.data.expand_context?.enabled).toBe(true);
        expect(result.data.expand_context?.strategy).toBe('both');
      }
    });

    it('should accept expand_context with strategy="adjacent"', () => {
      const input = {
        run_id: testRunId,
        query: 'test query',
        expand_context: {
          enabled: true,
          strategy: 'adjacent'
        }
      };

      const result = ServeQueryInputSchema.safeParse(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.expand_context?.strategy).toBe('adjacent');
      }
    });

    it('should accept expand_context with strategy="parent"', () => {
      const input = {
        run_id: testRunId,
        query: 'test query',
        expand_context: {
          enabled: true,
          strategy: 'parent'
        }
      };

      const result = ServeQueryInputSchema.safeParse(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.expand_context?.strategy).toBe('parent');
      }
    });

    it('should reject negative adjacent_before value', () => {
      const input = {
        run_id: testRunId,
        query: 'test query',
        expand_context: {
          enabled: true,
          adjacent_before: -1
        }
      };

      const result = ServeQueryInputSchema.safeParse(input);

      expect(result.success).toBe(false);
    });

    it('should reject adjacent_before value greater than 5', () => {
      const input = {
        run_id: testRunId,
        query: 'test query',
        expand_context: {
          enabled: true,
          adjacent_before: 6
        }
      };

      const result = ServeQueryInputSchema.safeParse(input);

      expect(result.success).toBe(false);
    });

    it('should reject negative adjacent_after value', () => {
      const input = {
        run_id: testRunId,
        query: 'test query',
        expand_context: {
          enabled: true,
          adjacent_after: -2
        }
      };

      const result = ServeQueryInputSchema.safeParse(input);

      expect(result.success).toBe(false);
    });

    it('should reject adjacent_after value greater than 5', () => {
      const input = {
        run_id: testRunId,
        query: 'test query',
        expand_context: {
          enabled: true,
          adjacent_after: 10
        }
      };

      const result = ServeQueryInputSchema.safeParse(input);

      expect(result.success).toBe(false);
    });

    it('should reject max_total_chunks value of 0', () => {
      const input = {
        run_id: testRunId,
        query: 'test query',
        expand_context: {
          enabled: true,
          max_total_chunks: 0
        }
      };

      const result = ServeQueryInputSchema.safeParse(input);

      expect(result.success).toBe(false);
    });

    it('should reject max_total_chunks value greater than 20', () => {
      const input = {
        run_id: testRunId,
        query: 'test query',
        expand_context: {
          enabled: true,
          max_total_chunks: 25
        }
      };

      const result = ServeQueryInputSchema.safeParse(input);

      expect(result.success).toBe(false);
    });

    it('should default enabled to false when expand_context is provided', () => {
      const input = {
        run_id: testRunId,
        query: 'test query',
        expand_context: {}
      };

      const result = ServeQueryInputSchema.safeParse(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.expand_context?.enabled ?? false).toBe(false);
      }
    });

    it('should default strategy to "both" when not specified', () => {
      const input = {
        run_id: testRunId,
        query: 'test query',
        expand_context: {
          enabled: true
        }
      };

      const result = ServeQueryInputSchema.safeParse(input);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.expand_context?.strategy ?? 'both').toBe('both');
      }
    });

    it('should validate ExpandContextInputSchema independently', () => {
      const validInput = {
        enabled: true,
        strategy: 'adjacent',
        adjacent_before: 3,
        adjacent_after: 2,
        include_parent: false,
        max_total_chunks: 15
      };

      const result = ExpandContextInputSchema.safeParse(validInput);

      expect(result.success).toBe(true);
    });

    it('should reject invalid strategy value in ExpandContextInputSchema', () => {
      const invalidInput = {
        enabled: true,
        strategy: 'invalid_strategy'
      };

      const result = ExpandContextInputSchema.safeParse(invalidInput);

      expect(result.success).toBe(false);
    });
  });

  // ============================================================================
  // Adjacent Chunk Retrieval Tests
  // ============================================================================

  describe('Adjacent Chunk Retrieval', () => {
    it('should return adjacent_before chunks when requested', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[2], score: 0.9 }], // c3 at index 2
        testRunId,
        createHydrateOptions({ strategy: 'adjacent', adjacent_before: 2, adjacent_after: 0 })
      );

      expect(result).toHaveLength(1);
      expect(result[0].context.siblings_before).toHaveLength(2);
      expect(result[0].context.siblings_before[0].chunk_id).toBe('c1');
      expect(result[0].context.siblings_before[1].chunk_id).toBe('c2');
    });

    it('should return adjacent_after chunks when requested', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[2], score: 0.9 }], // c3 at index 2
        testRunId,
        createHydrateOptions({ strategy: 'adjacent', adjacent_before: 0, adjacent_after: 2 })
      );

      expect(result).toHaveLength(1);
      expect(result[0].context.siblings_after).toHaveLength(2);
      expect(result[0].context.siblings_after[0].chunk_id).toBe('c4');
      expect(result[0].context.siblings_after[1].chunk_id).toBe('c5');
    });

    it('should return both before and after chunks when both requested', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[3], score: 0.85 }], // c4 at index 3
        testRunId,
        createHydrateOptions({ strategy: 'adjacent', adjacent_before: 1, adjacent_after: 1 })
      );

      expect(result).toHaveLength(1);
      expect(result[0].context.siblings_before).toHaveLength(1);
      expect(result[0].context.siblings_after).toHaveLength(1);
      expect(result[0].context.siblings_before[0].chunk_id).toBe('c3');
      expect(result[0].context.siblings_after[0].chunk_id).toBe('c5');
    });

    it('should handle document start boundary - no chunks before first chunk', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[0], score: 0.95 }], // c1 at index 0
        testRunId,
        createHydrateOptions({ strategy: 'adjacent', adjacent_before: 5, adjacent_after: 0 })
      );

      expect(result).toHaveLength(1);
      expect(result[0].context.siblings_before).toHaveLength(0);
    });

    it('should handle document end boundary - no chunks after last chunk', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[6], score: 0.9 }], // c7 at index 6 (last in doc-001)
        testRunId,
        createHydrateOptions({ strategy: 'adjacent', adjacent_before: 0, adjacent_after: 5 })
      );

      expect(result).toHaveLength(1);
      // c8 is in a different document, so should not be included
      expect(result[0].context.siblings_after).toHaveLength(0);
    });

    it('should respect document boundaries - no crossing to different documents', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[6], score: 0.9 }], // c7 - last chunk of test-doc-001
        testRunId,
        createHydrateOptions({ strategy: 'adjacent', adjacent_before: 0, adjacent_after: 3 })
      );

      expect(result).toHaveLength(1);
      // c8 belongs to test-doc-002, should not be included
      expect(result[0].context.siblings_after.every(
        (c: DocumentChunk) => c.doc_id === 'test-doc-001'
      )).toBe(true);
    });

    it('should return fewer chunks than requested at boundaries', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[1], score: 0.88 }], // c2 at index 1
        testRunId,
        createHydrateOptions({ strategy: 'adjacent', adjacent_before: 5, adjacent_after: 0 })
      );

      expect(result).toHaveLength(1);
      // Only c1 (index 0) is before c2
      expect(result[0].context.siblings_before).toHaveLength(1);
    });

    it('should order before chunks from oldest to newest', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[4], score: 0.85 }], // c5 at index 4
        testRunId,
        createHydrateOptions({ strategy: 'adjacent', adjacent_before: 3, adjacent_after: 0 })
      );

      expect(result).toHaveLength(1);
      const beforeChunks = result[0].context.siblings_before;
      expect(beforeChunks).toHaveLength(3);
      // Should be ordered: c2, c3, c4
      for (let i = 1; i < beforeChunks.length; i++) {
        expect(beforeChunks[i].chunk_index).toBeGreaterThan(beforeChunks[i - 1].chunk_index);
      }
    });

    it('should order after chunks from newest to oldest', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[2], score: 0.85 }], // c3 at index 2
        testRunId,
        createHydrateOptions({ strategy: 'adjacent', adjacent_before: 0, adjacent_after: 3 })
      );

      expect(result).toHaveLength(1);
      const afterChunks = result[0].context.siblings_after;
      expect(afterChunks).toHaveLength(3);
      // Should be ordered: c4, c5, c6
      for (let i = 1; i < afterChunks.length; i++) {
        expect(afterChunks[i].chunk_index).toBeGreaterThan(afterChunks[i - 1].chunk_index);
      }
    });
  });

  // ============================================================================
  // Parent Chunk Retrieval Tests
  // ============================================================================

  describe('Parent Chunk Retrieval', () => {
    it('should include parent chunk when include_parent=true', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[6], score: 0.9 }], // c7 has parent c6
        testRunId,
        createHydrateOptions({ strategy: 'parent', include_parent: true })
      );

      expect(result).toHaveLength(1);
      expect(result[0].context.parent).toBeDefined();
      expect(result[0].context.parent?.chunk_id).toBe('c6');
    });

    it('should not include parent when include_parent=false', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[6], score: 0.9 }], // c7
        testRunId,
        createHydrateOptions({ strategy: 'parent', include_parent: false })
      );

      expect(result).toHaveLength(1);
      expect(result[0].context.parent).toBeUndefined();
    });

    it('should have no parent for root chunks (hierarchy_level=1)', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[0], score: 0.95 }], // c1 is root
        testRunId,
        createHydrateOptions({ strategy: 'parent', include_parent: true })
      );

      expect(result).toHaveLength(1);
      expect(result[0].context.parent).toBeUndefined();
    });

    it('should have no parent for chunks with hierarchy_level=0', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[7], score: 0.9 }], // c8 has hierarchy_level=0
        testRunId,
        createHydrateOptions({ strategy: 'parent', include_parent: true })
      );

      expect(result).toHaveLength(1);
      expect(result[0].context.parent).toBeUndefined();
    });

    it('should handle missing parent_id reference gracefully', async () => {
      // Create a chunk with invalid parent_id
      const orphanChunk: DocumentChunk = {
        ...createTestChunk({ chunk_id: 'orphan', chunk_index: 99 }),
        parent_id: 'non-existent-parent',
        hierarchy_level: 2
      };

      const result = await hydrateSearchResults(
        [{ chunk: orphanChunk, score: 0.8 }],
        testRunId,
        createHydrateOptions({ strategy: 'parent', include_parent: true })
      );

      expect(result).toHaveLength(1);
      // Should gracefully handle missing parent
      expect(result[0].context.parent).toBeUndefined();
    });

    it('should build hierarchy_path from chunk to root', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[6], score: 0.9 }], // c7 -> c6 -> c5 -> c1
        testRunId,
        createHydrateOptions({ strategy: 'parent', include_parent: true })
      );

      expect(result).toHaveLength(1);
      expect(result[0].context.hierarchy_path).toBeDefined();
      expect(result[0].context.hierarchy_path).toEqual(['c1', 'c5', 'c6', 'c7']);
    });

    it('should return empty hierarchy_path for root chunks', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[0], score: 0.95 }], // c1 is root
        testRunId,
        createHydrateOptions({ strategy: 'parent', include_parent: true })
      );

      expect(result).toHaveLength(1);
      expect(result[0].context.hierarchy_path).toEqual(['c1']);
    });

    it('should traverse parent chain for deeply nested chunks', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[6], score: 0.88 }], // c7 at level 4
        testRunId,
        createHydrateOptions({ strategy: 'parent', include_parent: true })
      );

      expect(result).toHaveLength(1);
      // c7 -> c6 -> c5 -> c1 (4 levels)
      expect(result[0].context.hierarchy_path?.length).toBe(4);
    });

    it('should include parent content in context', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[2], score: 0.9 }], // c3 has parent c2
        testRunId,
        createHydrateOptions({ strategy: 'parent', include_parent: true })
      );

      expect(result).toHaveLength(1);
      expect(result[0].context.parent).toBeDefined();
      expect(result[0].context.parent?.content.text).toContain('Section A');
    });
  });

  // ============================================================================
  // Combined Strategy Tests
  // ============================================================================

  describe('Combined Strategies', () => {
    it('should return only adjacent chunks with strategy="adjacent"', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[3], score: 0.9 }], // c4
        testRunId,
        createHydrateOptions({ strategy: 'adjacent', adjacent_before: 1, adjacent_after: 1 })
      );

      expect(result).toHaveLength(1);
      expect(result[0].context.siblings_before).toHaveLength(1);
      expect(result[0].context.siblings_after).toHaveLength(1);
      expect(result[0].context.parent).toBeUndefined();
    });

    it('should return only parent with strategy="parent"', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[3], score: 0.9 }], // c4
        testRunId,
        createHydrateOptions({ strategy: 'parent', include_parent: true })
      );

      expect(result).toHaveLength(1);
      expect(result[0].context.siblings_before).toHaveLength(0);
      expect(result[0].context.siblings_after).toHaveLength(0);
      expect(result[0].context.parent).toBeDefined();
    });

    it('should return both adjacent and parent with strategy="both"', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[3], score: 0.9 }], // c4
        testRunId,
        createHydrateOptions({
          strategy: 'both',
          adjacent_before: 1,
          adjacent_after: 1,
          include_parent: true
        })
      );

      expect(result).toHaveLength(1);
      expect(result[0].context.siblings_before).toHaveLength(1);
      expect(result[0].context.siblings_after).toHaveLength(1);
      expect(result[0].context.parent).toBeDefined();
    });

    it('should respect include_parent=false even with strategy="both"', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[3], score: 0.9 }],
        testRunId,
        createHydrateOptions({
          strategy: 'both',
          adjacent_before: 1,
          adjacent_after: 1,
          include_parent: false
        })
      );

      expect(result).toHaveLength(1);
      expect(result[0].context.siblings_before).toHaveLength(1);
      expect(result[0].context.siblings_after).toHaveLength(1);
      expect(result[0].context.parent).toBeUndefined();
    });
  });

  // ============================================================================
  // Limits and Deduplication Tests
  // ============================================================================

  describe('Limits and Deduplication', () => {
    it('should respect max_total_chunks limit', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[3], score: 0.9 }], // c4
        testRunId,
        createHydrateOptions({
          strategy: 'both',
          adjacent_before: 5,
          adjacent_after: 5,
          include_parent: true,
          max_total_chunks: 3
        })
      );

      expect(result).toHaveLength(1);
      const totalContext =
        result[0].context.siblings_before.length +
        result[0].context.siblings_after.length +
        (result[0].context.parent ? 1 : 0);
      expect(totalContext).toBeLessThanOrEqual(3);
    });

    it('should prioritize closer chunks when max_total_chunks limits results', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[4], score: 0.9 }], // c5 at index 4
        testRunId,
        createHydrateOptions({
          strategy: 'adjacent',
          adjacent_before: 5,
          adjacent_after: 5,
          max_total_chunks: 2
        })
      );

      expect(result).toHaveLength(1);
      const beforeChunks = result[0].context.siblings_before;
      const afterChunks = result[0].context.siblings_after;
      
      // Should include closest chunks (c4 before, c6 after)
      const total = beforeChunks.length + afterChunks.length;
      expect(total).toBeLessThanOrEqual(2);
      
      // If any before chunks, should be c4 (immediately before)
      if (beforeChunks.length > 0) {
        expect(beforeChunks[beforeChunks.length - 1].chunk_id).toBe('c4');
      }
    });

    it('should deduplicate overlapping adjacent chunks between multiple results', async () => {
      // Two adjacent chunks in search results
      const result = await hydrateSearchResults(
        [
          { chunk: testChunks[2], score: 0.9 }, // c3
          { chunk: testChunks[3], score: 0.85 } // c4 (adjacent to c3)
        ],
        testRunId,
        createHydrateOptions({
          strategy: 'adjacent',
          adjacent_before: 1,
          adjacent_after: 1
        })
      );

      expect(result).toHaveLength(2);
      
      // c3's after should include c4, c4's before should include c3
      // But these are already in the main results, so should not duplicate
      const allContextChunkIds = new Set<string>();
      for (const r of result) {
        for (const s of r.context.siblings_before) {
          allContextChunkIds.add(s.chunk_id);
        }
        for (const s of r.context.siblings_after) {
          allContextChunkIds.add(s.chunk_id);
        }
      }
      
      // No chunk should appear in context that is already a main result
      expect(allContextChunkIds.has('c3')).toBe(false);
      expect(allContextChunkIds.has('c4')).toBe(false);
    });

    it('should not include the matched chunk itself in context', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[3], score: 0.9 }], // c4
        testRunId,
        createHydrateOptions({ strategy: 'both', adjacent_before: 5, adjacent_after: 5 })
      );

      expect(result).toHaveLength(1);
      
      const beforeIds = result[0].context.siblings_before.map((c: DocumentChunk) => c.chunk_id);
      const afterIds = result[0].context.siblings_after.map((c: DocumentChunk) => c.chunk_id);
      
      expect(beforeIds).not.toContain('c4');
      expect(afterIds).not.toContain('c4');
    });

    it('should prioritize parent over distant adjacent when max_total_chunks is limited', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[6], score: 0.9 }], // c7
        testRunId,
        createHydrateOptions({
          strategy: 'both',
          adjacent_before: 5,
          adjacent_after: 5,
          include_parent: true,
          max_total_chunks: 2
        })
      );

      expect(result).toHaveLength(1);
      // Parent (c6) should be included as it's most relevant for context
      expect(result[0].context.parent).toBeDefined();
    });
  });

  // ============================================================================
  // hydrateChunk Single Chunk Tests
  // ============================================================================

  describe('hydrateChunk Function', () => {
    it('should hydrate a single chunk with adjacent context', async () => {
      const result = await hydrateChunk(
        testChunks[3], // c4
        testChunks,
        createHydrateOptions({ strategy: 'adjacent', adjacent_before: 1, adjacent_after: 1 })
      );

      expect(result.chunk.chunk_id).toBe('c4');
      expect(result.context.siblings_before).toHaveLength(1);
      expect(result.context.siblings_after).toHaveLength(1);
    });

    it('should hydrate a single chunk with parent context', async () => {
      const result = await hydrateChunk(
        testChunks[2], // c3 has parent c2
        testChunks,
        createHydrateOptions({ strategy: 'parent', include_parent: true })
      );

      expect(result.chunk.chunk_id).toBe('c3');
      expect(result.context.parent).toBeDefined();
      expect(result.context.parent?.chunk_id).toBe('c2');
    });

    it('should preserve original chunk score', async () => {
      const result = await hydrateChunk(
        testChunks[3],
        testChunks,
        createHydrateOptions({ strategy: 'adjacent' }),
        0.95 // explicit score
      );

      expect(result.score).toBe(0.95);
    });

    it('should return empty context when enabled=false', async () => {
      const result = await hydrateChunk(
        testChunks[3],
        testChunks,
        createHydrateOptions({ enabled: false })
      );

      expect(result.context.siblings_before).toHaveLength(0);
      expect(result.context.siblings_after).toHaveLength(0);
      expect(result.context.parent).toBeUndefined();
    });
  });

  // ============================================================================
  // Integration Tests
  // ============================================================================

  describe('Integration with serveQuery', () => {
    it('should include hydrated context in serveQuery results when expand_context is enabled', async () => {
      const result = await serveQuery({
        run_id: testRunId,
        query: 'Section A content',
        mode: 'keyword',
        top_k: 3,
        expand_context: {
          enabled: true,
          strategy: 'both',
          adjacent_before: 1,
          adjacent_after: 1,
          include_parent: true
        }
      });

      expect(result).toBeDefined();
      // Results should have context property
      if ('results' in result && Array.isArray(result.results)) {
        for (const r of result.results) {
          expect(r).toHaveProperty('context');
          expect(r.context).toHaveProperty('siblings_before');
          expect(r.context).toHaveProperty('siblings_after');
        }
      }
    });

    it('should not include hydrated context when expand_context.enabled=false', async () => {
      const result = await serveQuery({
        run_id: testRunId,
        query: 'test query',
        mode: 'keyword',
        expand_context: {
          enabled: false
        }
      });

      expect(result).toBeDefined();
      if ('results' in result && Array.isArray(result.results)) {
        for (const r of result.results) {
          // Context should not be present or be empty
          expect(r.context === undefined || 
            (r.context.siblings_before.length === 0 && 
             r.context.siblings_after.length === 0 &&
             r.context.parent === undefined)).toBe(true);
        }
      }
    });

    it('should work with semantic search mode and context expansion', async () => {
      const result = await serveQuery({
        run_id: testRunId,
        query: 'subsection details',
        mode: 'semantic',
        expand_context: {
          enabled: true,
          strategy: 'parent'
        }
      });

      expect(result).toBeDefined();
    });

    it('should work with hybrid search mode and context expansion', async () => {
      const result = await serveQuery({
        run_id: testRunId,
        query: 'section content',
        mode: 'hybrid',
        expand_context: {
          enabled: true,
          strategy: 'both',
          max_total_chunks: 5
        }
      });

      expect(result).toBeDefined();
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('Edge Cases', () => {
    it('should handle empty search results', async () => {
      const result = await hydrateSearchResults(
        [],
        testRunId,
        createHydrateOptions()
      );

      expect(result).toHaveLength(0);
    });

    it('should handle single chunk document - no adjacent chunks', async () => {
      // c8 is a standalone chunk in its own document
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[7], score: 0.9 }], // c8
        testRunId,
        createHydrateOptions({ strategy: 'adjacent', adjacent_before: 5, adjacent_after: 5 })
      );

      expect(result).toHaveLength(1);
      expect(result[0].context.siblings_before).toHaveLength(0);
      expect(result[0].context.siblings_after).toHaveLength(0);
    });

    it('should work without hierarchy info (no parent_id fields)', async () => {
      const flatChunk: DocumentChunk = {
        ...createTestChunk({ chunk_id: 'flat1', chunk_index: 0 }),
        parent_id: undefined,
        hierarchy_level: undefined
      };

      const result = await hydrateSearchResults(
        [{ chunk: flatChunk, score: 0.9 }],
        testRunId,
        createHydrateOptions({ strategy: 'parent', include_parent: true })
      );

      expect(result).toHaveLength(1);
      expect(result[0].context.parent).toBeUndefined();
      expect(result[0].context.hierarchy_path).toBeUndefined();
    });

    it('should handle chunk with circular parent reference gracefully', async () => {
      // Edge case: chunk references itself as parent
      const circularChunk: DocumentChunk = {
        ...createTestChunk({ chunk_id: 'circular', chunk_index: 0 }),
        parent_id: 'circular', // References itself!
        hierarchy_level: 2
      };

      const result = await hydrateSearchResults(
        [{ chunk: circularChunk, score: 0.9 }],
        testRunId,
        createHydrateOptions({ strategy: 'parent', include_parent: true })
      );

      // Should not cause infinite loop
      expect(result).toHaveLength(1);
    });

    it('should handle very long parent chain', async () => {
      // Create a deeply nested structure
      const deepChunks: DocumentChunk[] = [];
      for (let i = 0; i < 10; i++) {
        deepChunks.push({
          ...createTestChunk({ chunk_id: `deep${i}`, chunk_index: i }),
          parent_id: i > 0 ? `deep${i - 1}` : undefined,
          hierarchy_level: i + 1,
          doc_id: 'deep-doc'
        });
      }

      const result = await hydrateChunk(
        deepChunks[9], // deepest chunk
        deepChunks,
        createHydrateOptions({ strategy: 'parent', include_parent: true })
      );

      expect(result.context.hierarchy_path?.length).toBe(10);
    });

    it('should handle chunks with same chunk_index from different documents', async () => {
      // c1 and c8 both have chunk_index 0 but different doc_ids
      const result = await hydrateSearchResults(
        [
          { chunk: testChunks[0], score: 0.95 }, // c1 from test-doc-001
          { chunk: testChunks[7], score: 0.9 }   // c8 from test-doc-002
        ],
        testRunId,
        createHydrateOptions({ strategy: 'adjacent', adjacent_before: 1, adjacent_after: 1 })
      );

      expect(result).toHaveLength(2);
      // Each should only get context from its own document
    });

    it('should handle null/undefined scores gracefully', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[2], score: undefined as unknown as number }],
        testRunId,
        createHydrateOptions()
      );

      expect(result).toHaveLength(1);
      expect(result[0].score).toBe(0); // or default score
    });

    it('should preserve chunk metadata in hydrated results', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[2], score: 0.9 }],
        testRunId,
        createHydrateOptions({ strategy: 'adjacent' })
      );

      expect(result).toHaveLength(1);
      expect(result[0].chunk.metadata).toEqual(testChunks[2].metadata);
      expect(result[0].chunk.source).toEqual(testChunks[2].source);
    });

    it('should handle large number of search results efficiently', async () => {
      const manyResults = testChunks.slice(0, 5).map((chunk, i) => ({
        chunk,
        score: 0.9 - i * 0.1
      }));

      const startTime = Date.now();
      const result = await hydrateSearchResults(
        manyResults,
        testRunId,
        createHydrateOptions({ strategy: 'both', adjacent_before: 2, adjacent_after: 2 })
      );
      const duration = Date.now() - startTime;

      expect(result).toHaveLength(5);
      expect(duration).toBeLessThan(5000); // Should complete in under 5 seconds
    });
  });

  // ============================================================================
  // Output Structure Tests
  // ============================================================================

  describe('Output Structure', () => {
    it('should return HydratedSearchResult with correct structure', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[3], score: 0.9 }],
        testRunId,
        createHydrateOptions({ strategy: 'both', include_parent: true })
      );

      expect(result).toHaveLength(1);
      const hydrated = result[0];

      // Check main structure
      expect(hydrated).toHaveProperty('chunk');
      expect(hydrated).toHaveProperty('score');
      expect(hydrated).toHaveProperty('context');

      // Check context structure
      expect(hydrated.context).toHaveProperty('siblings_before');
      expect(hydrated.context).toHaveProperty('siblings_after');
      expect(Array.isArray(hydrated.context.siblings_before)).toBe(true);
      expect(Array.isArray(hydrated.context.siblings_after)).toBe(true);
    });

    it('should include chunk field as DocumentChunk', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[2], score: 0.85 }],
        testRunId,
        createHydrateOptions()
      );

      const chunk = result[0].chunk;
      expect(chunk).toHaveProperty('chunk_id');
      expect(chunk).toHaveProperty('doc_id');
      expect(chunk).toHaveProperty('content');
      expect(chunk).toHaveProperty('source');
    });

    it('should include score as number', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[2], score: 0.876 }],
        testRunId,
        createHydrateOptions()
      );

      expect(typeof result[0].score).toBe('number');
      expect(result[0].score).toBeCloseTo(0.876, 3);
    });

    it('should include parent as DocumentChunk when present', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[2], score: 0.9 }], // c3 has parent c2
        testRunId,
        createHydrateOptions({ strategy: 'parent', include_parent: true })
      );

      const parent = result[0].context.parent;
      expect(parent).toBeDefined();
      expect(parent).toHaveProperty('chunk_id');
      expect(parent).toHaveProperty('content');
    });

    it('should include hierarchy_path as string array when present', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[6], score: 0.9 }], // c7 has deep hierarchy
        testRunId,
        createHydrateOptions({ strategy: 'parent', include_parent: true })
      );

      const path = result[0].context.hierarchy_path;
      expect(Array.isArray(path)).toBe(true);
      expect(path?.every((id: string) => typeof id === 'string')).toBe(true);
    });

    it('should include siblings as DocumentChunk arrays', async () => {
      const result = await hydrateSearchResults(
        [{ chunk: testChunks[3], score: 0.9 }], // c4
        testRunId,
        createHydrateOptions({ strategy: 'adjacent', adjacent_before: 2, adjacent_after: 2 })
      );

      const siblings_before = result[0].context.siblings_before;
      const siblings_after = result[0].context.siblings_after;

      expect(Array.isArray(siblings_before)).toBe(true);
      expect(Array.isArray(siblings_after)).toBe(true);

      for (const sibling of [...siblings_before, ...siblings_after]) {
        expect(sibling).toHaveProperty('chunk_id');
        expect(sibling).toHaveProperty('content');
        expect(sibling).toHaveProperty('doc_id');
      }
    });
  });
});
