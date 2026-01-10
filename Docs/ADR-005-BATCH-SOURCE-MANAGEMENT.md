# ADR-005: Batch Source Management for IndexFoundry Projects

**Status:** ✅ Accepted
**Date:** 2025-12-30
**Author:** Architect Mode

---

## Context

The IndexFoundry project system currently supports adding sources one at a time via `indexfoundry_project_add_source`. This creates friction when users need to:

1. **Bulk import content** - Adding multiple URLs, PDFs, or folders requires multiple sequential tool calls
2. **Remove sources** - No mechanism exists to remove sources once added, even if they were added in error or are no longer needed

### Current State Analysis

#### Source Storage Format
Sources are stored in `sources.jsonl` with the following structure ([`src/schemas-projects.ts:260-275`](src/schemas-projects.ts:260)):

```typescript
interface SourceRecord {
  source_id: string;      // SHA256 hash of `${type}:${uri}`, first 16 chars
  type: "url" | "sitemap" | "folder" | "pdf" | "text";
  uri: string;
  source_name?: string;
  tags: string[];
  added_at: string;
  processed_at?: string;
  status: "pending" | "processing" | "completed" | "failed";
  error?: string;
  stats?: {
    files_fetched: number;
    chunks_created: number;
    vectors_created: number;
  };
}
```

#### Related Data
When sources are processed by `project_build`:
- **Chunks** are created in `data/chunks.jsonl` with `source_id` reference
- **Vectors** are created in `data/vectors.jsonl` with `chunk_id` reference

#### Current Add Source Flow ([`src/tools/projects.ts:391-465`](src/tools/projects.ts:391))
1. Validate project exists
2. Determine source type (url/sitemap/folder/pdf)
3. Check for duplicates (same type + uri)
4. Generate source_id from hash
5. Append to `sources.jsonl`
6. Update manifest `sources_count`

---

## Decision

### Enhancement 1: Batch Add Sources

Add a `batch` parameter to `indexfoundry_project_add_source` following the established pattern in other MCP tools (e.g., chatrpg batch operations).

#### Schema Design

```typescript
// Single source input (existing, unchanged)
interface SingleSourceInput {
  project_id: string;
  url?: string;
  sitemap_url?: string;
  folder_path?: string;
  pdf_path?: string;
  glob?: string;
  include_patterns?: string[];
  exclude_patterns?: string[];
  max_pages?: number;
  source_name?: string;
  tags?: string[];
}

// New batch array item
interface BatchSourceItem {
  url?: string;
  sitemap_url?: string;
  folder_path?: string;
  pdf_path?: string;
  glob?: string;
  include_patterns?: string[];
  exclude_patterns?: string[];
  max_pages?: number;
  source_name?: string;
  tags?: string[];
}

// Enhanced schema
const ProjectAddSourceSchema = z.object({
  project_id: safeProjectId,
  
  // Single source (existing - all optional now)
  url: safeUrl.optional(),
  sitemap_url: safeUrl.optional(),
  folder_path: safeFilePath.optional(),
  pdf_path: z.string().min(1).max(4096).optional(),
  glob: safeGlob,
  include_patterns: z.array(z.string().max(256)).max(50).optional(),
  exclude_patterns: z.array(z.string().max(256)).max(50).optional(),
  max_pages: z.number().int().min(1).max(500).default(100),
  source_name: z.string().max(256).optional(),
  tags: z.array(safeTag).max(20).default([]),
  
  // NEW: Batch array (mutually exclusive with single source params)
  batch: z.array(z.object({
    url: safeUrl.optional(),
    sitemap_url: safeUrl.optional(),
    folder_path: safeFilePath.optional(),
    pdf_path: z.string().min(1).max(4096).optional(),
    glob: safeGlob.optional(),
    include_patterns: z.array(z.string().max(256)).max(50).optional(),
    exclude_patterns: z.array(z.string().max(256)).max(50).optional(),
    max_pages: z.number().int().min(1).max(500).optional(),
    source_name: z.string().max(256).optional(),
    tags: z.array(safeTag).max(20).optional(),
  })).max(50).optional(),  // Max 50 sources per batch
});
```

#### Validation Rules
1. Either single source params OR `batch` array, not both
2. Each batch item must have exactly one of: url, sitemap_url, folder_path, pdf_path
3. Maximum 50 items per batch (prevents abuse)
4. Duplicate URIs within the same batch are rejected

#### Response Format

```typescript
interface BatchAddResult {
  success: true;
  project_id: string;
  added: Array<{
    source_id: string;
    type: string;
    uri: string;
  }>;
  skipped: Array<{
    uri: string;
    reason: string;  // "duplicate" | "invalid"
  }>;
  message: string;
}
```

---

### Enhancement 2: Remove Source Tool

Create new `indexfoundry_project_remove_source` tool for removing sources from projects.

#### Schema Design

```typescript
const ProjectRemoveSourceSchema = z.object({
  project_id: safeProjectId,
  
  // Single source removal (by ID or URI)
  source_id: z.string().max(64).optional(),
  source_uri: z.string().max(4096).optional(),
  
  // NEW: Batch removal
  batch: z.array(z.object({
    source_id: z.string().max(64).optional(),
    source_uri: z.string().max(4096).optional(),
  })).max(50).optional(),
  
  // Cascade options
  remove_chunks: z.boolean().default(true)
    .describe("Also remove associated chunks from data/chunks.jsonl"),
  remove_vectors: z.boolean().default(true)
    .describe("Also remove associated vectors from data/vectors.jsonl"),
  
  // Safety
  confirm: z.boolean().default(false)
    .describe("Required when remove_chunks or remove_vectors is true"),
});
```

#### Validation Rules
1. Either single source params (source_id OR source_uri) OR `batch` array
2. Each batch item must have exactly one of: source_id, source_uri
3. `confirm: true` required when cascade deletion is enabled
4. Maximum 50 items per batch

#### Cascade Deletion Logic

```
Source Removal Flow:
┌─────────────────────────────────────────────────────────────┐
│ 1. Validate project exists                                  │
│ 2. Find source(s) by source_id or URI match                │
│ 3. If remove_chunks=true:                                   │
│    a. Read chunks.jsonl                                     │
│    b. Filter out chunks where source_id matches            │
│    c. If remove_vectors=true:                              │
│       i. Read vectors.jsonl                                │
│       ii. Filter out vectors where chunk_id is in removed │
│       iii. Write filtered vectors.jsonl                   │
│    d. Write filtered chunks.jsonl                         │
│ 4. Read sources.jsonl                                      │
│ 5. Filter out matched sources                              │
│ 6. Write filtered sources.jsonl                           │
│ 7. Update manifest stats (recalculate counts)             │
└─────────────────────────────────────────────────────────────┘
```

#### Response Format

```typescript
interface RemoveSourceResult {
  success: true;
  project_id: string;
  removed: Array<{
    source_id: string;
    uri: string;
    chunks_removed: number;
    vectors_removed: number;
  }>;
  not_found: string[];  // source_ids or URIs that weren't found
  message: string;
}
```

---

### Tool Description Updates

#### `indexfoundry_project_add_source` (Enhanced)

```
📥 [STEP 2/5: ADD] Add data source(s) to a project.

PREREQUISITES: project_create must have been run first

SOURCE TYPES (use exactly one per source):
- url: Single webpage (HTML content extracted)
- sitemap_url: Crawl all pages in sitemap.xml
- folder_path: Local folder with text/markdown/PDF files
- pdf_path: Single PDF file (local path or URL)

MODES:
- Single: Provide one source directly in parameters
- Batch: Use `batch` array for multiple sources at once (max 50)

WHAT THIS DOES:
- Validates source(s) are accessible
- Creates source record(s) in sources.jsonl
- Queues source(s) for processing by project_build

NEXT STEPS:
- Add more sources with additional calls to project_add_source
- Run project_build when all sources are added
```

#### `indexfoundry_project_remove_source` (New)

```
🗑️ Remove source(s) from a project.

PREREQUISITES: Project must exist

MODES:
- Single: Provide source_id OR source_uri
- Batch: Use `batch` array for multiple removals (max 50)

CASCADE OPTIONS:
- remove_chunks: Also delete chunks from data/chunks.jsonl (default: true)
- remove_vectors: Also delete vectors from data/vectors.jsonl (default: true)

SAFETY:
- Set confirm: true when cascade options are enabled
- Without confirm, only removes source records (orphans chunks/vectors)

WHAT THIS DOES:
1. Removes source record(s) from sources.jsonl
2. If cascade enabled: removes associated chunks and vectors
3. Updates manifest stats

USE CASES:
- Remove accidentally added source
- Clean up failed/invalid sources
- Remove outdated content before rebuild
```

---

## Consequences

### Positive

1. **Efficiency** - Batch operations reduce API calls from N to 1
2. **Atomicity** - All sources in a batch succeed or fail together (for validation)
3. **Cleanup Capability** - Users can remove sources without recreating projects
4. **Data Consistency** - Cascade deletion prevents orphaned chunks/vectors
5. **Safety** - Confirmation requirement prevents accidental data loss

### Negative

1. **Complexity** - Batch logic adds code complexity
2. **File Rewrite** - Removing sources requires rewriting JSONL files (O(n) operation)
3. **Memory Usage** - Batch operations hold more data in memory
4. **Breaking Change Risk** - Schema changes could affect existing integrations (mitigated by backward compatibility)

### Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Large batch overwhelms system | Max 50 items per batch limit |
| Accidental cascade deletion | `confirm: true` required for cascade |
| Orphaned data on partial remove | Transaction-like approach: validate all before removing any |
| URI matching ambiguity | Exact match only, no fuzzy matching |

---

## Implementation Notes

### File Modifications Required

| File | Changes |
|------|---------|
| [`src/schemas-projects.ts`](src/schemas-projects.ts) | Add `batch` to ProjectAddSourceSchema, new ProjectRemoveSourceSchema |
| [`src/tools/projects.ts`](src/tools/projects.ts) | Enhance `projectAddSource()`, add `projectRemoveSource()` |
| [`src/index.ts`](src/index.ts) | Register new `indexfoundry_project_remove_source` tool |

### Backward Compatibility

- Existing single-source calls continue to work unchanged
- `batch` parameter is optional; omitting it preserves current behavior
- No breaking changes to response format (single-source returns same structure)

### Testing Strategy

1. **Unit Tests**
   - Single source add (existing behavior)
   - Batch add with valid sources
   - Batch add with duplicates (should skip)
   - Batch add with mixed valid/invalid (partial success)
   - Remove by source_id
   - Remove by source_uri
   - Batch remove
   - Cascade deletion verification
   - Confirm requirement enforcement

2. **Integration Tests**
   - Add batch → build → query → remove → verify empty
   - Remove source with completed chunks → verify cleanup

### Estimated Effort

| Task | Estimate |
|------|----------|
| Schema updates | 1 hour |
| Batch add implementation | 2 hours |
| Remove source implementation | 3 hours |
| Cascade deletion logic | 2 hours |
| Tests | 3 hours |
| Documentation | 1 hour |
| **Total** | **12 hours** |

---

## Open Questions

1. **Soft Delete Option?** - Should there be a `soft_delete` flag that marks sources as "archived" instead of removing them?
   - **Recommendation:** Defer to future enhancement; hard delete is simpler for MVP

2. **Rebuild After Remove?** - Should removing a source trigger automatic rebuild?
   - **Recommendation:** No, user controls rebuild timing via `project_build`

3. **Source Status Filter?** - Should remove only work on certain statuses (e.g., not "processing")?
   - **Recommendation:** Yes, reject removal of sources with status="processing" to prevent race conditions

---

## References

- [`src/tools/projects.ts`](src/tools/projects.ts) - Current add source implementation
- [`src/schemas-projects.ts`](src/schemas-projects.ts) - Current schemas
- Existing batch patterns in `mcp--mnehmoschatrpggame` tools
