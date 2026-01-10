# ADR-006: Build Chunking and Large Request Handling

**Status:** ✅ Accepted
**Date:** 2025-12-30
**Author:** Architect Mode
**Depends On:** ADR-005 (Batch Source Management)

## Context

The `project_build` tool processes all pending sources in a single synchronous operation. For projects with many sources or large content volumes, this creates several problems:

### Current Implementation Analysis

**Configuration Constants (lines 67-91):**
```typescript
MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024;     // 200MB per file
MAX_FOLDER_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB per folder file
DEFAULT_TIMEOUT_MS = 30000;                    // 30s HTTP timeout
EMBEDDING_TIMEOUT_MS = 120000;                 // 2 min embedding timeout
MAX_SITEMAP_URLS = 100;                        // Max sitemap URLs
MAX_FOLDER_FILES = 500;                        // Max folder files
RATE_LIMIT_DELAY_MS = 100;                     // Rate limit between API calls
```

**Current Build Flow (lines 480-663):**
1. Load all pending sources
2. **Sequential Processing**: For each source:
   - Fetch content (can take 30s+ per URL)
   - Chunk content (in memory)
   - Generate embeddings (50 chunks per batch, 2 min timeout)
   - Append to data files
3. Update manifest stats
4. Return complete result

### Identified Problems

| Problem | Impact | Current Limit |
|---------|--------|---------------|
| **Sequential Processing** | 100 URLs × 30s = 50 minutes minimum | No parallelization |
| **No Checkpointing** | Failed builds lose all progress | Must restart from scratch |
| **No Streaming** | MCP client waits for entire operation | Request timeouts |
| **Memory Spikes** | All chunks held in memory | 200MB × N sources |
| **No Resume** | Cannot continue interrupted builds | Full rebuild required |
| **Fixed Batch Size** | 50 chunks per embedding call | Cannot tune for latency vs throughput |

### Timeout Scenarios

1. **Sitemap with 100 URLs**: 
   - Fetch: 100 × 30s = 3,000s (50 minutes)
   - Embedding: Variable, but 2 min timeout per batch
   - **Total**: 1+ hour for large sitemaps

2. **Folder with 500 files**:
   - File reads: Generally fast
   - Chunking: ~500 files × 1500 chars = ~750K chars
   - Embedding: 500+ chunks / 50 = 10+ batches × 2 min = 20+ minutes

3. **Large PDF (50MB)**:
   - Download: 30s+
   - PDF parse: 10-60s
   - Chunking: 30K+ chunks possible
   - Embedding: 30K / 50 = 600 batches × 2 min = 20+ hours

## Decision

Implement **chunked build processing** with configurable options for:
1. Source-level batching with checkpointing
2. Configurable concurrency for fetch operations
3. Progressive status updates via MCP
4. Resumable builds from checkpoint
5. Memory-efficient streaming writes
6. Configurable embedding batch sizes

### New Schema: `ProjectBuildInput` Extensions

```typescript
// src/schemas-projects.ts additions
export interface ProjectBuildInput {
  project_id: string;
  dry_run?: boolean;        // Existing
  force?: boolean;          // Existing
  
  // NEW: Chunking Options
  chunk_options?: {
    /**
     * Maximum sources to process per build invocation
     * @default 10
     * @min 1
     * @max 50
     */
    max_sources_per_build?: number;
    
    /**
     * Concurrent fetch operations for URLs/sitemaps
     * @default 3
     * @min 1
     * @max 10
     */
    fetch_concurrency?: number;
    
    /**
     * Chunks per embedding API call
     * Lower = more calls, faster individual responses
     * Higher = fewer calls, better throughput
     * @default 50
     * @min 10
     * @max 100
     */
    embedding_batch_size?: number;
    
    /**
     * Enable checkpoint persistence for resume capability
     * @default true
     */
    enable_checkpointing?: boolean;
    
    /**
     * Maximum time (ms) for entire build operation
     * @default 300000 (5 minutes)
     * @min 60000
     * @max 1800000 (30 minutes)
     */
    build_timeout_ms?: number;
    
    /**
     * Strategy for handling sources that exceed timeout
     * - "skip": Mark as failed, continue with others
     * - "checkpoint": Save progress, require resume
     * - "split": Auto-paginate large sources (sitemaps/folders)
     * @default "checkpoint"
     */
    timeout_strategy?: "skip" | "checkpoint" | "split";
  };
  
  // NEW: Resume Options
  resume_from_checkpoint?: boolean;  // Continue from last checkpoint
  checkpoint_id?: string;            // Specific checkpoint to resume from
}
```

### New Schema: `ProjectBuildResult` Extensions

```typescript
export interface ProjectBuildResult {
  success: true;
  sources_processed: number;
  chunks_added: number;
  vectors_added: number;
  errors: Array<{ source_id: string; error: string }>;
  message: string;
  
  // NEW: Progress Information
  progress: {
    /**
     * Total sources in queue
     */
    total_sources: number;
    
    /**
     * Sources processed this invocation
     */
    processed_this_run: number;
    
    /**
     * Sources remaining (for subsequent calls)
     */
    remaining: number;
    
    /**
     * Whether more sources need processing
     */
    has_more: boolean;
    
    /**
     * Checkpoint ID if checkpointing enabled
     */
    checkpoint_id?: string;
    
    /**
     * Estimated time remaining (ms) based on current rate
     */
    estimated_remaining_ms?: number;
  };
  
  // NEW: Metrics for tuning
  metrics: {
    /**
     * Total build duration (ms)
     */
    duration_ms: number;
    
    /**
     * Time spent fetching content (ms)
     */
    fetch_time_ms: number;
    
    /**
     * Time spent chunking (ms)
     */
    chunk_time_ms: number;
    
    /**
     * Time spent on embeddings (ms)
     */
    embed_time_ms: number;
    
    /**
     * Tokens used for embeddings
     */
    tokens_used: number;
    
    /**
     * Estimated cost ($)
     */
    estimated_cost_usd: number;
    
    /**
     * Average time per source (ms)
     */
    avg_source_time_ms: number;
  };
}
```

### Checkpoint Schema

```typescript
// New type for checkpoint persistence
export interface BuildCheckpoint {
  /**
   * Unique checkpoint identifier
   */
  checkpoint_id: string;
  
  /**
   * Project being built
   */
  project_id: string;
  
  /**
   * When checkpoint was created
   */
  created_at: string;
  
  /**
   * Source IDs that have been fully processed
   */
  completed_source_ids: string[];
  
  /**
   * Source currently being processed (if interrupted)
   */
  in_progress_source?: {
    source_id: string;
    
    /**
     * For sitemaps: URLs already fetched
     */
    urls_completed?: string[];
    
    /**
     * For folders: files already processed
     */
    files_completed?: string[];
    
    /**
     * Chunks created so far (not yet embedded)
     */
    pending_chunks?: number;
  };
  
  /**
   * Cumulative stats from checkpoint
   */
  stats: {
    chunks_added: number;
    vectors_added: number;
    tokens_used: number;
    duration_ms: number;
  };
}
```

### Implementation Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     project_build Tool                          │
├─────────────────────────────────────────────────────────────────┤
│  Input: project_id, chunk_options, resume_from_checkpoint       │
│                                                                 │
│  1. Load/Resume State                                          │
│     ├─ If resume: Load checkpoint from data/checkpoints/       │
│     └─ Else: Initialize fresh build state                      │
│                                                                 │
│  2. Select Source Batch                                        │
│     ├─ Filter pending/failed sources                           │
│     ├─ Exclude completed (from checkpoint)                     │
│     └─ Limit to max_sources_per_build                          │
│                                                                 │
│  3. Process Sources (with timeout tracking)                    │
│     ┌─────────────────────────────────────────┐                │
│     │  For each source in batch:              │                │
│     │    ├─ Check build_timeout_ms           │                │
│     │    ├─ Fetch with fetch_concurrency     │                │
│     │    │    └─ Stream chunks to temp file  │                │
│     │    ├─ Embed with embedding_batch_size  │                │
│     │    │    └─ Append vectors incrementally│                │
│     │    ├─ Update checkpoint                │                │
│     │    └─ On timeout: apply timeout_strategy               │
│     └─────────────────────────────────────────┘                │
│                                                                 │
│  4. Finalize                                                   │
│     ├─ Update manifest stats                                   │
│     ├─ Clean up completed checkpoint (or persist)             │
│     └─ Return result with progress info                       │
│                                                                 │
│  Output: ProjectBuildResult with progress.has_more             │
└─────────────────────────────────────────────────────────────────┘
```

### Concurrent Fetch Implementation

```typescript
// Pseudo-code for concurrent sitemap processing
async function fetchSitemapConcurrent(
  urls: string[],
  concurrency: number,
  onProgress: (url: string, content: string) => void
): Promise<void> {
  const queue = [...urls];
  const active: Promise<void>[] = [];
  
  while (queue.length > 0 || active.length > 0) {
    // Fill up to concurrency limit
    while (active.length < concurrency && queue.length > 0) {
      const url = queue.shift()!;
      const promise = fetchWithTimeout(url)
        .then(content => onProgress(url, content))
        .finally(() => {
          const idx = active.indexOf(promise);
          if (idx >= 0) active.splice(idx, 1);
        });
      active.push(promise);
    }
    
    // Wait for at least one to complete
    if (active.length > 0) {
      await Promise.race(active);
    }
  }
}
```

### Streaming Write Pattern

```typescript
// Instead of accumulating all chunks in memory
async function processSourceStreaming(
  source: SourceRecord,
  paths: ProjectPaths,
  config: ChunkConfig
): Promise<{ chunks: number; vectors: number }> {
  let totalChunks = 0;
  let totalVectors = 0;
  
  // Stream content chunks
  for await (const content of fetchSourceStreaming(source)) {
    const chunks = chunkContent([content], source.source_id, config);
    
    // Immediately write chunks (don't accumulate)
    await appendJsonl(paths.chunks, chunks);
    totalChunks += chunks.length;
    
    // Embed in configurable batches
    const embedResult = await embedChunks(chunks, model);
    await appendJsonl(paths.vectors, embedResult.vectors);
    totalVectors += embedResult.vectors.length;
  }
  
  return { chunks: totalChunks, vectors: totalVectors };
}
```

### File Structure

```
projects/{project_id}/
├── project.json           # Manifest
├── sources.jsonl          # Source records
├── data/
│   ├── chunks.jsonl       # All chunks (append-only)
│   ├── vectors.jsonl      # All vectors (append-only)
│   └── checkpoints/       # NEW: Build checkpoints
│       ├── latest.json    # Most recent checkpoint
│       └── {checkpoint_id}.json
└── logs/                  # NEW: Build logs
    └── build-{timestamp}.jsonl
```

## Usage Examples

### Basic Build (Small Project)

```typescript
// Simple build - all defaults work well for <10 sources
const result = await indexfoundry_project_build({
  project_id: "my-docs"
});
// result.progress.has_more === false (all done)
```

### Large Sitemap Build (Chunked)

```typescript
// First call - processes 10 sources
let result = await indexfoundry_project_build({
  project_id: "large-docs-site",
  chunk_options: {
    max_sources_per_build: 10,
    fetch_concurrency: 5,        // Parallel URL fetches
    embedding_batch_size: 25,    // Smaller batches for faster response
    build_timeout_ms: 120000,    // 2 minute max per call
    timeout_strategy: "checkpoint"
  }
});

// Continue until complete
while (result.progress.has_more) {
  console.log(`Progress: ${result.progress.processed_this_run}/${result.progress.total_sources}`);
  result = await indexfoundry_project_build({
    project_id: "large-docs-site",
    resume_from_checkpoint: true
  });
}
```

### Resume After Failure

```typescript
// Build was interrupted (timeout, error, etc.)
const result = await indexfoundry_project_build({
  project_id: "my-docs",
  resume_from_checkpoint: true  // Picks up where it left off
});

// Or resume from specific checkpoint
const result2 = await indexfoundry_project_build({
  project_id: "my-docs",
  checkpoint_id: "ckpt_abc123"
});
```

### High-Throughput Build (Many Small Sources)

```typescript
// Optimize for throughput with many small files
const result = await indexfoundry_project_build({
  project_id: "code-repo",
  chunk_options: {
    max_sources_per_build: 50,   // Process more per call
    fetch_concurrency: 10,       // High parallelism for local files
    embedding_batch_size: 100,   // Larger batches for efficiency
    build_timeout_ms: 600000,    // 10 minute timeout
    timeout_strategy: "skip"     // Skip slow sources, don't block
  }
});
```

## New Tool: `project_build_status`

For long-running builds, add a status tool:

```typescript
export interface ProjectBuildStatusInput {
  project_id: string;
}

export interface ProjectBuildStatusResult {
  success: true;
  project_id: string;
  
  /**
   * Current build state
   */
  state: "idle" | "in_progress" | "checkpoint_available";
  
  /**
   * Active checkpoint if any
   */
  checkpoint?: {
    checkpoint_id: string;
    created_at: string;
    sources_completed: number;
    sources_remaining: number;
    chunks_so_far: number;
    vectors_so_far: number;
  };
  
  /**
   * Pending sources needing processing
   */
  pending_sources: number;
  
  /**
   * Failed sources needing retry
   */
  failed_sources: number;
  
  /**
   * Recommendation for next action
   */
  recommendation: string;
}
```

## Migration Strategy

### Phase 1: Schema Extension (Non-Breaking)
1. Add optional `chunk_options` to `ProjectBuildInput`
2. Add `progress` and `metrics` to `ProjectBuildResult`
3. All new fields optional with sensible defaults

### Phase 2: Checkpoint System
1. Implement `BuildCheckpoint` persistence
2. Add `data/checkpoints/` directory management
3. Implement resume logic

### Phase 3: Concurrent Fetching
1. Implement parallel fetch for sitemaps
2. Implement parallel fetch for folders
3. Add `fetch_concurrency` configuration

### Phase 4: Streaming Writes
1. Refactor to streaming append pattern
2. Reduce memory footprint
3. Add progress logging

### Phase 5: Build Status Tool
1. Implement `project_build_status`
2. Add build log persistence
3. Add recommendation engine

## Defaults and Safeguards

| Parameter | Default | Min | Max | Rationale |
|-----------|---------|-----|-----|-----------|
| `max_sources_per_build` | 10 | 1 | 50 | Balance progress vs timeout |
| `fetch_concurrency` | 3 | 1 | 10 | Respect rate limits |
| `embedding_batch_size` | 50 | 10 | 100 | API efficiency |
| `build_timeout_ms` | 300000 | 60000 | 1800000 | MCP tool timeout safety |
| `timeout_strategy` | "checkpoint" | - | - | Safe default |

## Alternatives Considered

### Alternative 1: Background Job System
- **Pros**: No timeout issues, true async
- **Cons**: Requires job queue, state persistence, polling mechanism
- **Decision**: Too complex for MCP tool model

### Alternative 2: Webhook-Based Progress
- **Pros**: Real-time updates
- **Cons**: Requires callback URL, network config
- **Decision**: Not compatible with MCP architecture

### Alternative 3: Split into Multiple Tools
- `project_build_prepare`: Analyze and plan
- `project_build_fetch`: Fetch content only
- `project_build_embed`: Generate embeddings
- **Pros**: Fine-grained control
- **Cons**: Complex orchestration, state management between tools
- **Decision**: Checkpoint approach is simpler

## Consequences

### Positive
- Large projects can be built incrementally
- Failures don't lose progress
- Better resource utilization with concurrency
- Predictable response times per call
- Memory-efficient streaming

### Negative
- More complex internal state management
- Checkpoint files consume disk space
- Multiple API calls for large builds
- Need to handle checkpoint cleanup

### Risks
- Checkpoint corruption could block builds
- Concurrent builds on same project could conflict
- Clock skew issues with timeout tracking

### Mitigations
- Checkpoint validation on load
- Acquire project lock during build
- Use monotonic time for timeouts

## Related ADRs

- **ADR-005**: Batch Source Management (prerequisite)
- Future: ADR-007 could cover build parallelization across multiple workers

## References

- OpenAI Embeddings API rate limits
- MCP tool timeout behavior
- Node.js streaming patterns
