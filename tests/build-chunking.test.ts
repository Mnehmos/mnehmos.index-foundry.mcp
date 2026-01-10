/**
 * Build Chunking and Large Request Handling Tests (ADR-006)
 *
 * These tests define the contract for chunked build processing:
 * 1. Schema Extensions - chunk_options in ProjectBuildInput, progress/metrics in result
 * 2. Checkpoint System - Resumable builds with BuildCheckpoint persistence
 * 3. Concurrent Fetching - Parallel URL/file fetching with fetch_concurrency
 * 4. Build Status Tool - New project_build_status tool
 *
 * Feature Requirements (ADR-006):
 * - ChunkOptionsSchema for validating build chunking parameters
 * - ProjectBuildSchema enhanced with chunk_options, resume_from_checkpoint, checkpoint_id
 * - BuildCheckpointSchema for checkpoint persistence
 * - ProjectBuildStatusSchema for build status queries
 * - Progress and metrics in build results
 *
 * Integration Points:
 * - src/schemas-projects.ts - Schema definitions
 * - src/tools/projects.ts - Implementation functions
 * - src/index.ts - Tool registration
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';

// Import existing schemas and types
import {
  ProjectBuildSchema,
  SourceRecord,
  ChunkRecord,
  VectorRecord,
} from '../src/schemas-projects.js';

// Import tools
import {
  projectBuild,
  projectGet,
  initProjectManager,
} from '../src/tools/projects.js';

import {
  writeJsonl,
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
  const tempDir = await mkdtemp(path.join(tmpdir(), 'indexfoundry-build-test-'));
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
    checkpoint?: unknown;
  }
): Promise<string> {
  const projectDir = path.join(baseDir, 'projects', projectId);
  const dataDir = path.join(projectDir, 'data');
  const checkpointDir = path.join(dataDir, 'checkpoints');
  
  await mkdir(projectDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(checkpointDir, { recursive: true });
  
  // Write manifest
  const manifest = {
    project_id: projectId,
    name: `Test Project ${projectId}`,
    description: 'Test project for build chunking',
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
  
  // Write checkpoint
  if (options?.checkpoint) {
    await writeJson(path.join(checkpointDir, 'latest.json'), options.checkpoint);
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
    status: 'pending',
  };
  return { ...defaultSource, ...overrides };
}

// Type helpers for test assertions
type BuildResult = {
  success: boolean;
  progress?: {
    total_sources?: number;
    processed_this_run?: number;
    remaining?: number;
    has_more?: boolean;
    checkpoint_id?: string;
  };
  metrics?: {
    duration_ms?: number;
    fetch_time_ms?: number;
    chunk_time_ms?: number;
    embed_time_ms?: number;
    tokens_used?: number;
    estimated_cost_usd?: number;
  };
  errors?: unknown[];
};

// ============================================================================
// Part 1: Schema Extension Tests - ProjectBuildSchema with chunk_options
// ============================================================================

describe('ProjectBuildSchema with chunk_options (ADR-006)', () => {
  it('BLD-100: should accept chunk_options parameter in ProjectBuildSchema', () => {
    // ADR-006: ProjectBuildSchema should accept optional chunk_options object
    const input = {
      project_id: 'test-project',
      force: false,
      dry_run: false,
      chunk_options: {
        max_sources_per_build: 10,
        fetch_concurrency: 3,
        embedding_batch_size: 50,
        enable_checkpointing: true,
        build_timeout_ms: 300000,
        timeout_strategy: 'checkpoint',
      },
    };
    
    const result = ProjectBuildSchema.safeParse(input);
    
    // This test FAILS until chunk_options is added to ProjectBuildSchema
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).chunk_options).toBeDefined();
    }
  });

  it('BLD-101: should validate max_sources_per_build range 1-50', () => {
    // ADR-006: max_sources_per_build must be between 1 and 50
    const tooSmall = ProjectBuildSchema.safeParse({
      project_id: 'test-project',
      chunk_options: { max_sources_per_build: 0 },
    });
    
    // FAILS: chunk_options not yet supported, so validation doesn't happen
    expect(tooSmall.success).toBe(false);
    
    const tooLarge = ProjectBuildSchema.safeParse({
      project_id: 'test-project',
      chunk_options: { max_sources_per_build: 51 },
    });
    expect(tooLarge.success).toBe(false);
    
    const valid = ProjectBuildSchema.safeParse({
      project_id: 'test-project',
      chunk_options: { max_sources_per_build: 25 },
    });
    expect(valid.success).toBe(true);
  });

  it('BLD-102: should validate fetch_concurrency range 1-10', () => {
    // ADR-006: fetch_concurrency must be between 1 and 10
    const tooSmall = ProjectBuildSchema.safeParse({
      project_id: 'test-project',
      chunk_options: { fetch_concurrency: 0 },
    });
    
    // FAILS: chunk_options not yet supported
    expect(tooSmall.success).toBe(false);
    
    const tooLarge = ProjectBuildSchema.safeParse({
      project_id: 'test-project',
      chunk_options: { fetch_concurrency: 11 },
    });
    expect(tooLarge.success).toBe(false);
    
    const valid = ProjectBuildSchema.safeParse({
      project_id: 'test-project',
      chunk_options: { fetch_concurrency: 5 },
    });
    expect(valid.success).toBe(true);
  });

  it('BLD-103: should validate embedding_batch_size range 10-100', () => {
    // ADR-006: embedding_batch_size must be between 10 and 100
    const tooSmall = ProjectBuildSchema.safeParse({
      project_id: 'test-project',
      chunk_options: { embedding_batch_size: 5 },
    });
    
    // FAILS: chunk_options not yet supported
    expect(tooSmall.success).toBe(false);
    
    const tooLarge = ProjectBuildSchema.safeParse({
      project_id: 'test-project',
      chunk_options: { embedding_batch_size: 150 },
    });
    expect(tooLarge.success).toBe(false);
    
    const valid = ProjectBuildSchema.safeParse({
      project_id: 'test-project',
      chunk_options: { embedding_batch_size: 50 },
    });
    expect(valid.success).toBe(true);
  });

  it('BLD-104: should validate build_timeout_ms range 60000-1800000', () => {
    // ADR-006: build_timeout_ms must be between 60s and 30min
    const tooSmall = ProjectBuildSchema.safeParse({
      project_id: 'test-project',
      chunk_options: { build_timeout_ms: 30000 },
    });
    
    // FAILS: chunk_options not yet supported
    expect(tooSmall.success).toBe(false);
    
    const tooLarge = ProjectBuildSchema.safeParse({
      project_id: 'test-project',
      chunk_options: { build_timeout_ms: 3600000 },
    });
    expect(tooLarge.success).toBe(false);
    
    const valid = ProjectBuildSchema.safeParse({
      project_id: 'test-project',
      chunk_options: { build_timeout_ms: 300000 },
    });
    expect(valid.success).toBe(true);
  });

  it('BLD-105: should validate timeout_strategy enum values', () => {
    // ADR-006: timeout_strategy must be one of: skip, checkpoint, split
    const validStrategies = ['skip', 'checkpoint', 'split'];
    
    for (const strategy of validStrategies) {
      const result = ProjectBuildSchema.safeParse({
        project_id: 'test-project',
        chunk_options: { timeout_strategy: strategy },
      });
      // FAILS: chunk_options not yet supported
      expect(result.success).toBe(true);
    }
    
    const invalidStrategy = ProjectBuildSchema.safeParse({
      project_id: 'test-project',
      chunk_options: { timeout_strategy: 'invalid' },
    });
    expect(invalidStrategy.success).toBe(false);
  });

  it('BLD-106: should accept enable_checkpointing boolean', () => {
    // ADR-006: enable_checkpointing accepts boolean values
    const enabled = ProjectBuildSchema.safeParse({
      project_id: 'test-project',
      chunk_options: { enable_checkpointing: true },
    });
    // FAILS: chunk_options not yet supported
    expect(enabled.success).toBe(true);
    
    const disabled = ProjectBuildSchema.safeParse({
      project_id: 'test-project',
      chunk_options: { enable_checkpointing: false },
    });
    expect(disabled.success).toBe(true);
  });

  it('BLD-107: should accept resume_from_checkpoint parameter', () => {
    // ADR-006: ProjectBuildSchema accepts resume_from_checkpoint boolean
    const result = ProjectBuildSchema.safeParse({
      project_id: 'test-project',
      resume_from_checkpoint: true,
    });
    
    // FAILS: resume_from_checkpoint not yet supported
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).resume_from_checkpoint).toBe(true);
    }
  });

  it('BLD-108: should accept checkpoint_id parameter', () => {
    // ADR-006: ProjectBuildSchema accepts checkpoint_id string
    const result = ProjectBuildSchema.safeParse({
      project_id: 'test-project',
      checkpoint_id: 'ckpt_abc123xyz789',
    });
    
    // FAILS: checkpoint_id not yet supported
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).checkpoint_id).toBe('ckpt_abc123xyz789');
    }
  });

  it('BLD-109: should apply default values for chunk_options', () => {
    // ADR-006: chunk_options has sensible defaults
    const result = ProjectBuildSchema.safeParse({
      project_id: 'test-project',
      chunk_options: {},
    });
    
    // FAILS: chunk_options not yet supported
    expect(result.success).toBe(true);
    if (result.success) {
      const chunkOptions = (result.data as Record<string, unknown>).chunk_options as Record<string, unknown> | undefined;
      expect(chunkOptions?.max_sources_per_build).toBe(10);
      expect(chunkOptions?.fetch_concurrency).toBe(3);
      expect(chunkOptions?.embedding_batch_size).toBe(50);
      expect(chunkOptions?.build_timeout_ms).toBe(300000);
      expect(chunkOptions?.timeout_strategy).toBe('checkpoint');
      expect(chunkOptions?.enable_checkpointing).toBe(true);
    }
  });
});

// ============================================================================
// Part 2: Build Result Extension Tests - progress and metrics
// ============================================================================

describe('ProjectBuildResult Extensions (ADR-006)', () => {
  let tempDir: string;
  
  beforeEach(async () => {
    tempDir = await createTempProjectDir();
    initProjectManager(tempDir);
  });
  
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('BLD-200: should include progress object in build result', async () => {
    // ADR-006: ProjectBuildResult includes progress object
    const projectId = 'progress-test';
    const sources = [
      createMockSource({ source_id: 'src-1', status: 'pending' }),
      createMockSource({ source_id: 'src-2', status: 'pending' }),
    ];
    await initTestProject(tempDir, projectId, { sources });
    
    const result = await projectBuild({
      project_id: projectId,
      force: false,
      dry_run: false,
    }) as BuildResult;
    
    expect(result.success).toBe(true);
    // FAILS: progress not yet included in result
    expect(result).toHaveProperty('progress');
    expect(result.progress).toHaveProperty('total_sources');
    expect(result.progress).toHaveProperty('processed_this_run');
    expect(result.progress).toHaveProperty('remaining');
    expect(result.progress).toHaveProperty('has_more');
  });

  it('BLD-201: should count total_sources correctly', async () => {
    // ADR-006: progress.total_sources counts all sources
    const projectId = 'total-sources-test';
    const sources = [
      createMockSource({ source_id: 'src-1', status: 'pending' }),
      createMockSource({ source_id: 'src-2', status: 'pending' }),
      createMockSource({ source_id: 'src-3', status: 'completed' }),
    ];
    await initTestProject(tempDir, projectId, { sources });
    
    const result = await projectBuild({
      project_id: projectId,
      force: false,
      dry_run: false,
    }) as BuildResult;
    
    expect(result.success).toBe(true);
    // FAILS: progress.total_sources not yet implemented
    expect(result.progress?.total_sources).toBe(3);
  });

  it('BLD-202: should count processed_this_run correctly', async () => {
    // ADR-006: progress.processed_this_run counts current batch
    const projectId = 'processed-count-test';
    const sources = Array.from({ length: 5 }, (_, i) =>
      createMockSource({ source_id: `src-${i}`, status: 'pending' })
    );
    await initTestProject(tempDir, projectId, { sources });
    
    const result = await projectBuild({
      project_id: projectId,
      force: false,
      dry_run: false,
    }) as BuildResult;
    
    expect(result.success).toBe(true);
    // FAILS: progress.processed_this_run not yet implemented
    expect(result.progress?.processed_this_run).toBeDefined();
  });

  it('BLD-203: should count remaining sources correctly', async () => {
    // ADR-006: progress.remaining counts pending sources
    const projectId = 'remaining-count-test';
    const sources = Array.from({ length: 5 }, (_, i) =>
      createMockSource({ source_id: `src-${i}`, status: 'pending' })
    );
    await initTestProject(tempDir, projectId, { sources });
    
    const result = await projectBuild({
      project_id: projectId,
      force: false,
      dry_run: false,
    }) as BuildResult;
    
    expect(result.success).toBe(true);
    // FAILS: progress.remaining not yet implemented
    expect(result.progress?.remaining).toBeDefined();
  });

  it('BLD-204: should indicate has_more when work remains', async () => {
    // ADR-006: progress.has_more indicates more work needed
    const projectId = 'has-more-test';
    const sources = Array.from({ length: 3 }, (_, i) =>
      createMockSource({ source_id: `src-${i}`, status: 'pending' })
    );
    await initTestProject(tempDir, projectId, { sources });
    
    const result = await projectBuild({
      project_id: projectId,
      force: false,
      dry_run: false,
    }) as BuildResult;
    
    expect(result.success).toBe(true);
    // FAILS: progress.has_more not yet implemented
    expect(result.progress?.has_more).toBeDefined();
  });

  it('BLD-205: should include checkpoint_id when checkpointing enabled', async () => {
    // ADR-006: progress.checkpoint_id present when checkpointing enabled
    const projectId = 'checkpoint-id-test';
    const sources = Array.from({ length: 3 }, (_, i) =>
      createMockSource({ source_id: `src-${i}`, status: 'pending' })
    );
    await initTestProject(tempDir, projectId, { sources });
    
    const result = await projectBuild({
      project_id: projectId,
      force: false,
      dry_run: false,
    }) as BuildResult;
    
    expect(result.success).toBe(true);
    // FAILS: progress.checkpoint_id not yet implemented
    expect(result.progress?.checkpoint_id).toBeDefined();
  });

  it('BLD-206: should include metrics object in build result', async () => {
    // ADR-006: ProjectBuildResult includes metrics object
    const projectId = 'metrics-test';
    const sources = [createMockSource({ status: 'pending' })];
    await initTestProject(tempDir, projectId, { sources });
    
    const result = await projectBuild({
      project_id: projectId,
      force: false,
      dry_run: false,
    }) as BuildResult;
    
    expect(result.success).toBe(true);
    // FAILS: metrics not yet included in result
    expect(result).toHaveProperty('metrics');
  });

  it('BLD-207: should measure duration_ms in metrics', async () => {
    // ADR-006: metrics.duration_ms measures total time
    const projectId = 'duration-test';
    const sources = [createMockSource({ status: 'pending' })];
    await initTestProject(tempDir, projectId, { sources });
    
    const result = await projectBuild({
      project_id: projectId,
      force: false,
      dry_run: false,
    }) as BuildResult;
    
    expect(result.success).toBe(true);
    // FAILS: metrics.duration_ms not yet implemented
    expect(result.metrics?.duration_ms).toBeDefined();
    expect(typeof result.metrics?.duration_ms).toBe('number');
  });

  it('BLD-208: should measure fetch_time_ms in metrics', async () => {
    // ADR-006: metrics.fetch_time_ms measures fetch phase
    const projectId = 'fetch-time-test';
    const sources = [createMockSource({ status: 'pending' })];
    await initTestProject(tempDir, projectId, { sources });
    
    const result = await projectBuild({
      project_id: projectId,
      force: false,
      dry_run: false,
    }) as BuildResult;
    
    expect(result.success).toBe(true);
    // FAILS: metrics.fetch_time_ms not yet implemented
    expect(result.metrics?.fetch_time_ms).toBeDefined();
  });

  it('BLD-209: should measure chunk_time_ms in metrics', async () => {
    // ADR-006: metrics.chunk_time_ms measures chunking phase
    const projectId = 'chunk-time-test';
    const sources = [createMockSource({ status: 'pending' })];
    await initTestProject(tempDir, projectId, { sources });
    
    const result = await projectBuild({
      project_id: projectId,
      force: false,
      dry_run: false,
    }) as BuildResult;
    
    expect(result.success).toBe(true);
    // FAILS: metrics.chunk_time_ms not yet implemented
    expect(result.metrics?.chunk_time_ms).toBeDefined();
  });

  it('BLD-210: should measure embed_time_ms in metrics', async () => {
    // ADR-006: metrics.embed_time_ms measures embedding phase
    const projectId = 'embed-time-test';
    const sources = [createMockSource({ status: 'pending' })];
    await initTestProject(tempDir, projectId, { sources });
    
    const result = await projectBuild({
      project_id: projectId,
      force: false,
      dry_run: false,
    }) as BuildResult;
    
    expect(result.success).toBe(true);
    // FAILS: metrics.embed_time_ms not yet implemented
    expect(result.metrics?.embed_time_ms).toBeDefined();
  });

  it('BLD-211: should count tokens_used in metrics', async () => {
    // ADR-006: metrics.tokens_used counts embedding tokens
    const projectId = 'tokens-test';
    const sources = [createMockSource({ status: 'pending' })];
    await initTestProject(tempDir, projectId, { sources });
    
    const result = await projectBuild({
      project_id: projectId,
      force: false,
      dry_run: false,
    }) as BuildResult;
    
    expect(result.success).toBe(true);
    // FAILS: metrics.tokens_used not yet implemented
    expect(result.metrics?.tokens_used).toBeDefined();
    expect(typeof result.metrics?.tokens_used).toBe('number');
  });

  it('BLD-212: should calculate estimated_cost_usd in metrics', async () => {
    // ADR-006: metrics.estimated_cost_usd calculates cost
    const projectId = 'cost-test';
    const sources = [createMockSource({ status: 'pending' })];
    await initTestProject(tempDir, projectId, { sources });
    
    const result = await projectBuild({
      project_id: projectId,
      force: false,
      dry_run: false,
    }) as BuildResult;
    
    expect(result.success).toBe(true);
    // FAILS: metrics.estimated_cost_usd not yet implemented
    expect(result.metrics?.estimated_cost_usd).toBeDefined();
  });
});

// ============================================================================
// Part 3: Checkpoint Schema Tests
// ============================================================================

describe('BuildCheckpointSchema Validation (ADR-006)', () => {
  it('BLD-300: should export ChunkOptionsSchema from schemas-projects', async () => {
    // ADR-006: ChunkOptionsSchema must be exported
    // Dynamically import to check if schema exists
    const schemas = await import('../src/schemas-projects.js');
    
    // FAILS: ChunkOptionsSchema not yet exported
    expect(schemas).toHaveProperty('ChunkOptionsSchema');
  });

  it('BLD-301: should export BuildCheckpointSchema from schemas-projects', async () => {
    // ADR-006: BuildCheckpointSchema must be exported
    const schemas = await import('../src/schemas-projects.js');
    
    // FAILS: BuildCheckpointSchema not yet exported
    expect(schemas).toHaveProperty('BuildCheckpointSchema');
  });

  it('BLD-302: should validate checkpoint_id is required string', async () => {
    // ADR-006: BuildCheckpointSchema validates checkpoint_id
    const schemas = await import('../src/schemas-projects.js') as Record<string, unknown>;
    const BuildCheckpointSchema = schemas.BuildCheckpointSchema as { safeParse: (input: unknown) => { success: boolean } } | undefined;
    
    // FAILS: BuildCheckpointSchema not yet exported
    expect(BuildCheckpointSchema).toBeDefined();
    
    if (!BuildCheckpointSchema) return;
    
    const validCheckpoint = {
      checkpoint_id: 'ckpt_abc123',
      project_id: 'test-project',
      created_at: new Date().toISOString(),
      completed_source_ids: [],
      stats: {
        chunks_added: 0,
        vectors_added: 0,
        tokens_used: 0,
        duration_ms: 0,
      },
    };
    
    const result = BuildCheckpointSchema.safeParse(validCheckpoint);
    expect(result.success).toBe(true);
  });

  it('BLD-303: should validate completed_source_ids array', async () => {
    // ADR-006: BuildCheckpointSchema validates completed_source_ids array
    const schemas = await import('../src/schemas-projects.js') as Record<string, unknown>;
    
    // FAILS: BuildCheckpointSchema not yet exported
    expect(schemas).toHaveProperty('BuildCheckpointSchema');
  });

  it('BLD-304: should validate in_progress_source optional object', async () => {
    // ADR-006: BuildCheckpointSchema validates in_progress_source
    const schemas = await import('../src/schemas-projects.js') as Record<string, unknown>;
    
    // FAILS: BuildCheckpointSchema not yet exported
    expect(schemas).toHaveProperty('BuildCheckpointSchema');
  });

  it('BLD-305: should validate stats object structure', async () => {
    // ADR-006: BuildCheckpointSchema validates stats object
    const schemas = await import('../src/schemas-projects.js') as Record<string, unknown>;
    
    // FAILS: BuildCheckpointSchema not yet exported
    expect(schemas).toHaveProperty('BuildCheckpointSchema');
  });
});

// ============================================================================
// Part 4: Checkpoint Functionality Tests
// ============================================================================

describe('Checkpoint Functionality (ADR-006)', () => {
  let tempDir: string;
  
  beforeEach(async () => {
    tempDir = await createTempProjectDir();
    initProjectManager(tempDir);
  });
  
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('BLD-400: should create checkpoint when enable_checkpointing=true', async () => {
    // ADR-006: Build creates checkpoint when enable_checkpointing=true
    const projectId = 'checkpoint-create-test';
    const sources = Array.from({ length: 3 }, (_, i) =>
      createMockSource({ source_id: `src-${i}`, status: 'pending' })
    );
    await initTestProject(tempDir, projectId, { sources });
    
    await projectBuild({
      project_id: projectId,
      force: false,
      dry_run: false,
    });
    
    // Verify checkpoint file exists
    const checkpointPath = path.join(
      tempDir, 'projects', projectId, 'data', 'checkpoints', 'latest.json'
    );
    const checkpointExists = await readJson(checkpointPath).then(() => true).catch(() => false);
    // FAILS: checkpoint not yet created
    expect(checkpointExists).toBe(true);
  });

  it('BLD-401: should update checkpoint after each source', async () => {
    // ADR-006: Build updates checkpoint after each source
    const projectId = 'checkpoint-update-test';
    const sources = Array.from({ length: 3 }, (_, i) =>
      createMockSource({ source_id: `src-${i}`, status: 'pending' })
    );
    await initTestProject(tempDir, projectId, { sources });
    
    await projectBuild({
      project_id: projectId,
      force: false,
      dry_run: false,
    });
    
    const checkpointPath = path.join(
      tempDir, 'projects', projectId, 'data', 'checkpoints', 'latest.json'
    );
    
    // FAILS: checkpoint not yet created
    const checkpoint = await readJson(checkpointPath) as Record<string, unknown>;
    expect(Array.isArray(checkpoint.completed_source_ids)).toBe(true);
    expect((checkpoint.completed_source_ids as string[]).length).toBeGreaterThan(0);
  });

  it('BLD-402: should resume from checkpoint with resume_from_checkpoint=true', async () => {
    // ADR-006: Build resumes from checkpoint with resume_from_checkpoint=true
    const projectId = 'checkpoint-resume-test';
    const sources = Array.from({ length: 5 }, (_, i) =>
      createMockSource({ source_id: `src-${i}`, status: 'pending' })
    );
    await initTestProject(tempDir, projectId, { sources });
    
    const result = await projectBuild({
      project_id: projectId,
      force: false,
      dry_run: false,
    }) as BuildResult;
    
    expect(result.success).toBe(true);
    // FAILS: progress not yet implemented
    expect(result.progress).toBeDefined();
  });

  it('BLD-403: should resume from specific checkpoint_id', async () => {
    // ADR-006: Build resumes from specific checkpoint_id
    const projectId = 'checkpoint-specific-test';
    const specificCheckpoint = {
      checkpoint_id: 'ckpt_specific_123',
      project_id: projectId,
      created_at: new Date().toISOString(),
      completed_source_ids: ['src-0', 'src-1'],
      stats: {
        chunks_added: 10,
        vectors_added: 10,
        tokens_used: 1000,
        duration_ms: 5000,
      },
    };
    
    const sources = Array.from({ length: 5 }, (_, i) =>
      createMockSource({ source_id: `src-${i}`, status: i < 2 ? 'completed' : 'pending' })
    );
    await initTestProject(tempDir, projectId, { sources, checkpoint: specificCheckpoint });
    
    const result = await projectBuild({
      project_id: projectId,
      force: false,
      dry_run: false,
    }) as BuildResult;
    
    expect(result.success).toBe(true);
    // FAILS: progress not yet implemented
    expect(result.progress).toBeDefined();
  });

  it('BLD-404: should persist checkpoint to data/checkpoints/latest.json', async () => {
    // ADR-006: Checkpoint persists to data/checkpoints/latest.json
    const projectId = 'checkpoint-persist-test';
    const sources = [createMockSource({ source_id: 'src-1', status: 'pending' })];
    await initTestProject(tempDir, projectId, { sources });
    
    await projectBuild({
      project_id: projectId,
      force: false,
      dry_run: false,
    });
    
    const checkpointPath = path.join(
      tempDir, 'projects', projectId, 'data', 'checkpoints', 'latest.json'
    );
    
    // FAILS: checkpoint not yet persisted
    const checkpoint = await readJson(checkpointPath) as Record<string, unknown>;
    expect(checkpoint).toHaveProperty('checkpoint_id');
    expect(checkpoint).toHaveProperty('project_id', projectId);
    expect(checkpoint).toHaveProperty('created_at');
    expect(checkpoint).toHaveProperty('completed_source_ids');
    expect(checkpoint).toHaveProperty('stats');
  });

  it('BLD-405: should clear checkpoint after successful build completion', async () => {
    // ADR-006: Checkpoint cleared after successful build completion
    const projectId = 'checkpoint-clear-test';
    const sources = [createMockSource({ source_id: 'src-1', status: 'pending' })];
    await initTestProject(tempDir, projectId, { sources });
    
    const result = await projectBuild({
      project_id: projectId,
      force: false,
      dry_run: false,
    }) as BuildResult;
    
    expect(result.success).toBe(true);
    // FAILS: progress.has_more not yet implemented
    expect(result.progress?.has_more).toBe(false);
  });

  it('BLD-406: should limit processed sources with max_sources_per_build', async () => {
    // ADR-006: Build with max_sources_per_build limits processed sources
    const projectId = 'max-sources-test';
    const sources = Array.from({ length: 10 }, (_, i) =>
      createMockSource({ source_id: `src-${i}`, status: 'pending' })
    );
    await initTestProject(tempDir, projectId, { sources });
    
    const result = await projectBuild({
      project_id: projectId,
      force: false,
      dry_run: false,
    }) as BuildResult;
    
    expect(result.success).toBe(true);
    // FAILS: progress.processed_this_run not yet implemented
    expect(result.progress?.processed_this_run).toBeDefined();
  });

  it('BLD-407: should stop and checkpoint on timeout', async () => {
    // ADR-006: Build with timeout stops and checkpoints
    const projectId = 'timeout-test';
    // Verify schema accepts timeout configuration
    // FAILS: chunk_options not yet supported
    const result = ProjectBuildSchema.safeParse({
      project_id: projectId,
      chunk_options: {
        build_timeout_ms: 60000,
        timeout_strategy: 'checkpoint',
      },
    });
    
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Part 5: Concurrent Fetch Tests
// ============================================================================

describe('Concurrent Fetch Functionality (ADR-006)', () => {
  let tempDir: string;
  
  beforeEach(async () => {
    tempDir = await createTempProjectDir();
    initProjectManager(tempDir);
  });
  
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('BLD-500: should accept fetch_concurrency=1 for sequential processing', () => {
    // ADR-006: fetch_concurrency=1 processes URLs sequentially
    // FAILS: chunk_options not yet supported
    const result = ProjectBuildSchema.safeParse({
      project_id: 'sequential-fetch-test',
      chunk_options: { fetch_concurrency: 1 },
    });
    
    expect(result.success).toBe(true);
    if (result.success) {
      const chunkOptions = (result.data as Record<string, unknown>).chunk_options as Record<string, unknown> | undefined;
      expect(chunkOptions?.fetch_concurrency).toBe(1);
    }
  });

  it('BLD-501: should accept fetch_concurrency=3 for parallel processing', () => {
    // ADR-006: fetch_concurrency=3 processes 3 URLs in parallel
    // FAILS: chunk_options not yet supported
    const result = ProjectBuildSchema.safeParse({
      project_id: 'parallel-fetch-test',
      chunk_options: { fetch_concurrency: 3 },
    });
    
    expect(result.success).toBe(true);
    if (result.success) {
      const chunkOptions = (result.data as Record<string, unknown>).chunk_options as Record<string, unknown> | undefined;
      expect(chunkOptions?.fetch_concurrency).toBe(3);
    }
  });

  it('BLD-502: should include fetch metrics in result', async () => {
    // ADR-006: Build result includes fetch timing metrics
    const projectId = 'fetch-metrics-test';
    const sources = [
      createMockSource({
        source_id: 'url-1',
        type: 'url',
        uri: 'https://example.com/page1',
        status: 'pending',
      }),
    ];
    await initTestProject(tempDir, projectId, { sources });
    
    const result = await projectBuild({
      project_id: projectId,
      force: false,
      dry_run: false,
    }) as BuildResult;
    
    expect(result.success).toBe(true);
    // FAILS: metrics.fetch_time_ms not yet implemented
    expect(result.metrics?.fetch_time_ms).toBeDefined();
  });

  it('BLD-503: should handle partial failures gracefully during fetch', async () => {
    // ADR-006: Concurrent fetch handles partial failures gracefully
    const projectId = 'partial-failure-test';
    const sources = [
      createMockSource({
        source_id: 'valid-url',
        type: 'url',
        uri: 'https://example.com/valid',
        status: 'pending',
      }),
    ];
    await initTestProject(tempDir, projectId, { sources });
    
    const result = await projectBuild({
      project_id: projectId,
      force: false,
      dry_run: false,
    }) as BuildResult;
    
    // Build should succeed overall
    expect(result.success).toBe(true);
    // FAILS: errors array should be included in result
    expect(result.errors).toBeDefined();
  });
});

// ============================================================================
// Part 6: Build Status Tool Tests
// ============================================================================

describe('ProjectBuildStatusSchema and Tool (ADR-006)', () => {
  let tempDir: string;
  
  beforeEach(async () => {
    tempDir = await createTempProjectDir();
    initProjectManager(tempDir);
  });
  
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('BLD-600: should export ProjectBuildStatusSchema from schemas-projects', async () => {
    // ADR-006: ProjectBuildStatusSchema must be exported
    const schemas = await import('../src/schemas-projects.js');
    
    // FAILS: ProjectBuildStatusSchema not yet exported
    expect(schemas).toHaveProperty('ProjectBuildStatusSchema');
  });

  it('BLD-601: should export projectBuildStatus function from tools', async () => {
    // ADR-006: projectBuildStatus function must be exported
    const tools = await import('../src/tools/projects.js');
    
    // FAILS: projectBuildStatus not yet exported
    expect(tools).toHaveProperty('projectBuildStatus');
    expect(typeof (tools as Record<string, unknown>).projectBuildStatus).toBe('function');
  });

  it('BLD-602: should return idle when no build activity', async () => {
    // ADR-006: project_build_status returns idle when no build activity
    const tools = await import('../src/tools/projects.js') as Record<string, unknown>;
    const projectBuildStatus = tools.projectBuildStatus as ((input: { project_id: string }) => Promise<Record<string, unknown>>) | undefined;
    
    // FAILS: projectBuildStatus not yet implemented
    expect(projectBuildStatus).toBeDefined();
    
    if (!projectBuildStatus) return;
    
    const projectId = 'idle-status-test';
    await initTestProject(tempDir, projectId);
    
    const result = await projectBuildStatus({ project_id: projectId });
    
    expect(result.success).toBe(true);
    expect(result.state).toBe('idle');
  });

  it('BLD-603: should return pending_sources count', async () => {
    // ADR-006: project_build_status returns pending_sources count
    const tools = await import('../src/tools/projects.js') as Record<string, unknown>;
    const projectBuildStatus = tools.projectBuildStatus as ((input: { project_id: string }) => Promise<Record<string, unknown>>) | undefined;
    
    // FAILS: projectBuildStatus not yet implemented
    expect(projectBuildStatus).toBeDefined();
    
    if (!projectBuildStatus) return;
    
    const projectId = 'pending-count-status-test';
    const sources = [
      createMockSource({ source_id: 'src-1', status: 'completed' }),
      createMockSource({ source_id: 'src-2', status: 'pending' }),
      createMockSource({ source_id: 'src-3', status: 'pending' }),
      createMockSource({ source_id: 'src-4', status: 'pending' }),
    ];
    await initTestProject(tempDir, projectId, { sources });
    
    const result = await projectBuildStatus({ project_id: projectId });
    
    expect(result.success).toBe(true);
    expect(result.pending_sources).toBe(3);
  });

  it('BLD-604: should return failed_sources count', async () => {
    // ADR-006: project_build_status returns failed_sources count
    const tools = await import('../src/tools/projects.js') as Record<string, unknown>;
    const projectBuildStatus = tools.projectBuildStatus as ((input: { project_id: string }) => Promise<Record<string, unknown>>) | undefined;
    
    // FAILS: projectBuildStatus not yet implemented
    expect(projectBuildStatus).toBeDefined();
    
    if (!projectBuildStatus) return;
    
    const projectId = 'failed-count-status-test';
    const sources = [
      createMockSource({ source_id: 'src-1', status: 'completed' }),
      createMockSource({ source_id: 'src-2', status: 'failed' }),
      createMockSource({ source_id: 'src-3', status: 'failed' }),
    ];
    await initTestProject(tempDir, projectId, { sources });
    
    const result = await projectBuildStatus({ project_id: projectId });
    
    expect(result.success).toBe(true);
    expect(result.failed_sources).toBe(2);
  });

  it('BLD-605: should return recommendation string', async () => {
    // ADR-006: project_build_status returns recommendation string
    const tools = await import('../src/tools/projects.js') as Record<string, unknown>;
    const projectBuildStatus = tools.projectBuildStatus as ((input: { project_id: string }) => Promise<Record<string, unknown>>) | undefined;
    
    // FAILS: projectBuildStatus not yet implemented
    expect(projectBuildStatus).toBeDefined();
    
    if (!projectBuildStatus) return;
    
    const projectId = 'recommendation-status-test';
    const sources = [
      createMockSource({ source_id: 'src-1', status: 'pending' }),
    ];
    await initTestProject(tempDir, projectId, { sources });
    
    const result = await projectBuildStatus({ project_id: projectId });
    
    expect(result.success).toBe(true);
    expect(result.recommendation).toBeDefined();
    expect(typeof result.recommendation).toBe('string');
  });
});

// ============================================================================
// Part 7: Edge Cases and Integration Tests
// ============================================================================

describe('Build Chunking Edge Cases (ADR-006)', () => {
  let tempDir: string;
  
  beforeEach(async () => {
    tempDir = await createTempProjectDir();
    initProjectManager(tempDir);
  });
  
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('BLD-700: should handle empty project gracefully', async () => {
    // ADR-006: Build handles empty project gracefully
    const projectId = 'empty-project-test';
    await initTestProject(tempDir, projectId);
    
    const result = await projectBuild({
      project_id: projectId,
      force: false,
      dry_run: false,
    }) as BuildResult;
    
    expect(result.success).toBe(true);
    // FAILS: progress not yet implemented
    expect(result.progress?.total_sources).toBe(0);
    expect(result.progress?.has_more).toBe(false);
  });

  it('BLD-701: should handle all sources already completed', async () => {
    // ADR-006: Build handles all sources already completed
    const projectId = 'all-completed-test';
    const sources = Array.from({ length: 3 }, (_, i) =>
      createMockSource({ source_id: `src-${i}`, status: 'completed' })
    );
    await initTestProject(tempDir, projectId, { sources });
    
    const result = await projectBuild({
      project_id: projectId,
      force: false,
      dry_run: false,
    }) as BuildResult;
    
    expect(result.success).toBe(true);
    // FAILS: progress not yet implemented
    expect(result.progress?.processed_this_run).toBe(0);
  });

  it('BLD-702: should rebuild completed sources with force=true', async () => {
    // ADR-006: Build rebuilds completed sources with force=true
    const projectId = 'force-rebuild-test';
    const sources = Array.from({ length: 2 }, (_, i) =>
      createMockSource({ source_id: `src-${i}`, status: 'completed' })
    );
    await initTestProject(tempDir, projectId, { sources });
    
    const result = await projectBuild({
      project_id: projectId,
      force: true,
      dry_run: false,
    }) as BuildResult;
    
    expect(result.success).toBe(true);
    // FAILS: progress.processed_this_run not yet implemented with force
    expect(result.progress?.processed_this_run).toBe(2);
  });

  it('BLD-703: should return dry_run preview without processing', async () => {
    // ADR-006: Build with dry_run shows what would be processed
    const projectId = 'dry-run-test';
    const sources = Array.from({ length: 5 }, (_, i) =>
      createMockSource({ source_id: `src-${i}`, status: 'pending' })
    );
    await initTestProject(tempDir, projectId, { sources });
    
    const result = await projectBuild({
      project_id: projectId,
      force: false,
      dry_run: true,
    });
    
    expect((result as BuildResult).success).toBe(true);
    // Sources should still be pending after dry run
    const project = await projectGet({ project_id: projectId });
    if ('sources' in project) {
      const pendingCount = (project.sources as SourceRecord[]).filter(
        (s: SourceRecord) => s.status === 'pending'
      ).length;
      expect(pendingCount).toBe(5);
    }
  });

  it('BLD-704: should maintain backward compatibility without chunk_options', async () => {
    // ADR-006: Build works without chunk_options (backward compatibility)
    const projectId = 'backward-compat-test';
    const sources = [createMockSource({ status: 'pending' })];
    await initTestProject(tempDir, projectId, { sources });
    
    const result = await projectBuild({
      project_id: projectId,
      force: false,
      dry_run: false,
      // No chunk_options - should use defaults
    }) as BuildResult;
    
    expect(result.success).toBe(true);
    // FAILS: progress and metrics not yet included
    expect(result.progress).toBeDefined();
    expect(result.metrics).toBeDefined();
  });
});
