# IndexFoundry-MCP: Deterministic Vector Index Factory

## Executive Summary

**IndexFoundry-MCP** is a Model Context Protocol server that automates the creation of vector databases from arbitrary content sources. It enforces a strict five-phase pipeline—**Connect → Extract → Normalize → Index → Serve**—where each phase produces auditable artifacts, content hashes, and run manifests.

The key insight: **Tools don't think, they act.** Every tool is deterministic, idempotent, and produces identical outputs for identical inputs. LLMs orchestrate the tools but cannot deviate from the defined workflow.

---

## Design Principles

### 1. Determinism
- Same inputs → Same outputs (or versioned outputs with explicit deltas)
- Pinned extractor versions, embedding model versions, chunking parameters
- Sorted file lists, stable chunk IDs derived from content

### 2. Composability
- Each tool does ONE thing well
- Tools can be run independently or chained
- No hidden state between tool calls

### 3. Auditability
- Every run produces a manifest with:
  - Input hashes
  - Tool versions
  - Config hashes
  - Output counts
  - Timing metrics
- Content hashes on every chunk enable change detection

### 4. Idempotency
- Re-running a phase with identical inputs produces identical artifacts
- Tools skip work when output already exists (unless `force: true`)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         IndexFoundry-MCP Server                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────┐  ┌───────────┐  ┌───────────┐  ┌─────────┐  ┌──────────┐ │
│  │ Connect  │→ │  Extract  │→ │ Normalize │→ │  Index  │→ │  Serve   │ │
│  └──────────┘  └───────────┘  └───────────┘  └─────────┘  └──────────┘ │
│       ↓             ↓              ↓             ↓            ↓        │
│  raw/*.file    extracted/     normalized/    indexed/     served/      │
│  manifest.json  *.jsonl        chunks.jsonl  stats.json   openapi.json │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                          runs/<run_id>/                                 │
│   manifest.json │ raw/ │ extracted/ │ normalized/ │ indexed/ │ logs/   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Run Directory Layout

Each pipeline run creates an isolated, immutable workspace:

```
runs/<run_id>/
├── manifest.json           # Master manifest: inputs, outputs, timings
├── config.json             # Frozen config snapshot
├── raw/                    # Phase 1: Fetched artifacts
│   ├── <sha256>.pdf
│   ├── <sha256>.html
│   └── raw_manifest.jsonl  # { uri, sha256, fetched_at, size_bytes }
├── extracted/              # Phase 2: Text extraction
│   ├── <sha256>.pages.jsonl
│   ├── <sha256>.txt
│   └── extraction_report.json
├── normalized/             # Phase 3: Chunked documents
│   ├── chunks.jsonl        # Canonical DocumentChunk records
│   ├── dedupe_report.json
│   └── metadata_enrichment.json
├── indexed/                # Phase 4: Vector DB artifacts
│   ├── embeddings.jsonl    # { chunk_id, vector, metadata }
│   ├── upsert_stats.json
│   └── vector_manifest.json
├── served/                 # Phase 5: API artifacts
│   ├── openapi.json
│   └── retrieval_profile.json
└── logs/
    ├── events.ndjson       # Structured event log
    └── errors.ndjson       # Error log with stack traces
```

---

## Canonical Data Models

### DocumentChunk (normalized output)

```typescript
interface DocumentChunk {
  doc_id: string;              // SHA256 of source content
  chunk_id: string;            // SHA256(doc_id + byte_offset)
  chunk_index: number;         // Sequential index within document
  
  source: {
    type: "pdf" | "html" | "csv" | "markdown" | "docx" | "url" | "repo";
    uri: string;               // Original location
    retrieved_at: string;      // ISO8601
    content_hash: string;      // SHA256 of raw bytes
  };
  
  content: {
    text: string;              // Chunk text
    text_hash: string;         // SHA256 of normalized text
    char_count: number;
    token_count_approx: number; // Estimated tokens (chars/4)
  };
  
  position: {
    byte_start: number;
    byte_end: number;
    page?: number;             // For PDFs
    section?: string;          // Detected heading
    line_start?: number;
    line_end?: number;
  };
  
  metadata: {
    content_type: string;      // MIME type of source
    language?: string;         // ISO 639-1
    title?: string;
    tags?: string[];
    custom?: Record<string, unknown>;
  };
}
```

### RunManifest (audit record)

```typescript
interface RunManifest {
  run_id: string;              // UUID v7 (time-ordered)
  created_at: string;          // ISO8601
  completed_at?: string;
  status: "running" | "completed" | "failed" | "partial";
  
  config_hash: string;         // SHA256 of config.json
  
  phases: {
    connect?: PhaseManifest;
    extract?: PhaseManifest;
    normalize?: PhaseManifest;
    index?: PhaseManifest;
    serve?: PhaseManifest;
  };
  
  totals: {
    sources_fetched: number;
    documents_extracted: number;
    chunks_created: number;
    vectors_indexed: number;
    errors_encountered: number;
  };
  
  timing: {
    total_duration_ms: number;
    phase_durations: Record<string, number>;
  };
}

interface PhaseManifest {
  started_at: string;
  completed_at?: string;
  status: "pending" | "running" | "completed" | "failed";
  
  inputs: {
    count: number;
    hashes: string[];          // SHA256 of each input
  };
  
  outputs: {
    count: number;
    hashes: string[];
  };
  
  tool_version: string;
  errors: ErrorRecord[];
}
```

---

## Tool Specifications

### Phase 1: Connect (Fetchers)

#### `indexfoundry_connect_url`

Fetches a single URL with content-type detection and domain allowlist.

```typescript
const ConnectUrlInputSchema = z.object({
  run_id: z.string().uuid().describe("Run directory to write to"),
  url: z.string().url().describe("URL to fetch"),
  allowed_domains: z.array(z.string()).optional()
    .describe("Domain allowlist (empty = allow all)"),
  timeout_ms: z.number().int().min(1000).max(60000).default(30000)
    .describe("Request timeout"),
  headers: z.record(z.string()).optional()
    .describe("Custom HTTP headers"),
  force: z.boolean().default(false)
    .describe("Re-fetch even if content exists")
}).strict();

// Output
interface ConnectUrlOutput {
  success: boolean;
  artifact: {
    path: string;              // runs/<run_id>/raw/<sha256>.<ext>
    sha256: string;
    size_bytes: number;
    content_type: string;
    fetched_at: string;
  };
  skipped?: boolean;           // True if already fetched and !force
  error?: string;
}
```

**Annotations:** `{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }`

---

#### `indexfoundry_connect_sitemap`

Crawls a sitemap deterministically with bounded depth and URL patterns.

```typescript
const ConnectSitemapInputSchema = z.object({
  run_id: z.string().uuid(),
  sitemap_url: z.string().url().describe("Sitemap XML URL"),
  max_pages: z.number().int().min(1).max(10000).default(100)
    .describe("Maximum pages to fetch"),
  include_patterns: z.array(z.string()).optional()
    .describe("Regex patterns for URLs to include"),
  exclude_patterns: z.array(z.string()).optional()
    .describe("Regex patterns for URLs to exclude"),
  concurrency: z.number().int().min(1).max(10).default(3)
    .describe("Parallel fetch count"),
  force: z.boolean().default(false)
}).strict();

// Output
interface ConnectSitemapOutput {
  success: boolean;
  urls_discovered: number;
  urls_fetched: number;
  urls_skipped: number;
  urls_failed: number;
  artifacts: Array<{
    url: string;
    path: string;
    sha256: string;
  }>;
  errors: Array<{ url: string; error: string }>;
}
```

---

#### `indexfoundry_connect_folder`

Loads local files into run scope with glob filtering.

```typescript
const ConnectFolderInputSchema = z.object({
  run_id: z.string().uuid(),
  path: z.string().describe("Absolute path to folder"),
  glob: z.string().default("**/*")
    .describe("Glob pattern (e.g., '**/*.pdf')"),
  exclude_patterns: z.array(z.string()).optional()
    .describe("Patterns to exclude"),
  max_file_size_mb: z.number().min(0.1).max(500).default(50)
    .describe("Skip files larger than this"),
  force: z.boolean().default(false)
}).strict();
```

---

#### `indexfoundry_connect_pdf`

Specialized PDF fetcher with metadata extraction.

```typescript
const ConnectPdfInputSchema = z.object({
  run_id: z.string().uuid(),
  source: z.union([
    z.string().url(),
    z.string().describe("Local file path")
  ]).describe("URL or local path to PDF"),
  force: z.boolean().default(false)
}).strict();

// Output includes PDF-specific metadata
interface ConnectPdfOutput {
  success: boolean;
  artifact: {
    path: string;
    sha256: string;
    size_bytes: number;
    page_count: number;
    pdf_version: string;
    has_ocr_layer: boolean;
    metadata: {
      title?: string;
      author?: string;
      created?: string;
      modified?: string;
    };
  };
}
```

---

### Phase 2: Extract (Parsers)

#### `indexfoundry_extract_pdf`

Converts PDF pages to text using a pinned extractor.

```typescript
const ExtractPdfInputSchema = z.object({
  run_id: z.string().uuid(),
  pdf_path: z.string().describe("Path relative to run's raw/ dir"),
  mode: z.enum(["layout", "plain", "ocr"]).default("layout")
    .describe("Extraction mode: layout preserves columns, plain is linear, ocr for scanned docs"),
  page_range: z.object({
    start: z.number().int().min(1),
    end: z.number().int().min(1)
  }).optional().describe("Pages to extract (1-indexed, inclusive)"),
  ocr_language: z.string().default("eng")
    .describe("Tesseract language code for OCR mode"),
  force: z.boolean().default(false)
}).strict();

// Output
interface ExtractPdfOutput {
  success: boolean;
  artifacts: {
    pages_jsonl: string;       // Path to page-by-page extraction
    full_text?: string;        // Optional concatenated file
  };
  stats: {
    pages_processed: number;
    pages_empty: number;
    pages_ocr_fallback: number;
    chars_extracted: number;
  };
  extraction_report: {
    extractor_version: string; // e.g., "pdfminer.six@20221105"
    mode_used: string;
    warnings: string[];
  };
}

// pages.jsonl format (one line per page):
interface PageExtraction {
  page: number;
  text: string;
  char_count: number;
  is_empty: boolean;
  ocr_used: boolean;
  confidence?: number;         // OCR confidence if applicable
}
```

---

#### `indexfoundry_extract_html`

Strips HTML to clean text with configurable preservation.

```typescript
const ExtractHtmlInputSchema = z.object({
  run_id: z.string().uuid(),
  html_path: z.string(),
  preserve_headings: z.boolean().default(true)
    .describe("Keep heading structure as markdown"),
  preserve_links: z.boolean().default(false)
    .describe("Keep [text](url) format for links"),
  preserve_tables: z.boolean().default(true)
    .describe("Convert tables to markdown format"),
  remove_selectors: z.array(z.string()).optional()
    .describe("CSS selectors to remove (nav, footer, etc.)"),
  force: z.boolean().default(false)
}).strict();
```

---

#### `indexfoundry_extract_document`

Generic document extractor for markdown, docx, txt, csv preview.

```typescript
const ExtractDocumentInputSchema = z.object({
  run_id: z.string().uuid(),
  doc_path: z.string(),
  format_hint: z.enum(["auto", "markdown", "docx", "txt", "csv", "json"])
    .default("auto").describe("Override format detection"),
  csv_preview_rows: z.number().int().min(1).max(1000).default(100)
    .describe("For CSV: rows to include in text preview"),
  force: z.boolean().default(false)
}).strict();
```

---

### Phase 3: Normalize (Chunkers)

#### `indexfoundry_normalize_chunk`

Deterministic text chunking with multiple strategies.

```typescript
const NormalizeChunkInputSchema = z.object({
  run_id: z.string().uuid(),
  input_paths: z.array(z.string())
    .describe("Paths to extracted text files (relative to run/)"),
  strategy: z.enum([
    "fixed_chars",      // Fixed character count
    "by_paragraph",     // Split on double newlines
    "by_heading",       // Split on markdown headings
    "by_page",          // Keep page boundaries (for PDFs)
    "by_sentence",      // Split at sentence boundaries
    "recursive"         // Recursive splitting (recommended)
  ]).default("recursive"),
  
  // Size controls
  max_chars: z.number().int().min(100).max(10000).default(1500)
    .describe("Maximum characters per chunk"),
  min_chars: z.number().int().min(50).max(500).default(100)
    .describe("Minimum characters per chunk"),
  overlap_chars: z.number().int().min(0).max(500).default(150)
    .describe("Character overlap between chunks"),
  
  // Recursive strategy options
  split_hierarchy: z.array(z.string())
    .default(["\n\n", "\n", ". ", " "])
    .describe("Separator hierarchy for recursive splitting"),
  
  force: z.boolean().default(false)
}).strict();

// Output: normalized/chunks.jsonl with DocumentChunk records
interface NormalizeChunkOutput {
  success: boolean;
  output_path: string;
  stats: {
    documents_processed: number;
    chunks_created: number;
    chunks_below_min: number;   // Warning: very small chunks
    chunks_at_max: number;      // Had to hard-cut
    avg_chunk_chars: number;
    total_chars: number;
  };
  chunker_config: {
    strategy: string;
    max_chars: number;
    overlap_chars: number;
    config_hash: string;
  };
}
```

---

#### `indexfoundry_normalize_enrich`

Rule-based metadata enrichment (no LLM).

```typescript
const NormalizeEnrichInputSchema = z.object({
  run_id: z.string().uuid(),
  chunks_path: z.string().default("normalized/chunks.jsonl"),
  
  rules: z.object({
    // Language detection
    detect_language: z.boolean().default(true),
    
    // Regex-based extraction
    regex_tags: z.array(z.object({
      pattern: z.string().describe("Regex with capture group"),
      tag_name: z.string(),
      flags: z.string().default("gi")
    })).optional().describe("Extract tags via regex"),
    
    // Section detection
    section_patterns: z.array(z.object({
      pattern: z.string(),
      section_name: z.string()
    })).optional(),
    
    // Date extraction
    extract_dates: z.boolean().default(false),
    
    // Taxonomy mapping
    taxonomy: z.record(z.array(z.string())).optional()
      .describe("Map terms to categories: { 'safety': ['hazard', 'risk', ...] }")
  }),
  
  force: z.boolean().default(false)
}).strict();
```

---

#### `indexfoundry_normalize_dedupe`

Deterministic deduplication by simhash or exact hash.

```typescript
const NormalizeDedupeInputSchema = z.object({
  run_id: z.string().uuid(),
  chunks_path: z.string().default("normalized/chunks.jsonl"),
  
  method: z.enum(["exact", "simhash", "minhash"]).default("exact")
    .describe("Deduplication method"),
  similarity_threshold: z.number().min(0.8).max(1.0).default(0.95)
    .describe("For fuzzy methods: minimum similarity to consider duplicate"),
  
  scope: z.enum(["global", "per_document"]).default("global")
    .describe("Dedupe across all docs or within each doc"),
  
  force: z.boolean().default(false)
}).strict();

// Output
interface DedupeOutput {
  success: boolean;
  output_path: string;
  stats: {
    input_chunks: number;
    output_chunks: number;
    duplicates_removed: number;
    duplicate_groups: number;  // How many groups of duplicates found
  };
  dedupe_report_path: string;  // Detailed report of what was removed
}
```

---

### Phase 4: Index (Vector DB)

#### `indexfoundry_index_embed`

Generate embeddings with a pinned model.

```typescript
const IndexEmbedInputSchema = z.object({
  run_id: z.string().uuid(),
  chunks_path: z.string().default("normalized/chunks.jsonl"),
  
  model: z.object({
    provider: z.enum(["openai", "cohere", "sentence-transformers", "local"])
      .describe("Embedding provider"),
    model_name: z.string()
      .describe("Model identifier (e.g., 'text-embedding-3-small')"),
    dimensions: z.number().int().optional()
      .describe("Override output dimensions if model supports"),
    api_key_env: z.string().default("EMBEDDING_API_KEY")
      .describe("Environment variable containing API key"),
  }),
  
  batch_size: z.number().int().min(1).max(500).default(100)
    .describe("Chunks to embed per API call"),
  
  normalize_vectors: z.boolean().default(true)
    .describe("L2 normalize output vectors"),
  
  retry_config: z.object({
    max_retries: z.number().int().default(3),
    backoff_ms: z.number().int().default(1000)
  }).optional(),
  
  force: z.boolean().default(false)
}).strict();

// Output: indexed/embeddings.jsonl
interface EmbeddingRecord {
  chunk_id: string;
  vector: number[];            // Or base64 for compactness
  model: string;
  dimensions: number;
  embedded_at: string;
}
```

---

#### `indexfoundry_index_upsert`

Upsert vectors to a vector database.

```typescript
const IndexUpsertInputSchema = z.object({
  run_id: z.string().uuid(),
  embeddings_path: z.string().default("indexed/embeddings.jsonl"),
  chunks_path: z.string().default("normalized/chunks.jsonl"),
  
  provider: z.enum(["milvus", "pinecone", "weaviate", "qdrant", "chroma", "local"])
    .describe("Vector database provider"),
  
  connection: z.object({
    host: z.string().optional(),
    port: z.number().int().optional(),
    api_key_env: z.string().optional(),
    collection: z.string().describe("Collection/index name"),
    namespace: z.string().optional().describe("Namespace within collection")
  }),
  
  metadata_fields: z.array(z.string())
    .default(["source.uri", "source.type", "metadata.language", "position.page"])
    .describe("Chunk fields to store as vector metadata"),
  
  store_text: z.boolean().default(true)
    .describe("Store chunk text in vector metadata"),
  
  upsert_mode: z.enum(["insert", "upsert", "replace"]).default("upsert"),
  
  batch_size: z.number().int().min(1).max(1000).default(100),
  
  force: z.boolean().default(false)
}).strict();

// Output
interface UpsertOutput {
  success: boolean;
  stats: {
    vectors_sent: number;
    vectors_inserted: number;
    vectors_updated: number;
    vectors_failed: number;
    duration_ms: number;
  };
  vector_manifest: {
    collection: string;
    namespace?: string;
    model_used: string;
    dimensions: number;
    metadata_schema: string[];
  };
}
```

---

#### `indexfoundry_index_build_profile`

Define retrieval parameters and filters.

```typescript
const IndexBuildProfileInputSchema = z.object({
  run_id: z.string().uuid(),
  
  retrieval_config: z.object({
    default_top_k: z.number().int().min(1).max(100).default(10),
    
    search_modes: z.array(z.enum(["semantic", "keyword", "hybrid"]))
      .default(["hybrid"]),
    
    hybrid_config: z.object({
      alpha: z.number().min(0).max(1).default(0.7)
        .describe("Weight for semantic vs keyword (1=pure semantic)"),
      fusion_method: z.enum(["rrf", "weighted_sum"]).default("rrf")
    }).optional(),
    
    reranker: z.object({
      enabled: z.boolean().default(false),
      model: z.string().optional(),
      top_k_to_rerank: z.number().int().default(50)
    }).optional()
  }),
  
  allowed_filters: z.array(z.object({
    field: z.string(),
    operators: z.array(z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "contains"]))
  })).optional().describe("Filterable metadata fields"),
  
  security: z.object({
    require_auth: z.boolean().default(false),
    allowed_namespaces: z.array(z.string()).optional()
  }).optional()
}).strict();
```

---

### Phase 5: Serve (API)

#### `indexfoundry_serve_openapi`

Generate OpenAPI specification for the retrieval API.

```typescript
const ServeOpenapiInputSchema = z.object({
  run_id: z.string().uuid(),
  
  api_info: z.object({
    title: z.string().default("IndexFoundry Search API"),
    version: z.string().default("1.0.0"),
    description: z.string().optional(),
    base_path: z.string().default("/api/v1")
  }),
  
  endpoints: z.array(z.enum([
    "search_semantic",
    "search_hybrid",
    "get_document",
    "get_chunk",
    "health",
    "stats"
  ])).default(["search_semantic", "search_hybrid", "get_chunk", "health"]),
  
  include_schemas: z.boolean().default(true)
}).strict();
```

---

#### `indexfoundry_serve_start`

Start the retrieval API server.

```typescript
const ServeStartInputSchema = z.object({
  run_id: z.string().uuid(),
  
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1024).max(65535).default(8080),
  
  cors_origins: z.array(z.string()).optional(),
  
  rate_limit: z.object({
    requests_per_minute: z.number().int().default(60),
    burst: z.number().int().default(10)
  }).optional(),
  
  log_requests: z.boolean().default(true)
}).strict();
```

---

### Orchestration Tool

#### `indexfoundry_pipeline_run`

Run the complete pipeline end-to-end.

```typescript
const PipelineRunInputSchema = z.object({
  // Unique run identifier (auto-generated if not provided)
  run_id: z.string().uuid().optional(),
  
  // Phase 1: Connect
  connect: z.object({
    sources: z.array(z.union([
      z.object({ type: z.literal("url"), url: z.string().url() }),
      z.object({ type: z.literal("sitemap"), url: z.string().url(), max_pages: z.number().optional() }),
      z.object({ type: z.literal("folder"), path: z.string(), glob: z.string().optional() }),
      z.object({ type: z.literal("pdf"), source: z.string() })
    ])),
    allowed_domains: z.array(z.string()).optional()
  }),
  
  // Phase 2: Extract
  extract: z.object({
    pdf_mode: z.enum(["layout", "plain", "ocr"]).default("layout"),
    preserve_headings: z.boolean().default(true)
  }).optional(),
  
  // Phase 3: Normalize
  normalize: z.object({
    chunk_strategy: z.enum(["recursive", "by_paragraph", "by_page"]).default("recursive"),
    max_chars: z.number().int().default(1500),
    overlap_chars: z.number().int().default(150),
    dedupe: z.boolean().default(true),
    detect_language: z.boolean().default(true)
  }).optional(),
  
  // Phase 4: Index
  index: z.object({
    embedding_model: z.string().default("text-embedding-3-small"),
    vector_db: z.object({
      provider: z.enum(["milvus", "pinecone", "weaviate", "qdrant", "chroma", "local"]),
      collection: z.string(),
      connection: z.record(z.unknown()).optional()
    })
  }),
  
  // Phase 5: Serve (optional - may not want auto-start)
  serve: z.object({
    auto_start: z.boolean().default(false),
    port: z.number().int().optional()
  }).optional(),
  
  // Global options
  force: z.boolean().default(false),
  stop_on_error: z.boolean().default(true)
}).strict();

// Output
interface PipelineRunOutput {
  run_id: string;
  status: "completed" | "partial" | "failed";
  manifest_path: string;
  
  phases: {
    connect: PhaseResult;
    extract: PhaseResult;
    normalize: PhaseResult;
    index: PhaseResult;
    serve?: PhaseResult;
  };
  
  summary: {
    sources_fetched: number;
    chunks_indexed: number;
    duration_ms: number;
    errors: number;
  };
  
  retrieval_endpoint?: string;  // If serve.auto_start was true
}

interface PhaseResult {
  status: "completed" | "skipped" | "failed";
  duration_ms: number;
  artifacts_created: number;
  errors: string[];
}
```

---

## Utility Tools

### `indexfoundry_run_status`

Get status of a pipeline run.

```typescript
const RunStatusInputSchema = z.object({
  run_id: z.string().uuid()
}).strict();
```

### `indexfoundry_run_list`

List all runs with optional filtering.

```typescript
const RunListInputSchema = z.object({
  status: z.enum(["all", "completed", "running", "failed"]).default("all"),
  limit: z.number().int().min(1).max(100).default(20),
  before: z.string().datetime().optional(),
  after: z.string().datetime().optional()
}).strict();
```

### `indexfoundry_run_diff`

Compare two runs to see what changed.

```typescript
const RunDiffInputSchema = z.object({
  run_id_a: z.string().uuid(),
  run_id_b: z.string().uuid(),
  include_chunks: z.boolean().default(false)
    .describe("Include chunk-level diff (verbose)")
}).strict();
```

### `indexfoundry_run_cleanup`

Remove old runs to free disk space.

```typescript
const RunCleanupInputSchema = z.object({
  older_than_days: z.number().int().min(1).default(30),
  keep_manifests: z.boolean().default(true)
    .describe("Keep manifest.json even when removing artifacts"),
  dry_run: z.boolean().default(true)
}).strict();
```

---

## Configuration

### Global Config (`indexfoundry.config.json`)

```json
{
  "version": "1.0.0",
  
  "storage": {
    "runs_dir": "./runs",
    "max_runs": 100,
    "cleanup_policy": "fifo"
  },
  
  "defaults": {
    "connect": {
      "timeout_ms": 30000,
      "max_file_size_mb": 50,
      "user_agent": "IndexFoundry/1.0"
    },
    "extract": {
      "pdf_extractor": "pdfminer.six",
      "pdf_mode": "layout",
      "ocr_engine": "tesseract"
    },
    "normalize": {
      "chunk_strategy": "recursive",
      "max_chars": 1500,
      "overlap_chars": 150
    },
    "index": {
      "embedding_provider": "openai",
      "embedding_model": "text-embedding-3-small",
      "batch_size": 100
    }
  },
  
  "pinned_versions": {
    "pdfminer": "20221105",
    "tesseract": "5.3.0",
    "sentence-transformers": "2.2.2"
  },
  
  "security": {
    "allowed_domains": [],
    "blocked_domains": ["localhost", "127.0.0.1"],
    "max_concurrent_fetches": 5
  }
}
```

---

## Error Handling

All tools follow this error response pattern:

```typescript
interface ToolError {
  isError: true;
  content: [{
    type: "text";
    text: string;  // Human-readable error message
  }];
  error: {
    code: string;           // e.g., "FETCH_FAILED", "PARSE_ERROR"
    message: string;
    details?: unknown;
    recoverable: boolean;   // Can this be retried?
    suggestion?: string;    // What to try next
  };
}
```

### Error Codes

| Code | Phase | Description |
|------|-------|-------------|
| `FETCH_FAILED` | Connect | HTTP request failed |
| `FETCH_TIMEOUT` | Connect | Request timed out |
| `DOMAIN_BLOCKED` | Connect | Domain not in allowlist |
| `FILE_TOO_LARGE` | Connect | Exceeds max_file_size_mb |
| `PARSE_ERROR` | Extract | Could not parse document |
| `OCR_FAILED` | Extract | OCR processing failed |
| `EMPTY_CONTENT` | Extract | No text extracted |
| `CHUNK_ERROR` | Normalize | Chunking failed |
| `EMBED_ERROR` | Index | Embedding API error |
| `DB_ERROR` | Index | Vector DB error |
| `CONFIG_INVALID` | Any | Configuration validation failed |
| `RUN_NOT_FOUND` | Any | Run ID doesn't exist |

---

## Implementation Notes

### Determinism Guarantees

1. **File ordering**: All file lists sorted lexicographically before processing
2. **Stable IDs**: Chunk IDs derived from `SHA256(doc_id || byte_start || byte_end)`
3. **Reproducible hashing**: All hashes use SHA256, UTF-8 normalized text
4. **Pinned dependencies**: Extractor versions locked in config
5. **No randomness**: No random sampling, shuffling, or non-deterministic algorithms

### Performance Considerations

1. **Streaming**: Large files processed in streaming fashion
2. **Batching**: Embeddings generated in configurable batches
3. **Parallelism**: Connect phase supports concurrent fetching
4. **Caching**: Skip work when output hashes match input hashes

### Security

1. **Input validation**: All paths sanitized, no directory traversal
2. **Domain allowlist**: Optional restriction on fetchable domains
3. **Secrets**: API keys read from environment, never logged
4. **Resource limits**: Timeouts, file size limits, rate limiting

---

## Next Steps

1. **TypeScript skeleton**: Implement McpServer with tool registrations
2. **Core extractors**: Start with PDF and HTML
3. **Local vector DB**: Implement Chroma/local fallback for testing
4. **Test suite**: Determinism tests with fixed inputs
5. **Documentation**: README with quickstart examples
