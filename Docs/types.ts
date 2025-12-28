/**
 * IndexFoundry-MCP Core Type Definitions
 * 
 * These types define the canonical data structures used throughout the pipeline.
 * All types are designed for determinism and auditability.
 */

// =============================================================================
// Document & Chunk Types
// =============================================================================

export interface DocumentSource {
  type: "pdf" | "html" | "csv" | "markdown" | "docx" | "url" | "repo";
  uri: string;
  retrieved_at: string;  // ISO8601
  content_hash: string;  // SHA256 of raw bytes
}

export interface ChunkContent {
  text: string;
  text_hash: string;     // SHA256 of normalized text
  char_count: number;
  token_count_approx: number;
}

export interface ChunkPosition {
  byte_start: number;
  byte_end: number;
  page?: number;
  section?: string;
  line_start?: number;
  line_end?: number;
}

export interface ChunkMetadata {
  content_type: string;
  language?: string;
  title?: string;
  tags?: string[];
  custom?: Record<string, unknown>;
}

export interface DocumentChunk {
  doc_id: string;
  chunk_id: string;
  chunk_index: number;
  source: DocumentSource;
  content: ChunkContent;
  position: ChunkPosition;
  metadata: ChunkMetadata;
}

// =============================================================================
// Manifest Types
// =============================================================================

export interface ErrorRecord {
  timestamp: string;
  code: string;
  message: string;
  details?: unknown;
  recoverable: boolean;
}

export interface PhaseManifest {
  started_at: string;
  completed_at?: string;
  status: "pending" | "running" | "completed" | "failed";
  inputs: {
    count: number;
    hashes: string[];
  };
  outputs: {
    count: number;
    hashes: string[];
  };
  tool_version: string;
  errors: ErrorRecord[];
}

export interface RunManifest {
  run_id: string;
  created_at: string;
  completed_at?: string;
  status: "running" | "completed" | "failed" | "partial";
  config_hash: string;
  
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

// =============================================================================
// Artifact Types
// =============================================================================

export interface RawArtifact {
  path: string;
  sha256: string;
  size_bytes: number;
  content_type: string;
  fetched_at: string;
  source_uri: string;
}

export interface PdfArtifact extends RawArtifact {
  page_count: number;
  pdf_version: string;
  has_ocr_layer: boolean;
  pdf_metadata: {
    title?: string;
    author?: string;
    created?: string;
    modified?: string;
  };
}

export interface PageExtraction {
  page: number;
  text: string;
  char_count: number;
  is_empty: boolean;
  ocr_used: boolean;
  confidence?: number;
}

export interface ExtractionReport {
  extractor_version: string;
  mode_used: string;
  warnings: string[];
  stats: {
    pages_processed: number;
    pages_empty: number;
    pages_ocr_fallback: number;
    chars_extracted: number;
  };
}

// =============================================================================
// Embedding & Index Types
// =============================================================================

export interface EmbeddingRecord {
  chunk_id: string;
  vector: number[];
  model: string;
  dimensions: number;
  embedded_at: string;
}

export interface UpsertStats {
  vectors_sent: number;
  vectors_inserted: number;
  vectors_updated: number;
  vectors_failed: number;
  duration_ms: number;
}

export interface VectorManifest {
  collection: string;
  namespace?: string;
  model_used: string;
  dimensions: number;
  metadata_schema: string[];
  created_at: string;
  total_vectors: number;
}

// =============================================================================
// Retrieval Profile Types
// =============================================================================

export interface HybridConfig {
  alpha: number;  // 0-1, weight for semantic vs keyword
  fusion_method: "rrf" | "weighted_sum";
}

export interface RerankerConfig {
  enabled: boolean;
  model?: string;
  top_k_to_rerank: number;
}

export interface RetrievalProfile {
  default_top_k: number;
  search_modes: Array<"semantic" | "keyword" | "hybrid">;
  hybrid_config?: HybridConfig;
  reranker?: RerankerConfig;
  allowed_filters: Array<{
    field: string;
    operators: Array<"eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "contains">;
  }>;
}

// =============================================================================
// Configuration Types
// =============================================================================

export interface ConnectDefaults {
  timeout_ms: number;
  max_file_size_mb: number;
  user_agent: string;
}

export interface ExtractDefaults {
  pdf_extractor: string;
  pdf_mode: "layout" | "plain" | "ocr";
  ocr_engine: string;
}

export interface NormalizeDefaults {
  chunk_strategy: "recursive" | "fixed_chars" | "by_paragraph" | "by_heading" | "by_page" | "by_sentence";
  max_chars: number;
  overlap_chars: number;
}

export interface IndexDefaults {
  embedding_provider: "openai" | "cohere" | "sentence-transformers" | "local";
  embedding_model: string;
  batch_size: number;
}

export interface ServerConfig {
  version: string;
  storage: {
    runs_dir: string;
    max_runs: number;
    cleanup_policy: "fifo" | "lru" | "manual";
  };
  defaults: {
    connect: ConnectDefaults;
    extract: ExtractDefaults;
    normalize: NormalizeDefaults;
    index: IndexDefaults;
  };
  pinned_versions: Record<string, string>;
  security: {
    allowed_domains: string[];
    blocked_domains: string[];
    max_concurrent_fetches: number;
  };
}

// =============================================================================
// Tool Response Types
// =============================================================================

export interface ToolSuccess<T> {
  success: true;
  data: T;
}

export interface ToolFailure {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    recoverable: boolean;
    suggestion?: string;
  };
}

export type ToolResult<T> = ToolSuccess<T> | ToolFailure;

// =============================================================================
// Pipeline Types
// =============================================================================

export interface PipelineSource {
  type: "url" | "sitemap" | "folder" | "pdf";
  url?: string;
  path?: string;
  glob?: string;
  max_pages?: number;
}

export interface PipelineConfig {
  run_id?: string;
  connect: {
    sources: PipelineSource[];
    allowed_domains?: string[];
  };
  extract?: {
    pdf_mode?: "layout" | "plain" | "ocr";
    preserve_headings?: boolean;
  };
  normalize?: {
    chunk_strategy?: "recursive" | "by_paragraph" | "by_page";
    max_chars?: number;
    overlap_chars?: number;
    dedupe?: boolean;
    detect_language?: boolean;
  };
  index: {
    embedding_model: string;
    vector_db: {
      provider: "milvus" | "pinecone" | "weaviate" | "qdrant" | "chroma" | "local";
      collection: string;
      connection?: Record<string, unknown>;
    };
  };
  serve?: {
    auto_start?: boolean;
    port?: number;
  };
  force?: boolean;
  stop_on_error?: boolean;
}

export interface PhaseResult {
  status: "completed" | "skipped" | "failed";
  duration_ms: number;
  artifacts_created: number;
  errors: string[];
}

export interface PipelineResult {
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
  retrieval_endpoint?: string;
}

// =============================================================================
// Event Log Types
// =============================================================================

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  timestamp: string;
  level: LogLevel;
  phase: string;
  tool: string;
  message: string;
  details?: unknown;
}

// =============================================================================
// Utility Types
// =============================================================================

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type RequireAtLeastOne<T, Keys extends keyof T = keyof T> =
  Pick<T, Exclude<keyof T, Keys>> 
  & {
      [K in Keys]-?: Required<Pick<T, K>> & Partial<Pick<T, Exclude<Keys, K>>>
  }[Keys];
