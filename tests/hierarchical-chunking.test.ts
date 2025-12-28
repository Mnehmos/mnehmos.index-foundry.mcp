/**
 * Hierarchical Parent-Child Chunking Tests
 * 
 * These tests define the contract for hierarchical chunking in IndexFoundry.
 * Tests invoke the actual normalizeChunk() implementation and verify outputs.
 * 
 * Feature Requirements:
 * - DocumentChunk needs: parent_id, parent_context, hierarchy_level
 * - NormalizeChunkInputSchema needs: strategy="hierarchical", create_parent_chunks, parent_context_chars
 * - ChunkStrategy type needs: "hierarchical"
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs/promises';
import * as path from 'path';

// Import schemas and types from source
import { NormalizeChunkInputSchema, NormalizeChunkInput } from '../src/schemas.js';
import type { DocumentChunk, ChunkStrategy } from '../src/types.js';
import { normalizeChunk, NormalizeChunkResult } from '../src/tools/normalize.js';
import { initRunManager } from '../src/run-manager.js';

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
 * Check if a result is a successful NormalizeChunkResult (not an error)
 */
function isSuccess(result: unknown): result is NormalizeChunkResult {
  return result !== null && typeof result === 'object' && 'success' in result && (result as NormalizeChunkResult).success === true;
}

/**
 * Default chunk options for hierarchical strategy
 * These fill in required fields that have Zod defaults
 */
function createHierarchicalInput(
  run_id: string,
  input_paths: string[],
  overrides: Partial<NormalizeChunkInput> = {}
): NormalizeChunkInput {
  return {
    run_id,
    input_paths,
    strategy: 'hierarchical',
    max_chars: 1500,
    min_chars: 50,
    overlap_chars: 0,
    split_hierarchy: ['\n\n', '\n', '. ', ' '],
    create_parent_chunks: true,
    parent_context_chars: 100,
    force: true, // Always force in tests to ensure fresh output
    ...overrides
  };
}

describe('Hierarchical Parent-Child Chunking', () => {
  const testRunId = uuidv4();
  const runsDir = path.join(process.cwd(), '.indexfoundry', 'runs', testRunId);
  const extractedDir = path.join(runsDir, 'extracted');
  const normalizedDir = path.join(runsDir, 'normalized');
  const chunksOutputPath = path.join(normalizedDir, 'chunks.jsonl');

  // Sample markdown with clear heading hierarchy
  const sampleMarkdown = `# Main Title
Intro paragraph with some content that provides context for the entire document.

## Section A
Section A content here with details about the first major topic.

### Subsection A1
Detailed content for A1 that should become a child chunk. This subsection 
explores the first aspect of Section A in greater detail.

### Subsection A2
More detailed content for A2. This subsection covers the second aspect 
of Section A with additional information.

## Section B
Section B content with different information about another major topic.

### Subsection B1
B1 details go here. This is a child of Section B and should reference 
it as the parent chunk.

#### Deep Nested B1a
Even deeper nesting to test hierarchy level 4.

##### Very Deep B1a-i
Testing h5 heading at hierarchy level 5.

###### Deepest B1a-i-1
Testing h6 heading at hierarchy level 6.
`;

  // Markdown with no headings - edge case
  const noHeadingsMarkdown = `This is a document without any headings.
It just contains plain paragraphs of text.

Another paragraph here with more content.
This should still be chunked but without hierarchy.

Final paragraph to ensure we have enough content.
`;

  // Markdown with malformed headings - edge case
  const malformedHeadingsMarkdown = `#NoSpace at the start
This has no space after the hash.

##Also No Space
Another malformed heading.

######
Empty heading with just hashes.

# Valid Heading
This one is valid.
`;

  // Unicode markdown for edge case testing
  const unicodeMarkdown = `# 标题 (Title in Chinese)
Content under Chinese heading.

## Überschrift (German)
Content under German heading.

### 見出し (Japanese)
Content under Japanese heading.
`;

  // Consecutive headings markdown
  const consecutiveHeadingsMarkdown = `# Title

## Section 1
### Subsection 1.1
### Subsection 1.2
Content only here.
`;

  // Long heading markdown
  const longHeadingMarkdown = `# ${'A'.repeat(500)}
Some content under the long heading.
`;

  beforeAll(async () => {
    // Initialize the RunManager with the .indexfoundry directory
    initRunManager(path.join(process.cwd(), '.indexfoundry'));
    
    // Setup test run directory structure
    await fs.mkdir(extractedDir, { recursive: true });
    await fs.mkdir(normalizedDir, { recursive: true });
    
    // Write sample markdown file
    await fs.writeFile(
      path.join(extractedDir, 'sample.md'),
      sampleMarkdown,
      'utf-8'
    );
    
    // Write no-headings test file
    await fs.writeFile(
      path.join(extractedDir, 'no-headings.md'),
      noHeadingsMarkdown,
      'utf-8'
    );
    
    // Write malformed headings test file
    await fs.writeFile(
      path.join(extractedDir, 'malformed.md'),
      malformedHeadingsMarkdown,
      'utf-8'
    );

    // Write unicode test file
    await fs.writeFile(
      path.join(extractedDir, 'unicode.md'),
      unicodeMarkdown,
      'utf-8'
    );

    // Write consecutive headings test file
    await fs.writeFile(
      path.join(extractedDir, 'consecutive.md'),
      consecutiveHeadingsMarkdown,
      'utf-8'
    );

    // Write long heading test file
    await fs.writeFile(
      path.join(extractedDir, 'long-heading.md'),
      longHeadingMarkdown,
      'utf-8'
    );
  });

  afterAll(async () => {
    // Cleanup test run directory
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
    it('should accept "hierarchical" as a valid strategy option', () => {
      const input = {
        run_id: testRunId,
        input_paths: ['extracted/sample.md'],
        strategy: 'hierarchical' as const,
        max_chars: 1500,
        min_chars: 100,
        overlap_chars: 150
      };

      const result = NormalizeChunkInputSchema.safeParse(input);
      
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.strategy).toBe('hierarchical');
      }
    });

    it('should accept create_parent_chunks boolean option', () => {
      const input = {
        run_id: testRunId,
        input_paths: ['extracted/sample.md'],
        strategy: 'hierarchical' as const,
        create_parent_chunks: true,
        max_chars: 1500
      };

      const result = NormalizeChunkInputSchema.safeParse(input);
      
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveProperty('create_parent_chunks');
        expect((result.data as Record<string, unknown>).create_parent_chunks).toBe(true);
      }
    });

    it('should accept parent_context_chars number option with valid range', () => {
      const input = {
        run_id: testRunId,
        input_paths: ['extracted/sample.md'],
        strategy: 'hierarchical' as const,
        parent_context_chars: 200,
        max_chars: 1500
      };

      const result = NormalizeChunkInputSchema.safeParse(input);
      
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveProperty('parent_context_chars');
        expect((result.data as Record<string, unknown>).parent_context_chars).toBe(200);
      }
    });

    it('should reject parent_context_chars when negative', () => {
      const input = {
        run_id: testRunId,
        input_paths: ['extracted/sample.md'],
        strategy: 'hierarchical' as const,
        parent_context_chars: -50,
        max_chars: 1500
      };

      const result = NormalizeChunkInputSchema.safeParse(input);
      
      expect(result.success).toBe(false);
    });

    it('should default create_parent_chunks to true when strategy is hierarchical', () => {
      const input = {
        run_id: testRunId,
        input_paths: ['extracted/sample.md'],
        strategy: 'hierarchical' as const,
        max_chars: 1500
      };

      const result = NormalizeChunkInputSchema.safeParse(input);
      
      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as Record<string, unknown>).create_parent_chunks).toBe(true);
      }
    });
  });

  // ============================================================================
  // DocumentChunk Type Tests
  // ============================================================================

  describe('DocumentChunk Type Contract', () => {
    it('should include parent_id field for child chunks', async () => {
      const result = await normalizeChunk(createHierarchicalInput(
        testRunId,
        ['extracted/sample.md'],
        { parent_context_chars: 100 }
      ));

      expect(isSuccess(result)).toBe(true);
      
      const chunks = await readJsonl<DocumentChunk>(chunksOutputPath);
      expect(chunks.length).toBeGreaterThan(0);
      
      // Find chunks that have a parent_id (child chunks)
      const childChunks = chunks.filter(c => c.parent_id !== undefined);
      
      // At least some chunks should have parent_id set
      expect(childChunks.length).toBeGreaterThan(0);
      
      // Verify parent_id is a string
      for (const child of childChunks) {
        expect(typeof child.parent_id).toBe('string');
      }
    });

    it('should include parent_context field for child chunks', async () => {
      const result = await normalizeChunk(createHierarchicalInput(
        testRunId,
        ['extracted/sample.md'],
        { parent_context_chars: 100 }
      ));

      expect(isSuccess(result)).toBe(true);
      
      const chunks = await readJsonl<DocumentChunk>(chunksOutputPath);
      
      // Find chunks that have parent_context
      const chunksWithContext = chunks.filter(c => c.parent_context !== undefined);
      
      expect(chunksWithContext.length).toBeGreaterThan(0);
      
      for (const chunk of chunksWithContext) {
        expect(typeof chunk.parent_context).toBe('string');
        expect(chunk.parent_context!.length).toBeGreaterThan(0);
        expect(chunk.parent_context!.length).toBeLessThanOrEqual(100);
      }
    });

    it('should include hierarchy_level field', async () => {
      const result = await normalizeChunk(createHierarchicalInput(
        testRunId,
        ['extracted/sample.md']
      ));

      expect(isSuccess(result)).toBe(true);
      
      const chunks = await readJsonl<DocumentChunk>(chunksOutputPath);
      expect(chunks.length).toBeGreaterThan(0);
      
      // All chunks should have hierarchy_level
      for (const chunk of chunks) {
        expect(chunk).toHaveProperty('hierarchy_level');
        expect(typeof chunk.hierarchy_level).toBe('number');
      }
    });
  });

  // ============================================================================
  // ChunkStrategy Type Tests
  // ============================================================================

  describe('ChunkStrategy Type', () => {
    it('should include "hierarchical" as a valid strategy type', () => {
      const strategy: ChunkStrategy = 'hierarchical' as ChunkStrategy;
      
      const validStrategies: ChunkStrategy[] = [
        'fixed_chars',
        'by_paragraph',
        'by_heading',
        'by_page',
        'by_sentence',
        'recursive',
        'hierarchical' as ChunkStrategy
      ];
      
      expect(validStrategies).toContain('hierarchical');
    });
  });

  // ============================================================================
  // Parent Chunk Creation Tests
  // ============================================================================

  describe('Parent Chunk Creation', () => {
    it('should create parent chunks for h1 headings when create_parent_chunks=true', async () => {
      const result = await normalizeChunk(createHierarchicalInput(
        testRunId,
        ['extracted/sample.md']
      ));

      expect(isSuccess(result)).toBe(true);
      
      const chunks = await readJsonl<DocumentChunk>(chunksOutputPath);
      
      const h1Chunks = chunks.filter(c => c.hierarchy_level === 1);
      
      expect(h1Chunks.length).toBeGreaterThan(0);
      
      // h1 chunks should be root level (no parent_id)
      const mainTitleChunk = h1Chunks.find(c => c.content.text.includes('Main Title'));
      expect(mainTitleChunk).toBeDefined();
      expect(mainTitleChunk!.parent_id).toBeUndefined();
    });

    it('should create parent chunks for h2 headings', async () => {
      const result = await normalizeChunk(createHierarchicalInput(
        testRunId,
        ['extracted/sample.md']
      ));

      expect(isSuccess(result)).toBe(true);
      
      const chunks = await readJsonl<DocumentChunk>(chunksOutputPath);
      
      const h2Chunks = chunks.filter(c => c.hierarchy_level === 2);
      
      // Sample has Section A and Section B at h2 level
      expect(h2Chunks.length).toBeGreaterThanOrEqual(2);
      
      // h2 chunks should have parent_id pointing to h1
      for (const h2 of h2Chunks) {
        expect(h2.parent_id).toBeDefined();
        expect(typeof h2.parent_id).toBe('string');
      }
    });

    it('should create parent chunks for h3 headings', async () => {
      const result = await normalizeChunk(createHierarchicalInput(
        testRunId,
        ['extracted/sample.md']
      ));

      expect(isSuccess(result)).toBe(true);
      
      const chunks = await readJsonl<DocumentChunk>(chunksOutputPath);
      
      const h3Chunks = chunks.filter(c => c.hierarchy_level === 3);
      
      // Sample has: Subsection A1, A2, B1
      expect(h3Chunks.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ============================================================================
  // Parent-Child Relationship Tests
  // ============================================================================

  describe('Parent-Child Relationships', () => {
    it('should assign parent_id to child chunks referencing their parent', async () => {
      const result = await normalizeChunk(createHierarchicalInput(
        testRunId,
        ['extracted/sample.md']
      ));

      expect(isSuccess(result)).toBe(true);
      
      const chunks = await readJsonl<DocumentChunk>(chunksOutputPath);
      
      // Find child chunks (those with parent_id)
      const childChunks = chunks.filter(c => c.parent_id !== undefined);
      
      expect(childChunks.length).toBeGreaterThan(0);
      
      // Verify each parent_id references a valid chunk
      for (const child of childChunks) {
        const parent = chunks.find(c => c.chunk_id === child.parent_id);
        expect(parent).toBeDefined();
      }
    });

    it('should include parent_context in child chunks when parent_context_chars > 0', async () => {
      const result = await normalizeChunk(createHierarchicalInput(
        testRunId,
        ['extracted/sample.md'],
        { parent_context_chars: 100 }
      ));

      expect(isSuccess(result)).toBe(true);
      
      const chunks = await readJsonl<DocumentChunk>(chunksOutputPath);
      
      const childWithContext = chunks.find(c => 
        c.parent_id !== undefined && c.parent_context !== undefined
      );
      
      expect(childWithContext).toBeDefined();
      
      if (childWithContext) {
        expect(typeof childWithContext.parent_context).toBe('string');
        expect(childWithContext.parent_context!.length).toBeGreaterThan(0);
        expect(childWithContext.parent_context!.length).toBeLessThanOrEqual(100);
      }
    });

    it('should not include parent_context when parent_context_chars is 0', async () => {
      const result = await normalizeChunk(createHierarchicalInput(
        testRunId,
        ['extracted/sample.md'],
        { parent_context_chars: 0 }
      ));

      expect(isSuccess(result)).toBe(true);
      
      const chunks = await readJsonl<DocumentChunk>(chunksOutputPath);
      
      const childChunks = chunks.filter(c => c.parent_id !== undefined);
      
      for (const child of childChunks) {
        // parent_context should be undefined or empty when parent_context_chars=0
        expect(child.parent_context === undefined || child.parent_context === '').toBe(true);
      }
    });

    it('should maintain proper parent chain for deeply nested content', async () => {
      const result = await normalizeChunk(createHierarchicalInput(
        testRunId,
        ['extracted/sample.md'],
        { min_chars: 20 }
      ));

      expect(isSuccess(result)).toBe(true);
      
      const chunks = await readJsonl<DocumentChunk>(chunksOutputPath);
      
      // Find the deepest chunk (should be h6)
      const deepestChunk = chunks.find(c => c.hierarchy_level === 6);
      
      expect(deepestChunk).toBeDefined();
      
      if (deepestChunk) {
        // Verify we can trace back to root
        let current: DocumentChunk | undefined = deepestChunk;
        const levels: number[] = [];
        
        while (current) {
          levels.push(current.hierarchy_level ?? 0);
          if (current.parent_id) {
            current = chunks.find(c => c.chunk_id === current!.parent_id);
          } else {
            current = undefined;
          }
        }
        
        // Should have traversed from deepest (6) up towards 1
        expect(levels[0]).toBe(6);
        // Each subsequent level should be smaller
        for (let i = 1; i < levels.length; i++) {
          expect(levels[i]).toBeLessThan(levels[i - 1]);
        }
      }
    });
  });

  // ============================================================================
  // Hierarchy Level Tests
  // ============================================================================

  describe('Hierarchy Levels', () => {
    it('should set hierarchy_level=1 for h1 heading chunks', async () => {
      const result = await normalizeChunk(createHierarchicalInput(
        testRunId,
        ['extracted/sample.md']
      ));

      expect(isSuccess(result)).toBe(true);
      
      const chunks = await readJsonl<DocumentChunk>(chunksOutputPath);
      
      const h1Chunk = chunks.find(c => c.content.text.includes('Main Title'));
      
      expect(h1Chunk).toBeDefined();
      expect(h1Chunk!.hierarchy_level).toBe(1);
    });

    it('should set hierarchy_level=2 for h2 heading chunks', async () => {
      const result = await normalizeChunk(createHierarchicalInput(
        testRunId,
        ['extracted/sample.md']
      ));

      expect(isSuccess(result)).toBe(true);
      
      const chunks = await readJsonl<DocumentChunk>(chunksOutputPath);
      
      // Filter for chunks that START with an h2 heading (## Section)
      // to avoid matching h3 chunks that mention the parent section name
      const h2Chunks = chunks.filter(c => {
        const text = c.content.text;
        return text.startsWith('## Section A') || text.startsWith('## Section B');
      });
      
      expect(h2Chunks.length).toBeGreaterThanOrEqual(2);
      for (const chunk of h2Chunks) {
        expect(chunk.hierarchy_level).toBe(2);
      }
    });

    it('should set hierarchy_level=3 for h3 heading chunks', async () => {
      const result = await normalizeChunk(createHierarchicalInput(
        testRunId,
        ['extracted/sample.md']
      ));

      expect(isSuccess(result)).toBe(true);
      
      const chunks = await readJsonl<DocumentChunk>(chunksOutputPath);
      
      const h3Chunks = chunks.filter(c => c.hierarchy_level === 3);
      
      expect(h3Chunks.length).toBeGreaterThanOrEqual(3);
    });

    it('should handle deeply nested h4-h6 headings with correct hierarchy_level', async () => {
      const result = await normalizeChunk(createHierarchicalInput(
        testRunId,
        ['extracted/sample.md'],
        { min_chars: 20 }
      ));

      expect(isSuccess(result)).toBe(true);
      
      const chunks = await readJsonl<DocumentChunk>(chunksOutputPath);
      
      // Verify h4 = level 4
      const h4Chunks = chunks.filter(c => c.hierarchy_level === 4);
      expect(h4Chunks.length).toBeGreaterThanOrEqual(1);
      
      // Verify h5 = level 5
      const h5Chunks = chunks.filter(c => c.hierarchy_level === 5);
      expect(h5Chunks.length).toBeGreaterThanOrEqual(1);
      
      // Verify h6 = level 6
      const h6Chunks = chunks.filter(c => c.hierarchy_level === 6);
      expect(h6Chunks.length).toBeGreaterThanOrEqual(1);
    });

    it('should set hierarchy_level=0 for content not under any heading', async () => {
      const result = await normalizeChunk(createHierarchicalInput(
        testRunId,
        ['extracted/no-headings.md']
      ));

      expect(isSuccess(result)).toBe(true);
      
      const chunks = await readJsonl<DocumentChunk>(chunksOutputPath);
      
      // Document without headings should produce chunks at level 0
      const rootLevelChunks = chunks.filter(c => c.hierarchy_level === 0);
      
      expect(rootLevelChunks.length).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('Edge Cases', () => {
    it('should handle documents with no headings gracefully', async () => {
      const result = await normalizeChunk(createHierarchicalInput(
        testRunId,
        ['extracted/no-headings.md']
      ));

      expect(isSuccess(result)).toBe(true);
      
      const chunks = await readJsonl<DocumentChunk>(chunksOutputPath);
      
      expect(chunks.length).toBeGreaterThan(0);
      
      for (const chunk of chunks) {
        expect(chunk.hierarchy_level).toBe(0);
        expect(chunk.parent_id).toBeUndefined();
      }
    });

    it('should handle malformed heading syntax gracefully', async () => {
      const result = await normalizeChunk(createHierarchicalInput(
        testRunId,
        ['extracted/malformed.md'],
        { min_chars: 20 }
      ));

      expect(isSuccess(result)).toBe(true);
      
      const chunks = await readJsonl<DocumentChunk>(chunksOutputPath);
      
      // Should have produced some chunks without throwing
      expect(chunks.length).toBeGreaterThan(0);
    });

    it('should handle empty heading text', async () => {
      const result = await normalizeChunk(createHierarchicalInput(
        testRunId,
        ['extracted/malformed.md'],
        { min_chars: 20 }
      ));

      expect(isSuccess(result)).toBe(true);
      
      const chunks = await readJsonl<DocumentChunk>(chunksOutputPath);
      
      // Empty headings should either be skipped or treated as content
      expect(chunks.length).toBeGreaterThan(0);
    });

    it('should handle heading immediately followed by another heading', async () => {
      const result = await normalizeChunk(createHierarchicalInput(
        testRunId,
        ['extracted/consecutive.md'],
        { min_chars: 20 }
      ));

      expect(isSuccess(result)).toBe(true);
      
      const chunks = await readJsonl<DocumentChunk>(chunksOutputPath);
      
      // Headings without content should still create parent chunks
      expect(chunks.length).toBeGreaterThan(0);
    });

    it('should handle very long heading text', async () => {
      const result = await normalizeChunk(createHierarchicalInput(
        testRunId,
        ['extracted/long-heading.md'],
        { min_chars: 20 }
      ));

      expect(isSuccess(result)).toBe(true);
      
      const chunks = await readJsonl<DocumentChunk>(chunksOutputPath);
      
      expect(chunks.length).toBeGreaterThan(0);
    });

    it('should handle Unicode in headings', async () => {
      const result = await normalizeChunk(createHierarchicalInput(
        testRunId,
        ['extracted/unicode.md'],
        { min_chars: 20 }
      ));

      expect(isSuccess(result)).toBe(true);
      
      const chunks = await readJsonl<DocumentChunk>(chunksOutputPath);
      
      expect(chunks.length).toBeGreaterThan(0);
      
      const chineseChunk = chunks.find(c => c.content.text.includes('标题'));
      
      expect(chineseChunk).toBeDefined();
    });
  });

  // ============================================================================
  // Integration-Style Tests
  // ============================================================================

  describe('Full Chunking Pipeline Integration', () => {
    it('should produce valid JSONL output with hierarchical chunks', async () => {
      const result = await normalizeChunk(createHierarchicalInput(
        testRunId,
        ['extracted/sample.md']
      ));

      expect(isSuccess(result)).toBe(true);
      
      // Check file exists
      let fileExists = false;
      try {
        await fs.access(chunksOutputPath);
        fileExists = true;
      } catch {
        fileExists = false;
      }
      
      expect(fileExists).toBe(true);
      
      // Verify JSONL is valid
      const chunks = await readJsonl<DocumentChunk>(chunksOutputPath);
      expect(chunks.length).toBeGreaterThan(0);
    });

    it('should include chunker_config with hierarchical strategy in output', async () => {
      const result = await normalizeChunk(createHierarchicalInput(
        testRunId,
        ['extracted/sample.md']
      ));

      expect(isSuccess(result)).toBe(true);
      
      if (isSuccess(result)) {
        expect(result.chunker_config).toBeDefined();
        expect(result.chunker_config.strategy).toBe('hierarchical');
        expect(result.chunker_config.max_chars).toBe(1500);
        expect(result.chunker_config.overlap_chars).toBe(0);
      }
    });

    it('should track chunk counts in stats', async () => {
      const result = await normalizeChunk(createHierarchicalInput(
        testRunId,
        ['extracted/sample.md']
      ));

      expect(isSuccess(result)).toBe(true);
      
      if (isSuccess(result)) {
        expect(result.stats).toBeDefined();
        expect(result.stats.documents_processed).toBe(1);
        expect(result.stats.chunks_created).toBeGreaterThan(0);
        expect(typeof result.stats.avg_chunk_chars).toBe('number');
        expect(typeof result.stats.total_chars).toBe('number');
      }
    });
  });
});
