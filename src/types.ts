/**
 * IndexFoundry-MCP: Canonical Data Types
 *
 * These types define the core data structures used throughout the pipeline.
 * All types are designed for determinism, auditability, and composability.
 *
 * Copyright (c) 2024 vario.automation
 * Proprietary and confidential. All rights reserved.
 */

// ============================================================================
// DocumentChunk - The normalized output of extraction and chunking
// ============================================================================

export interface DocumentChunk {
  doc_id: string;              // SHA256 of source content
  chunk_id: string;            // SHA256(doc_id + byte_offset)
  chunk_index: number;         // Sequential index within document
  
  // Hierarchical chunking fields
  parent_id?: string;          // Reference to parent chunk's chunk_id
  parent_context?: string;     // Truncated content from parent for context
  hierarchy_level?: number;    // 0=document root, 1=h1, 2=h2, etc. (default: 0)
  
  source: {
    type: "pdf" | "html" | "csv" | "markdown" | "docx" | "url" | "repo" | "txt" | "json";
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

// ============================================================================
// RunManifest - Audit record for pipeline runs
// ============================================================================

export interface RunManifest {
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

export interface PhaseManifest {
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

export interface ErrorRecord {
  timestamp: string;
  code: string;
  message: string;
  details?: unknown;
  recoverable: boolean;
}

// ============================================================================
// Artifact Records - Outputs from each phase
// ============================================================================

export interface RawArtifact {
  uri: string;
  sha256: string;
  fetched_at: string;
  size_bytes: number;
  content_type: string;
  local_path: string;
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
  pages_processed: number;
  pages_empty: number;
  chars_extracted: number;
}

export interface EmbeddingRecord {
  chunk_id: string;
  vector: number[];
  model: string;
  dimensions: number;
  embedded_at: string;
}

export interface VectorManifest {
  collection: string;
  namespace?: string;
  model_used: string;
  dimensions: number;
  metadata_schema: string[];
  vectors_count: number;
  created_at: string;
}

// ============================================================================
// Tool Result Types
// ============================================================================

export interface ConnectResult {
  success: boolean;
  artifact: {
    path: string;
    sha256: string;
    size_bytes: number;
    content_type: string;
    fetched_at: string;
  };
  skipped?: boolean;
  error?: string;
}

export interface ExtractResult {
  success: boolean;
  artifacts: {
    pages_jsonl?: string;
    full_text?: string;
  };
  stats: {
    pages_processed: number;
    pages_empty: number;
    pages_ocr_fallback: number;
    chars_extracted: number;
  };
  extraction_report: ExtractionReport;
}

export interface NormalizeResult {
  success: boolean;
  output_path: string;
  stats: {
    documents_processed: number;
    chunks_created: number;
    chunks_below_min: number;
    chunks_at_max: number;
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

export interface IndexResult {
  success: boolean;
  stats: {
    vectors_sent: number;
    vectors_inserted: number;
    vectors_updated: number;
    vectors_failed: number;
    duration_ms: number;
  };
  vector_manifest: VectorManifest;
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

export interface PhaseResult {
  status: "completed" | "skipped" | "failed";
  duration_ms: number;
  artifacts_created: number;
  errors: string[];
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface IndexFoundryConfig {
  version: string;
  
  storage: {
    runs_dir: string;
    max_runs: number;
    cleanup_policy: "fifo" | "lru" | "manual";
  };
  
  defaults: {
    connect: {
      timeout_ms: number;
      max_file_size_mb: number;
      user_agent: string;
    };
    extract: {
      pdf_extractor: string;
      pdf_mode: "layout" | "plain" | "ocr";
      ocr_engine: string;
    };
    normalize: {
      chunk_strategy: ChunkStrategy;
      max_chars: number;
      overlap_chars: number;
    };
    index: {
      embedding_provider: string;
      embedding_model: string;
      batch_size: number;
    };
  };
  
  pinned_versions: Record<string, string>;
  
  security: {
    allowed_domains: string[];
    blocked_domains: string[];
    max_concurrent_fetches: number;
  };
}

export type ChunkStrategy =
  | "fixed_chars"
  | "by_paragraph"
  | "by_heading"
  | "by_page"
  | "by_sentence"
  | "recursive"
  | "hierarchical";

export type VectorDBProvider = 
  | "milvus" 
  | "pinecone" 
  | "weaviate" 
  | "qdrant" 
  | "chroma" 
  | "local";

export type EmbeddingProvider = 
  | "openai" 
  | "cohere" 
  | "sentence-transformers" 
  | "local";

// ============================================================================
// Error Types
// ============================================================================

export type ErrorCode =
  | "FETCH_FAILED"
  | "FETCH_TIMEOUT"
  | "DOMAIN_BLOCKED"
  | "FILE_TOO_LARGE"
  | "PARSE_ERROR"
  | "OCR_FAILED"
  | "EMPTY_CONTENT"
  | "CHUNK_ERROR"
  | "EMBED_ERROR"
  | "DB_ERROR"
  | "CONFIG_INVALID"
  | "RUN_NOT_FOUND"
  | "INVALID_INPUT"
  // Project errors
  | "PROJECT_EXISTS"
  | "PROJECT_NOT_FOUND"
  | "NOT_FOUND"
  | "NOT_CONFIRMED"
  | "DUPLICATE_SOURCE"
  | "NO_SOURCE"
  | "CREATE_FAILED"
  | "DELETE_FAILED"
  | "READ_FAILED"
  | "LIST_FAILED"
  | "ADD_FAILED"
  | "BUILD_FAILED"
  | "QUERY_FAILED"
  | "EXPORT_FAILED"
  | "NOT_EXPORTED"
  | "ENV_VAR_FAILED"
  | "DEPLOY_FAILED"
  // Server errors
  | "ALREADY_RUNNING"
  | "NOT_RUNNING"
  | "NOT_BUILT"
  | "INSTALL_FAILED"
  | "SERVE_FAILED"
  | "STOP_FAILED";

export interface ToolError {
  isError: true;
  code: ErrorCode;
  message: string;
  details?: unknown;
  recoverable: boolean;
  suggestion?: string;
}

// ============================================================================
// Event Types (for logging)
// ============================================================================

export interface EventLogEntry {
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  phase: string;
  tool: string;
  message: string;
  data?: unknown;
}
