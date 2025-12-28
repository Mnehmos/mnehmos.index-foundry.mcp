/**
 * IndexFoundry-MCP: Zod Schemas for Tool Input Validation
 *
 * Every tool has a strict schema that enforces type safety and provides
 * clear error messages for invalid inputs.
 *
 * Copyright (c) 2024 vario.automation
 * Proprietary and confidential. All rights reserved.
 */

import { z } from "zod";

// ============================================================================
// Common Schemas
// ============================================================================

export const RunIdSchema = z.string().uuid().describe("Run directory identifier");
export const ForceSchema = z.boolean().default(false).describe("Re-run even if output exists");
export const UrlSchema = z.string().url().describe("Valid URL");

// ============================================================================
// Phase 1: Connect Schemas
// ============================================================================

export const ConnectUrlInputSchema = z.object({
  run_id: RunIdSchema,
  url: UrlSchema.describe("URL to fetch"),
  allowed_domains: z.array(z.string()).optional()
    .describe("Domain allowlist (empty = allow all)"),
  timeout_ms: z.number().int().min(1000).max(60000).default(30000)
    .describe("Request timeout in milliseconds"),
  headers: z.record(z.string()).optional()
    .describe("Custom HTTP headers"),
  force: ForceSchema
}).strict();

export const ConnectSitemapInputSchema = z.object({
  run_id: RunIdSchema,
  sitemap_url: UrlSchema.describe("Sitemap XML URL"),
  max_pages: z.number().int().min(1).max(10000).default(100)
    .describe("Maximum pages to fetch"),
  include_patterns: z.array(z.string()).optional()
    .describe("Regex patterns for URLs to include"),
  exclude_patterns: z.array(z.string()).optional()
    .describe("Regex patterns for URLs to exclude"),
  allowed_domains: z.array(z.string()).optional()
    .describe("Domain allowlist (empty = allow all)"),
  concurrency: z.number().int().min(1).max(10).default(3)
    .describe("Parallel fetch count"),
  force: ForceSchema
}).strict();

export const ConnectFolderInputSchema = z.object({
  run_id: RunIdSchema,
  path: z.string().describe("Absolute path to folder"),
  glob: z.string().default("**/*")
    .describe("Glob pattern (e.g., '**/*.pdf')"),
  exclude_patterns: z.array(z.string()).optional()
    .describe("Patterns to exclude"),
  max_file_size_mb: z.number().min(0.1).max(500).default(50)
    .describe("Skip files larger than this"),
  force: ForceSchema
}).strict();

export const ConnectPdfInputSchema = z.object({
  run_id: RunIdSchema,
  source: z.string().describe("URL or local path to PDF"),
  force: ForceSchema
}).strict();

// ============================================================================
// Phase 2: Extract Schemas
// ============================================================================

export const ExtractPdfInputSchema = z.object({
  run_id: RunIdSchema,
  pdf_path: z.string().describe("Path relative to run's raw/ dir"),
  mode: z.enum(["layout", "plain", "ocr"]).default("layout")
    .describe("Extraction mode: layout preserves columns, plain is linear, ocr for scanned docs"),
  page_range: z.object({
    start: z.number().int().min(1),
    end: z.number().int().min(1)
  }).optional().describe("Pages to extract (1-indexed, inclusive)"),
  ocr_language: z.string().default("eng")
    .describe("Tesseract language code for OCR mode"),
  force: ForceSchema
}).strict();

export const ExtractHtmlInputSchema = z.object({
  run_id: RunIdSchema,
  html_path: z.string().describe("Path relative to run's raw/ dir"),
  preserve_headings: z.boolean().default(true)
    .describe("Keep heading structure as markdown"),
  preserve_links: z.boolean().default(false)
    .describe("Keep [text](url) format for links"),
  preserve_tables: z.boolean().default(true)
    .describe("Convert tables to markdown format"),
  remove_selectors: z.array(z.string()).optional()
    .describe("CSS selectors to remove (nav, footer, etc.)"),
  force: ForceSchema
}).strict();

export const ExtractDocumentInputSchema = z.object({
  run_id: RunIdSchema,
  doc_path: z.string().describe("Path relative to run's raw/ dir"),
  format_hint: z.enum(["auto", "markdown", "docx", "txt", "csv", "json"])
    .default("auto").describe("Override format detection"),
  csv_preview_rows: z.number().int().min(1).max(1000).default(100)
    .describe("For CSV: rows to include in text preview"),
  force: ForceSchema
}).strict();

// ============================================================================
// Phase 3: Normalize Schemas
// ============================================================================

export const NormalizeChunkInputSchema = z.object({
  run_id: RunIdSchema,
  input_paths: z.array(z.string())
    .describe("Paths to extracted text files (relative to run/)"),
  strategy: z.enum([
    "fixed_chars",
    "by_paragraph",
    "by_heading",
    "by_page",
    "by_sentence",
    "recursive",
    "hierarchical"
  ]).default("recursive")
    .describe("Chunking strategy: 'recursive' (default) splits by separator hierarchy, 'hierarchical' creates parent-child relationships from markdown headings (h1-h6), others split by fixed size, paragraph, heading, page, or sentence boundaries"),
  max_chars: z.number().int().min(100).max(10000).default(1500)
    .describe("Maximum characters per chunk"),
  min_chars: z.number().int().min(50).max(500).default(100)
    .describe("Minimum characters per chunk (smaller chunks are merged with neighbors)"),
  overlap_chars: z.number().int().min(0).max(500).default(150)
    .describe("Character overlap between adjacent chunks for context continuity"),
  split_hierarchy: z.array(z.string())
    .default(["\n\n", "\n", ". ", " "])
    .describe("Separator priority for recursive splitting (e.g., double newline → newline → sentence → space)"),
  // Hierarchical chunking options
  create_parent_chunks: z.boolean().default(true)
    .describe("📚 (hierarchical only) Create parent chunks for each heading level. Parent chunks contain the heading and its content, enabling child chunks to reference them via parent_id."),
  parent_context_chars: z.number().int().min(0).max(500).default(200)
    .describe("📎 (hierarchical only) Number of characters from parent chunk to include in child chunks as context. Set to 0 to disable parent context embedding."),
  force: ForceSchema
}).strict();

export const NormalizeEnrichInputSchema = z.object({
  run_id: RunIdSchema,
  chunks_path: z.string().default("normalized/chunks.jsonl")
    .describe("Path to chunks file"),
  rules: z.object({
    detect_language: z.boolean().default(true),
    regex_tags: z.array(z.object({
      pattern: z.string().describe("Regex with capture group"),
      tag_name: z.string(),
      flags: z.string().default("gi")
    })).optional().describe("Extract tags via regex"),
    section_patterns: z.array(z.object({
      pattern: z.string(),
      section_name: z.string()
    })).optional(),
    extract_dates: z.boolean().default(false),
    taxonomy: z.record(z.array(z.string())).optional()
      .describe("Map terms to categories: { 'safety': ['hazard', 'risk', ...] }")
  }),
  force: ForceSchema
}).strict();

export const NormalizeDedupeInputSchema = z.object({
  run_id: RunIdSchema,
  chunks_path: z.string().default("normalized/chunks.jsonl"),
  method: z.enum(["exact", "simhash", "minhash"]).default("exact")
    .describe("Deduplication method"),
  similarity_threshold: z.number().min(0.8).max(1.0).default(0.95)
    .describe("For fuzzy methods: minimum similarity to consider duplicate"),
  scope: z.enum(["global", "per_document"]).default("global")
    .describe("Dedupe across all docs or within each doc"),
  force: ForceSchema
}).strict();

// ============================================================================
// Phase 4: Index Schemas
// ============================================================================

export const IndexEmbedInputSchema = z.object({
  run_id: RunIdSchema,
  chunks_path: z.string().default("normalized/chunks.jsonl"),
  model: z.object({
    provider: z.enum(["openai", "cohere", "sentence-transformers", "local"])
      .describe("Embedding provider"),
    model_name: z.string()
      .describe("Model identifier (e.g., 'text-embedding-3-small')"),
    dimensions: z.number().int().optional()
      .describe("Override output dimensions if model supports"),
    api_key_env: z.string().default("OPENAI_API_KEY")
      .describe("Environment variable containing API key")
  }),
  batch_size: z.number().int().min(1).max(500).default(100)
    .describe("Chunks to embed per API call"),
  normalize_vectors: z.boolean().default(true)
    .describe("L2 normalize output vectors"),
  retry_config: z.object({
    max_retries: z.number().int().default(3),
    backoff_ms: z.number().int().default(1000)
  }).optional(),
  force: ForceSchema
}).strict();

export const IndexUpsertInputSchema = z.object({
  run_id: RunIdSchema,
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
  force: ForceSchema
}).strict();

export const IndexBuildProfileInputSchema = z.object({
  run_id: RunIdSchema,
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

// ============================================================================
// Phase 5: Serve Schemas
// ============================================================================

export const ServeOpenapiInputSchema = z.object({
  run_id: RunIdSchema,
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

export const ServeStartInputSchema = z.object({
  run_id: RunIdSchema,
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1024).max(65535).default(8080),
  cors_origins: z.array(z.string()).optional(),
  rate_limit: z.object({
    requests_per_minute: z.number().int().default(60),
    burst: z.number().int().default(10)
  }).optional(),
  log_requests: z.boolean().default(true)
}).strict();

export const ServeStopInputSchema = z.object({
  run_id: RunIdSchema
}).strict();

export const ServeStatusInputSchema = z.object({
  run_id: RunIdSchema.optional()
    .describe("Optional: check specific run. If omitted, lists all running servers")
}).strict();

export const ServeQueryInputSchema = z.object({
  run_id: RunIdSchema,
  query: z.string().optional()
    .describe("Text query for keyword/hybrid search"),
  query_vector: z.array(z.number()).optional()
    .describe("Pre-computed embedding vector for semantic/hybrid search"),
  mode: z.enum(["semantic", "keyword", "hybrid"]).default("hybrid")
    .describe("Search mode"),
  top_k: z.number().int().min(1).max(100).default(10)
    .describe("Number of results to return"),
  alpha: z.number().min(0).max(1).optional()
    .describe("Hybrid search weight (1=pure semantic, 0=pure keyword)"),
  filters: z.record(z.unknown()).optional()
    .describe("Metadata filters to apply"),
  include_text: z.boolean().default(true)
    .describe("Include chunk text in results"),
  expand_context: z.object({
    enabled: z.boolean().default(false)
      .describe("🔗 Enable context expansion to fetch related chunks"),
    strategy: z.enum(["adjacent", "parent", "both"]).default("both")
      .describe("📚 Strategy: 'adjacent' (siblings), 'parent' (hierarchy), or 'both'"),
    adjacent_before: z.number().int().min(0).max(5).default(1)
      .describe("⬆️ Number of chunks to fetch before the target (0-5)"),
    adjacent_after: z.number().int().min(0).max(5).default(1)
      .describe("⬇️ Number of chunks to fetch after the target (0-5)"),
    include_parent: z.boolean().default(true)
      .describe("🌳 Include the immediate parent chunk in context"),
    max_total_chunks: z.number().int().min(1).max(20).default(10)
      .describe("📊 Maximum total context chunks to return (1-20)")
  }).optional()
    .describe("🔗 Context expansion options for hydrating search results with adjacent and parent chunks")
}).strict();

// ============================================================================
// Pipeline Orchestration Schema
// ============================================================================

export const PipelineRunInputSchema = z.object({
  run_id: z.string().uuid().optional(),
  
  connect: z.object({
    sources: z.array(z.union([
      z.object({ type: z.literal("url"), url: UrlSchema }),
      z.object({ 
        type: z.literal("sitemap"), 
        url: UrlSchema, 
        max_pages: z.number().optional() 
      }),
      z.object({ 
        type: z.literal("folder"), 
        path: z.string(), 
        glob: z.string().optional() 
      }),
      z.object({ type: z.literal("pdf"), source: z.string() })
    ])),
    allowed_domains: z.array(z.string()).optional()
  }),
  
  extract: z.object({
    pdf_mode: z.enum(["layout", "plain", "ocr"]).default("layout"),
    preserve_headings: z.boolean().default(true)
  }).optional(),
  
  normalize: z.object({
    chunk_strategy: z.enum(["recursive", "by_paragraph", "by_page"]).default("recursive"),
    max_chars: z.number().int().default(1500),
    overlap_chars: z.number().int().default(150),
    dedupe: z.boolean().default(true),
    detect_language: z.boolean().default(true)
  }).optional(),
  
  index: z.object({
    embedding_model: z.string().default("text-embedding-3-small"),
    vector_db: z.object({
      provider: z.enum(["milvus", "pinecone", "weaviate", "qdrant", "chroma", "local"]),
      collection: z.string(),
      connection: z.record(z.unknown()).optional()
    })
  }),
  
  serve: z.object({
    auto_start: z.boolean().default(false),
    port: z.number().int().optional()
  }).optional(),
  
  force: ForceSchema,
  stop_on_error: z.boolean().default(true)
}).strict();

// ============================================================================
// Utility Schemas
// ============================================================================

export const RunStatusInputSchema = z.object({
  run_id: RunIdSchema
}).strict();

export const RunListInputSchema = z.object({
  status: z.enum(["all", "completed", "running", "failed"]).default("all"),
  limit: z.number().int().min(1).max(100).default(20),
  before: z.string().datetime().optional(),
  after: z.string().datetime().optional()
}).strict();

export const RunDiffInputSchema = z.object({
  run_id_a: RunIdSchema,
  run_id_b: RunIdSchema,
  include_chunks: z.boolean().default(false)
    .describe("Include chunk-level diff (verbose)")
}).strict();

export const RunCleanupInputSchema = z.object({
  older_than_days: z.number().int().min(1).default(30),
  keep_manifests: z.boolean().default(true)
    .describe("Keep manifest.json even when removing artifacts"),
  dry_run: z.boolean().default(true)
}).strict();

// ============================================================================
// Export type inference helpers
// ============================================================================

export type ConnectUrlInput = z.infer<typeof ConnectUrlInputSchema>;
export type ConnectSitemapInput = z.infer<typeof ConnectSitemapInputSchema>;
export type ConnectFolderInput = z.infer<typeof ConnectFolderInputSchema>;
export type ConnectPdfInput = z.infer<typeof ConnectPdfInputSchema>;
export type ExtractPdfInput = z.infer<typeof ExtractPdfInputSchema>;
export type ExtractHtmlInput = z.infer<typeof ExtractHtmlInputSchema>;
export type ExtractDocumentInput = z.infer<typeof ExtractDocumentInputSchema>;
export type NormalizeChunkInput = z.infer<typeof NormalizeChunkInputSchema>;
export type NormalizeEnrichInput = z.infer<typeof NormalizeEnrichInputSchema>;
export type NormalizeDedupeInput = z.infer<typeof NormalizeDedupeInputSchema>;
export type IndexEmbedInput = z.infer<typeof IndexEmbedInputSchema>;
export type IndexUpsertInput = z.infer<typeof IndexUpsertInputSchema>;
export type IndexBuildProfileInput = z.infer<typeof IndexBuildProfileInputSchema>;
export type ServeOpenapiInput = z.infer<typeof ServeOpenapiInputSchema>;
export type ServeStartInput = z.infer<typeof ServeStartInputSchema>;
export type ServeStopInput = z.infer<typeof ServeStopInputSchema>;
export type ServeStatusInput = z.infer<typeof ServeStatusInputSchema>;
export type ServeQueryInput = z.infer<typeof ServeQueryInputSchema>;
export type PipelineRunInput = z.infer<typeof PipelineRunInputSchema>;
export type RunStatusInput = z.infer<typeof RunStatusInputSchema>;
export type RunListInput = z.infer<typeof RunListInputSchema>;
export type RunDiffInput = z.infer<typeof RunDiffInputSchema>;
export type RunCleanupInput = z.infer<typeof RunCleanupInputSchema>;

// ============================================================================
// Schema Aliases (for MCP tool registration)
// ============================================================================

export const ConnectUrlSchema = ConnectUrlInputSchema;
export const ConnectSitemapSchema = ConnectSitemapInputSchema;
export const ConnectFolderSchema = ConnectFolderInputSchema;
export const ConnectPdfSchema = ConnectPdfInputSchema;
export const ExtractPdfSchema = ExtractPdfInputSchema;
export const ExtractHtmlSchema = ExtractHtmlInputSchema;
export const ExtractDocumentSchema = ExtractDocumentInputSchema;
export const NormalizeChunkSchema = NormalizeChunkInputSchema;
export const NormalizeEnrichSchema = NormalizeEnrichInputSchema;
export const NormalizeDedupeSchema = NormalizeDedupeInputSchema;
export const IndexEmbedSchema = IndexEmbedInputSchema;
export const IndexUpsertSchema = IndexUpsertInputSchema;
export const IndexBuildProfileSchema = IndexBuildProfileInputSchema;
export const ServeOpenapiSchema = ServeOpenapiInputSchema;
export const ServeStartSchema = ServeStartInputSchema;
export const ServeStopSchema = ServeStopInputSchema;
export const ServeStatusSchema = ServeStatusInputSchema;
export const ServeQuerySchema = ServeQueryInputSchema;
export const PipelineRunSchema = PipelineRunInputSchema;
export const RunStatusSchema = RunStatusInputSchema;
export const RunListSchema = RunListInputSchema;
export const RunDiffSchema = RunDiffInputSchema;
export const RunCleanupSchema = RunCleanupInputSchema;
