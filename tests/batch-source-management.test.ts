/**
 * Batch Source Management Tests (ADR-005)
 *
 * These tests define the contract for batch source operations:
 * 1. Batch Add Sources - add multiple sources in a single operation
 * 2. Remove Source - remove sources with cascade deletion of chunks/vectors
 *
 * Feature Requirements (ADR-005):
 * - BatchSourceItemSchema for validating individual items in batch array
 * - ProjectAddSourceSchema enhanced with batch parameter
 * - ProjectRemoveSourceSchema for source removal operations
 * - Cascade deletion of associated chunks and vectors
 * - Confirmation requirement for destructive operations
 *
 * Integration Points:
 * - src/schemas-projects.ts - Schema definitions
 * - src/tools/projects.ts - Implementation functions
 * - src/index.ts - Tool registration
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import path from 'path';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';

// Import schemas - these will fail until implemented
import {
  ProjectAddSourceSchema,
  BatchSourceItemSchema,           // ADR-005: New schema for batch items
  ProjectRemoveSourceSchema,       // ADR-005: New schema for remove source
  SourceRecord,
  ChunkRecord,
  VectorRecord,
} from '../src/schemas-projects.js';

// Import functions - these will fail until implemented
import {
  projectAddSource,
  projectRemoveSource,             // ADR-005: New function
  projectCreate,
  projectGet,
  initProjectManager,
} from '../src/tools/projects.js';

import {
  writeJsonl,
  readJsonl,
  writeJson,
  readJson,
} from '../src/utils.js';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a temporary test project directory
 */
async function createTempProjectDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'indexfoundry-test-'));
  return tempDir;
}

/**
 * Initialize a test project with manifest and sources file
 */
async function initTestProject(
  baseDir: string,
  projectId: string,
  options?: {
    sources?: SourceRecord[];
    chunks?: ChunkRecord[];
    vectors?: VectorRecord[];
  }
): Promise<string> {
  const projectDir = path.join(baseDir, 'projects', projectId);
  const dataDir = path.join(projectDir, 'data');
  
  await mkdir(projectDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  
  // Write manifest
  const manifest = {
    project_id: projectId,
    name: `Test Project ${projectId}`,
    description: 'Test project for batch source management',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    embedding_model: {
      provider: 'openai',
      model_name: 'text-embedding-3-small',
      api_key_env: 'OPENAI_API_KEY',
    },
    chunk_config: {
      strategy: 'recursive',
      max_chars: 1500,
      overlap_chars: 150,
    },
    stats: {
      sources_count: options?.sources?.length || 0,
      chunks_count: options?.chunks?.length || 0,
      vectors_count: options?.vectors?.length || 0,
      total_tokens: 0,
    },
  };
  
  await writeJson(path.join(projectDir, 'project.json'), manifest);
  
  // Write sources
  if (options?.sources) {
    await writeJsonl(path.join(projectDir, 'sources.jsonl'), options.sources);
  } else {
    await writeJsonl(path.join(projectDir, 'sources.jsonl'), []);
  }
  
  // Write chunks
  if (options?.chunks) {
    await writeJsonl(path.join(dataDir, 'chunks.jsonl'), options.chunks);
  }
  
  // Write vectors
  if (options?.vectors) {
    await writeJsonl(path.join(dataDir, 'vectors.jsonl'), options.vectors);
  }
  
  return projectDir;
}

/**
 * Create a mock source record
 */
function createMockSource(overrides: Partial<SourceRecord> = {}): SourceRecord {
  const defaultSource: SourceRecord = {
    source_id: 'test-source-' + Math.random().toString(36).slice(2, 10),
    type: 'url',
    uri: 'https://example.com/test-' + Math.random().toString(36).slice(2, 8),
    source_name: 'Test Source',
    tags: [],
    added_at: new Date().toISOString(),
    status: 'completed',
  };
  return { ...defaultSource, ...overrides };
}

/**
 * Create a mock chunk record
 */
function createMockChunk(sourceId: string, index: number): ChunkRecord {
  return {
    chunk_id: `chunk-${sourceId}-${index}`,
    source_id: sourceId,
    text: `Test chunk content ${index} for source ${sourceId}`,
    position: { index, start_char: 0, end_char: 100 },
    metadata: {},
    created_at: new Date().toISOString(),
  };
}

/**
 * Create a mock vector record
 */
function createMockVector(chunkId: string): VectorRecord {
  return {
    chunk_id: chunkId,
    embedding: Array(1536).fill(0).map(() => Math.random()),
    model: 'openai/text-embedding-3-small',
    created_at: new Date().toISOString(),
  };
}

// ============================================================================
// Part 1: BatchSourceItem Schema Tests
// ============================================================================

describe('BatchSourceItemSchema Validation', () => {
  it('BSM-100: should accept valid batch array with URLs', () => {
    // ADR-005: BatchSourceItemSchema should validate batch items
    const validBatch = [
      { url: 'https://example.com/page1' },
      { url: 'https://example.com/page2' },
      { url: 'https://example.com/page3' },
    ];
    
    const schema = z.array(BatchSourceItemSchema);
    const result = schema.safeParse(validBatch);
    
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(3);
  });

  it('BSM-101: should accept batch items with different source types', () => {
    // ADR-005: Each batch item can be url, sitemap_url, folder_path, or pdf_path
    const mixedBatch = [
      { url: 'https://example.com/page1' },
      { sitemap_url: 'https://example.com/sitemap.xml' },
      { pdf_path: '/path/to/document.pdf' },
    ];
    
    const schema = z.array(BatchSourceItemSchema);
    const result = schema.safeParse(mixedBatch);
    
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(3);
  });

  it('BSM-102: should reject empty batch array', () => {
    // ADR-005: Batch array cannot be empty
    const emptyBatch: unknown[] = [];
    
    const schema = z.array(BatchSourceItemSchema).min(1);
    const result = schema.safeParse(emptyBatch);
    
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('too_small');
    }
  });

  it('BSM-103: should reject batch array exceeding 50 items', () => {
    // ADR-005: Maximum 50 items per batch
    const largeBatch = Array.from({ length: 51 }, (_, i) => ({
      url: `https://example.com/page${i}`,
    }));
    
    const schema = z.array(BatchSourceItemSchema).max(50);
    const result = schema.safeParse(largeBatch);
    
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('too_big');
    }
  });

  it('BSM-104: should accept batch items with optional metadata', () => {
    // ADR-005: Batch items can include optional fields
    const batchWithMetadata = [
      {
        url: 'https://example.com/page1',
        source_name: 'Page 1',
        tags: ['docs', 'api'],
      },
      {
        url: 'https://example.com/page2',
        source_name: 'Page 2',
      },
    ];
    
    const schema = z.array(BatchSourceItemSchema);
    const result = schema.safeParse(batchWithMetadata);
    
    expect(result.success).toBe(true);
  });

  it('BSM-105: should reject batch item with multiple source types', () => {
    // ADR-005: Each batch item must have exactly one source type
    const invalidBatchItem = {
      url: 'https://example.com/page1',
      pdf_path: '/path/to/doc.pdf', // Cannot have both
    };
    
    // This requires custom refinement validation
    const result = BatchSourceItemSchema.safeParse(invalidBatchItem);
    
    expect(result.success).toBe(false);
  });

  it('BSM-106: should reject batch item with no source type', () => {
    // ADR-005: Each batch item must have at least one source type
    const invalidBatchItem = {
      source_name: 'Invalid Source',
      tags: ['test'],
    };
    
    const result = BatchSourceItemSchema.safeParse(invalidBatchItem);
    
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// Part 2: Enhanced ProjectAddSourceSchema with Batch
// ============================================================================

describe('ProjectAddSourceSchema with Batch Support', () => {
  it('BSM-110: should accept batch parameter in ProjectAddSourceSchema', () => {
    // ADR-005: ProjectAddSourceSchema enhanced with batch parameter
    const input = {
      project_id: 'test-project',
      batch: [
        { url: 'https://example.com/page1' },
        { url: 'https://example.com/page2' },
      ],
    };
    
    const result = ProjectAddSourceSchema.safeParse(input);
    
    expect(result.success).toBe(true);
    expect(result.data?.batch).toHaveLength(2);
  });

  it('BSM-111: should enforce mutual exclusivity - single source OR batch', () => {
    // ADR-005: Either single source params OR batch array, not both
    const invalidInput = {
      project_id: 'test-project',
      url: 'https://example.com/single',
      batch: [{ url: 'https://example.com/batch1' }],
    };
    
    // This should fail due to mutual exclusivity refinement
    const result = ProjectAddSourceSchema.safeParse(invalidInput);
    
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/mutual|exclusive|both|either/i);
    }
  });

  it('BSM-112: should allow single source without batch (backward compatibility)', () => {
    // ADR-005: Existing single-source calls continue to work unchanged
    const singleSourceInput = {
      project_id: 'test-project',
      url: 'https://example.com/single',
    };
    
    const result = ProjectAddSourceSchema.safeParse(singleSourceInput);
    
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Part 3: ProjectRemoveSourceSchema Tests
// ============================================================================

describe('ProjectRemoveSourceSchema Validation', () => {
  it('BSM-200: should accept source_id for single removal', () => {
    // ADR-005: Remove by source_id
    const input = {
      project_id: 'test-project',
      source_id: 'abc123def456',
      confirm: true,
    };
    
    const result = ProjectRemoveSourceSchema.safeParse(input);
    
    expect(result.success).toBe(true);
  });

  it('BSM-201: should accept source_uri for single removal', () => {
    // ADR-005: Remove by source_uri
    const input = {
      project_id: 'test-project',
      source_uri: 'https://example.com/page-to-remove',
      confirm: true,
    };
    
    const result = ProjectRemoveSourceSchema.safeParse(input);
    
    expect(result.success).toBe(true);
  });

  it('BSM-202: should accept batch array for multiple removals', () => {
    // ADR-005: Batch removal support
    const input = {
      project_id: 'test-project',
      batch: [
        { source_id: 'source1' },
        { source_id: 'source2' },
        { source_uri: 'https://example.com/page3' },
      ],
      confirm: true,
    };
    
    const result = ProjectRemoveSourceSchema.safeParse(input);
    
    expect(result.success).toBe(true);
  });

  it('BSM-203: should require confirm:true when remove_chunks is true', () => {
    // ADR-005: Confirmation required for cascade deletion
    const input = {
      project_id: 'test-project',
      source_id: 'abc123',
      remove_chunks: true,
      confirm: false, // Should be rejected
    };
    
    const result = ProjectRemoveSourceSchema.safeParse(input);
    
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/confirm|required/i);
    }
  });

  it('BSM-204: should require confirm:true when remove_vectors is true', () => {
    // ADR-005: Confirmation required for cascade deletion
    const input = {
      project_id: 'test-project',
      source_id: 'abc123',
      remove_vectors: true,
      confirm: false, // Should be rejected
    };
    
    const result = ProjectRemoveSourceSchema.safeParse(input);
    
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/confirm|required/i);
    }
  });

  it('BSM-205: should default remove_chunks and remove_vectors to true', () => {
    // ADR-005: Cascade deletion is the default behavior
    const input = {
      project_id: 'test-project',
      source_id: 'abc123',
      confirm: true,
    };
    
    const result = ProjectRemoveSourceSchema.safeParse(input);
    
    expect(result.success).toBe(true);
    expect(result.data?.remove_chunks).toBe(true);
    expect(result.data?.remove_vectors).toBe(true);
  });

  it('BSM-206: should reject batch array exceeding 50 items', () => {
    // ADR-005: Maximum 50 items per batch
    const largeBatch = Array.from({ length: 51 }, (_, i) => ({
      source_id: `source-${i}`,
    }));
    
    const input = {
      project_id: 'test-project',
      batch: largeBatch,
      confirm: true,
    };
    
    const result = ProjectRemoveSourceSchema.safeParse(input);
    
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// Part 4: Batch Add Sources Functionality Tests
// ============================================================================

describe('Batch Add Sources Functionality', () => {
  let tempDir: string;
  
  beforeEach(async () => {
    tempDir = await createTempProjectDir();
    initProjectManager(tempDir);
  });
  
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('BSM-300: should add all sources from valid batch array', async () => {
    // ADR-005: Batch add with 3 valid URLs adds all sources
    const projectId = 'batch-add-test';
    await initTestProject(tempDir, projectId);
    
    const result = await projectAddSource({
      project_id: projectId,
      batch: [
        { url: 'https://example.com/page1' },
        { url: 'https://example.com/page2' },
        { url: 'https://example.com/page3' },
      ],
    });
    
    expect(result.success).toBe(true);
    if ('added' in result) {
      expect(result.added).toHaveLength(3);
      expect(result.skipped).toHaveLength(0);
    }
    
    // Verify sources were added to file
    const projectResult = await projectGet({ project_id: projectId });
    expect(projectResult.success).toBe(true);
    if ('sources' in projectResult) {
      expect(projectResult.sources).toHaveLength(3);
    }
  });

  it('BSM-301: should skip duplicates within same batch', async () => {
    // ADR-005: Batch add skips duplicates within same batch
    const projectId = 'batch-dup-test';
    await initTestProject(tempDir, projectId);
    
    const result = await projectAddSource({
      project_id: projectId,
      batch: [
        { url: 'https://example.com/same-page' },
        { url: 'https://example.com/different-page' },
        { url: 'https://example.com/same-page' }, // Duplicate
      ],
    });
    
    expect(result.success).toBe(true);
    if ('added' in result && 'skipped' in result) {
      expect(result.added).toHaveLength(2);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toBe('duplicate');
    }
  });

  it('BSM-302: should skip duplicates against existing sources', async () => {
    // ADR-005: Batch add skips duplicates against existing sources
    const projectId = 'batch-existing-dup-test';
    const existingSource = createMockSource({
      type: 'url',
      uri: 'https://example.com/existing-page',
    });
    await initTestProject(tempDir, projectId, { sources: [existingSource] });
    
    const result = await projectAddSource({
      project_id: projectId,
      batch: [
        { url: 'https://example.com/existing-page' }, // Already exists
        { url: 'https://example.com/new-page' },
      ],
    });
    
    expect(result.success).toBe(true);
    if ('added' in result && 'skipped' in result) {
      expect(result.added).toHaveLength(1);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].uri).toBe('https://example.com/existing-page');
    }
  });

  it('BSM-303: should handle mixed valid/invalid sources with partial success', async () => {
    // ADR-005: Batch add with mixed valid/invalid returns partial success
    const projectId = 'batch-mixed-test';
    await initTestProject(tempDir, projectId);
    
    // One invalid URL (localhost is blocked by safeUrl)
    const result = await projectAddSource({
      project_id: projectId,
      batch: [
        { url: 'https://example.com/valid' },
        { url: 'http://localhost/invalid' }, // Should be skipped
        { url: 'https://example.org/valid2' },
      ],
    });
    
    expect(result.success).toBe(true);
    if ('added' in result && 'skipped' in result) {
      expect(result.added).toHaveLength(2);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toBe('invalid');
    }
  });

  it('BSM-304: should update manifest sources_count correctly', async () => {
    // ADR-005: Batch add updates manifest sources_count correctly
    const projectId = 'batch-count-test';
    await initTestProject(tempDir, projectId);
    
    await projectAddSource({
      project_id: projectId,
      batch: [
        { url: 'https://example.com/page1' },
        { url: 'https://example.com/page2' },
        { url: 'https://example.com/page3' },
      ],
    });
    
    const projectResult = await projectGet({ project_id: projectId });
    expect(projectResult.success).toBe(true);
    if ('manifest' in projectResult) {
      expect(projectResult.manifest.stats.sources_count).toBe(3);
    }
  });

  it('BSM-305: should return BatchAddResult format', async () => {
    // ADR-005: Response format for batch operations
    const projectId = 'batch-format-test';
    await initTestProject(tempDir, projectId);
    
    const result = await projectAddSource({
      project_id: projectId,
      batch: [
        { url: 'https://example.com/page1', source_name: 'Page 1' },
      ],
    });
    
    expect(result.success).toBe(true);
    
    // Verify BatchAddResult structure
    expect(result).toHaveProperty('added');
    expect(result).toHaveProperty('skipped');
    expect(result).toHaveProperty('message');
    
    if ('added' in result) {
      expect(result.added[0]).toHaveProperty('source_id');
      expect(result.added[0]).toHaveProperty('type');
      expect(result.added[0]).toHaveProperty('uri');
    }
  });
});

// ============================================================================
// Part 5: Remove Source Functionality Tests
// ============================================================================

describe('Remove Source Functionality', () => {
  let tempDir: string;
  
  beforeEach(async () => {
    tempDir = await createTempProjectDir();
    initProjectManager(tempDir);
  });
  
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('BSM-400: should remove source by source_id', async () => {
    // ADR-005: Remove by source_id removes source record
    const projectId = 'remove-by-id-test';
    const sourceToRemove = createMockSource({ source_id: 'remove-me-123' });
    const sourceToKeep = createMockSource({ source_id: 'keep-me-456' });
    await initTestProject(tempDir, projectId, {
      sources: [sourceToRemove, sourceToKeep],
    });
    
    const result = await projectRemoveSource({
      project_id: projectId,
      source_id: 'remove-me-123',
      confirm: true,
    });
    
    expect(result.success).toBe(true);
    if ('removed' in result) {
      expect(result.removed).toHaveLength(1);
      expect(result.removed[0].source_id).toBe('remove-me-123');
    }
    
    // Verify source was removed from file
    const projectResult = await projectGet({ project_id: projectId });
    if ('sources' in projectResult) {
      expect(projectResult.sources).toHaveLength(1);
      expect(projectResult.sources[0].source_id).toBe('keep-me-456');
    }
  });

  it('BSM-401: should remove source by source_uri', async () => {
    // ADR-005: Remove by source_uri removes source record
    const projectId = 'remove-by-uri-test';
    const sourceToRemove = createMockSource({
      uri: 'https://example.com/to-remove',
    });
    await initTestProject(tempDir, projectId, {
      sources: [sourceToRemove],
    });
    
    const result = await projectRemoveSource({
      project_id: projectId,
      source_uri: 'https://example.com/to-remove',
      confirm: true,
    });
    
    expect(result.success).toBe(true);
    if ('removed' in result) {
      expect(result.removed).toHaveLength(1);
    }
  });

  it('BSM-402: should remove associated chunks when cascade enabled', async () => {
    // ADR-005: Remove with cascade=true removes chunks
    const projectId = 'cascade-chunks-test';
    const sourceId = 'source-with-chunks';
    const source = createMockSource({ source_id: sourceId });
    const chunks = [
      createMockChunk(sourceId, 0),
      createMockChunk(sourceId, 1),
      createMockChunk('other-source', 2), // This should remain
    ];
    
    await initTestProject(tempDir, projectId, {
      sources: [source],
      chunks,
    });
    
    const result = await projectRemoveSource({
      project_id: projectId,
      source_id: sourceId,
      remove_chunks: true,
      confirm: true,
    });
    
    expect(result.success).toBe(true);
    if ('removed' in result) {
      expect(result.removed[0].chunks_removed).toBe(2);
    }
    
    // Verify chunks were removed
    const chunksPath = path.join(tempDir, 'projects', projectId, 'data', 'chunks.jsonl');
    const remainingChunks = await readJsonl<ChunkRecord>(chunksPath);
    expect(remainingChunks).toHaveLength(1);
    expect(remainingChunks[0].source_id).toBe('other-source');
  });

  it('BSM-403: should remove associated vectors when cascade enabled', async () => {
    // ADR-005: Remove with cascade=true removes vectors
    const projectId = 'cascade-vectors-test';
    const sourceId = 'source-with-vectors';
    const source = createMockSource({ source_id: sourceId });
    const chunks = [
      createMockChunk(sourceId, 0),
      createMockChunk(sourceId, 1),
    ];
    const vectors = [
      createMockVector(chunks[0].chunk_id),
      createMockVector(chunks[1].chunk_id),
      createMockVector('other-chunk'), // This should remain
    ];
    
    await initTestProject(tempDir, projectId, {
      sources: [source],
      chunks,
      vectors,
    });
    
    const result = await projectRemoveSource({
      project_id: projectId,
      source_id: sourceId,
      remove_vectors: true,
      confirm: true,
    });
    
    expect(result.success).toBe(true);
    if ('removed' in result) {
      expect(result.removed[0].vectors_removed).toBe(2);
    }
    
    // Verify vectors were removed
    const vectorsPath = path.join(tempDir, 'projects', projectId, 'data', 'vectors.jsonl');
    const remainingVectors = await readJsonl<VectorRecord>(vectorsPath);
    expect(remainingVectors).toHaveLength(1);
    expect(remainingVectors[0].chunk_id).toBe('other-chunk');
  });

  it('BSM-404: should update manifest stats after removal', async () => {
    // ADR-005: Remove updates manifest stats
    const projectId = 'manifest-stats-test';
    const sourceId = 'stats-test-source';
    const source = createMockSource({ source_id: sourceId });
    const chunks = [createMockChunk(sourceId, 0), createMockChunk(sourceId, 1)];
    const vectors = [
      createMockVector(chunks[0].chunk_id),
      createMockVector(chunks[1].chunk_id),
    ];
    
    await initTestProject(tempDir, projectId, {
      sources: [source],
      chunks,
      vectors,
    });
    
    await projectRemoveSource({
      project_id: projectId,
      source_id: sourceId,
      confirm: true,
    });
    
    const projectResult = await projectGet({ project_id: projectId });
    if ('manifest' in projectResult) {
      expect(projectResult.manifest.stats.sources_count).toBe(0);
      expect(projectResult.manifest.stats.chunks_count).toBe(0);
      expect(projectResult.manifest.stats.vectors_count).toBe(0);
    }
  });

  it('BSM-405: should return not_found for non-existent source', async () => {
    // ADR-005: Remove non-existent source returns not_found
    const projectId = 'not-found-test';
    await initTestProject(tempDir, projectId);
    
    const result = await projectRemoveSource({
      project_id: projectId,
      source_id: 'non-existent-source',
      confirm: true,
    });
    
    expect(result.success).toBe(true);
    if ('not_found' in result) {
      expect(result.not_found).toContain('non-existent-source');
    }
  });

  it('BSM-406: should remove multiple sources in batch', async () => {
    // ADR-005: Batch remove removes multiple sources
    const projectId = 'batch-remove-test';
    const sources = [
      createMockSource({ source_id: 'batch-1' }),
      createMockSource({ source_id: 'batch-2' }),
      createMockSource({ source_id: 'keep-this' }),
    ];
    
    await initTestProject(tempDir, projectId, { sources });
    
    const result = await projectRemoveSource({
      project_id: projectId,
      batch: [
        { source_id: 'batch-1' },
        { source_id: 'batch-2' },
      ],
      confirm: true,
    });
    
    expect(result.success).toBe(true);
    if ('removed' in result) {
      expect(result.removed).toHaveLength(2);
    }
    
    // Verify only keep-this remains
    const projectResult = await projectGet({ project_id: projectId });
    if ('sources' in projectResult) {
      expect(projectResult.sources).toHaveLength(1);
      expect(projectResult.sources[0].source_id).toBe('keep-this');
    }
  });

  it('BSM-407: should reject removal of source with status="processing"', async () => {
    // ADR-005: Remove source with status="processing" is rejected
    const projectId = 'processing-reject-test';
    const processingSource = createMockSource({
      source_id: 'processing-source',
      status: 'processing',
    });
    
    await initTestProject(tempDir, projectId, { sources: [processingSource] });
    
    const result = await projectRemoveSource({
      project_id: projectId,
      source_id: 'processing-source',
      confirm: true,
    });
    
    // Should fail with appropriate error
    expect(result.success).toBe(false);
    if ('code' in result) {
      expect(result.code).toBe('SOURCE_PROCESSING');
    }
  });

  it('BSM-408: should not remove chunks when remove_chunks=false', async () => {
    // ADR-005: Respects remove_chunks flag
    const projectId = 'no-cascade-chunks-test';
    const sourceId = 'source-keep-chunks';
    const source = createMockSource({ source_id: sourceId });
    const chunks = [createMockChunk(sourceId, 0)];
    
    await initTestProject(tempDir, projectId, {
      sources: [source],
      chunks,
    });
    
    await projectRemoveSource({
      project_id: projectId,
      source_id: sourceId,
      remove_chunks: false,
      confirm: false, // No cascade, no confirm needed
    });
    
    // Chunks should still exist (orphaned)
    const chunksPath = path.join(tempDir, 'projects', projectId, 'data', 'chunks.jsonl');
    const remainingChunks = await readJsonl<ChunkRecord>(chunksPath);
    expect(remainingChunks).toHaveLength(1);
  });

  it('BSM-409: should return RemoveSourceResult format', async () => {
    // ADR-005: Response format for remove operations
    const projectId = 'remove-format-test';
    const source = createMockSource({ source_id: 'format-test' });
    const chunks = [createMockChunk(source.source_id, 0)];
    const vectors = [createMockVector(chunks[0].chunk_id)];
    
    await initTestProject(tempDir, projectId, {
      sources: [source],
      chunks,
      vectors,
    });
    
    const result = await projectRemoveSource({
      project_id: projectId,
      source_id: 'format-test',
      confirm: true,
    });
    
    expect(result.success).toBe(true);
    
    // Verify RemoveSourceResult structure
    expect(result).toHaveProperty('removed');
    expect(result).toHaveProperty('not_found');
    expect(result).toHaveProperty('message');
    
    if ('removed' in result && result.removed.length > 0) {
      expect(result.removed[0]).toHaveProperty('source_id');
      expect(result.removed[0]).toHaveProperty('uri');
      expect(result.removed[0]).toHaveProperty('chunks_removed');
      expect(result.removed[0]).toHaveProperty('vectors_removed');
    }
  });
});

// ============================================================================
// Part 6: Edge Cases and Error Handling
// ============================================================================

describe('Batch Source Management Edge Cases', () => {
  let tempDir: string;
  
  beforeEach(async () => {
    tempDir = await createTempProjectDir();
    initProjectManager(tempDir);
  });
  
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('BSM-500: should fail gracefully when project does not exist', async () => {
    const result = await projectAddSource({
      project_id: 'non-existent-project',
      batch: [{ url: 'https://example.com/page' }],
    });
    
    expect(result.success).toBe(false);
    if ('code' in result) {
      expect(result.code).toBe('NOT_FOUND');
    }
  });

  it('BSM-501: should handle concurrent batch operations safely', async () => {
    // ADR-005: Transaction-like approach - validate all before removing any
    const projectId = 'concurrent-test';
    const sources = Array.from({ length: 5 }, (_, i) =>
      createMockSource({ source_id: `concurrent-${i}` })
    );
    
    await initTestProject(tempDir, projectId, { sources });
    
    // Run two batch operations concurrently
    const [result1, result2] = await Promise.all([
      projectAddSource({
        project_id: projectId,
        batch: [{ url: 'https://example.com/new1' }],
      }),
      projectRemoveSource({
        project_id: projectId,
        source_id: 'concurrent-0',
        confirm: true,
      }),
    ]);
    
    // Both should succeed without data corruption
    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
  });

  it('BSM-502: should handle empty project gracefully for remove', async () => {
    const projectId = 'empty-project-test';
    await initTestProject(tempDir, projectId);
    
    const result = await projectRemoveSource({
      project_id: projectId,
      source_id: 'any-source',
      confirm: true,
    });
    
    // Should succeed but report not_found
    expect(result.success).toBe(true);
    if ('not_found' in result) {
      expect(result.not_found).toContain('any-source');
    }
  });
});
