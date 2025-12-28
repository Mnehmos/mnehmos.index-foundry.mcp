/**
 * IndexFoundry-MCP Server
 * 
 * Deterministic Vector Index Factory - MCP server for automated vector database creation.
 * 
 * Tools don't think, they act. Every tool is deterministic, idempotent, and produces
 * identical outputs for identical inputs.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

// Import schemas
import {
  ConnectUrlInputSchema,
  ConnectSitemapInputSchema,
  ConnectFolderInputSchema,
  ConnectPdfInputSchema,
  ExtractPdfInputSchema,
  ExtractHtmlInputSchema,
  ExtractDocumentInputSchema,
  NormalizeChunkInputSchema,
  NormalizeEnrichInputSchema,
  NormalizeDedupeInputSchema,
  IndexEmbedInputSchema,
  IndexUpsertInputSchema,
  IndexBuildProfileInputSchema,
  ServeOpenapiInputSchema,
  ServeStartInputSchema,
  PipelineRunInputSchema,
  RunStatusInputSchema,
  RunListInputSchema,
  RunDiffInputSchema,
  RunCleanupInputSchema,
} from "./schemas/index.js";

// Import tool implementations (stubs for now)
import { 
  handleConnectUrl,
  handleConnectSitemap,
  handleConnectFolder,
  handleConnectPdf,
} from "./tools/connect.js";

import {
  handleExtractPdf,
  handleExtractHtml,
  handleExtractDocument,
} from "./tools/extract.js";

import {
  handleNormalizeChunk,
  handleNormalizeEnrich,
  handleNormalizeDedupe,
} from "./tools/normalize.js";

import {
  handleIndexEmbed,
  handleIndexUpsert,
  handleIndexBuildProfile,
} from "./tools/index-tools.js";

import {
  handleServeOpenapi,
  handleServeStart,
} from "./tools/serve.js";

import {
  handlePipelineRun,
  handleRunStatus,
  handleRunList,
  handleRunDiff,
  handleRunCleanup,
} from "./tools/pipeline.js";

// =============================================================================
// Server Configuration
// =============================================================================

const SERVER_NAME = "indexfoundry-mcp-server";
const SERVER_VERSION = "0.1.0";

// =============================================================================
// Server Initialization
// =============================================================================

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

// =============================================================================
// Phase 1: Connect Tools
// =============================================================================

server.registerTool(
  "indexfoundry_connect_url",
  {
    title: "Fetch URL",
    description: `Fetch a single URL and store it as a raw artifact.

Downloads content from any URL with content-type detection and optional domain allowlist.
Stores the result in runs/<run_id>/raw/<sha256>.<ext> with full audit trail.

Args:
  - run_id: UUID of the run directory
  - url: URL to fetch
  - allowed_domains: Optional domain allowlist
  - timeout_ms: Request timeout (default: 30000)
  - headers: Optional custom HTTP headers
  - force: Re-fetch even if content exists (default: false)

Returns:
  - success: boolean
  - artifact: { path, sha256, size_bytes, content_type, fetched_at }
  - skipped: true if already fetched and !force

Idempotent: Yes - skips if content hash matches existing artifact.`,
    inputSchema: ConnectUrlInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handleConnectUrl
);

server.registerTool(
  "indexfoundry_connect_sitemap",
  {
    title: "Crawl Sitemap",
    description: `Crawl a sitemap and fetch all matching URLs.

Parses sitemap XML and fetches pages matching include/exclude patterns.
Respects max_pages limit and processes URLs deterministically (sorted order).

Args:
  - run_id: UUID of the run directory
  - sitemap_url: URL to sitemap XML
  - max_pages: Maximum pages to fetch (default: 100)
  - include_patterns: Regex patterns for URLs to include
  - exclude_patterns: Regex patterns for URLs to exclude
  - concurrency: Parallel fetch count (default: 3)
  - force: Re-fetch all (default: false)

Returns:
  - urls_discovered, urls_fetched, urls_skipped, urls_failed
  - artifacts: Array of { url, path, sha256 }
  - errors: Array of { url, error }`,
    inputSchema: ConnectSitemapInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handleConnectSitemap
);

server.registerTool(
  "indexfoundry_connect_folder",
  {
    title: "Load Folder",
    description: `Load local files from a folder into the run scope.

Copies files matching glob pattern to runs/<run_id>/raw/ with hash-based naming.
Files are sorted deterministically before processing.

Args:
  - run_id: UUID of the run directory
  - path: Absolute path to source folder
  - glob: File pattern (default: "**/*")
  - exclude_patterns: Patterns to exclude
  - max_file_size_mb: Skip files larger than this (default: 50)
  - force: Re-copy all (default: false)`,
    inputSchema: ConnectFolderInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  handleConnectFolder
);

server.registerTool(
  "indexfoundry_connect_pdf",
  {
    title: "Fetch PDF",
    description: `Fetch a PDF with specialized metadata extraction.

Downloads PDF from URL or copies from local path. Extracts PDF-specific
metadata (page count, version, author, etc.) for later use.

Args:
  - run_id: UUID of the run directory
  - source: URL or local file path
  - force: Re-fetch (default: false)

Returns:
  - artifact with PDF metadata: page_count, pdf_version, has_ocr_layer, etc.`,
    inputSchema: ConnectPdfInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handleConnectPdf
);

// =============================================================================
// Phase 2: Extract Tools
// =============================================================================

server.registerTool(
  "indexfoundry_extract_pdf",
  {
    title: "Extract PDF Text",
    description: `Convert PDF pages to text using a pinned extractor.

Uses pdfminer.six (version pinned in config) for deterministic text extraction.
Supports layout mode (preserves columns), plain mode, or OCR fallback.

Args:
  - run_id: UUID of the run directory
  - pdf_path: Path to PDF in raw/ directory
  - mode: "layout" | "plain" | "ocr" (default: "layout")
  - page_range: Optional { start, end } for partial extraction
  - ocr_language: Tesseract language code (default: "eng")
  - force: Re-extract (default: false)

Output artifacts:
  - extracted/<hash>.pages.jsonl: One record per page { page, text, char_count, ... }
  - extracted/<hash>.txt: Optional full concatenation
  - extraction_report.json: Stats and warnings`,
    inputSchema: ExtractPdfInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  handleExtractPdf
);

server.registerTool(
  "indexfoundry_extract_html",
  {
    title: "Extract HTML Text",
    description: `Strip HTML to clean text with configurable preservation.

Removes boilerplate (scripts, navigation) and optionally preserves
headings as markdown, links, and tables.

Args:
  - run_id: UUID of the run directory
  - html_path: Path to HTML in raw/ directory
  - preserve_headings: Keep as # ## ### (default: true)
  - preserve_links: Keep [text](url) format (default: false)
  - preserve_tables: Convert to markdown tables (default: true)
  - remove_selectors: CSS selectors to remove
  - force: Re-extract (default: false)`,
    inputSchema: ExtractHtmlInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  handleExtractHtml
);

server.registerTool(
  "indexfoundry_extract_document",
  {
    title: "Extract Document Text",
    description: `Extract text from various document formats.

Handles markdown, docx, txt, csv, json with format auto-detection.
For CSV, provides a text preview of configurable row count.

Args:
  - run_id: UUID of the run directory
  - doc_path: Path to document in raw/ directory
  - format_hint: Override detection (default: "auto")
  - csv_preview_rows: Rows for CSV preview (default: 100)
  - force: Re-extract (default: false)`,
    inputSchema: ExtractDocumentInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  handleExtractDocument
);

// =============================================================================
// Phase 3: Normalize Tools
// =============================================================================

server.registerTool(
  "indexfoundry_normalize_chunk",
  {
    title: "Chunk Text",
    description: `Split extracted text into semantic chunks.

Uses deterministic chunking with configurable strategy. Recursive strategy
(recommended) splits by paragraph, then sentence, then word as needed.

Args:
  - run_id: UUID of the run directory
  - input_paths: Paths to extracted text files
  - strategy: "recursive" | "by_paragraph" | "by_heading" | etc.
  - max_chars: Maximum chunk size (default: 1500)
  - min_chars: Minimum chunk size (default: 100)
  - overlap_chars: Overlap between chunks (default: 150)
  - split_hierarchy: Separators for recursive splitting
  - force: Re-chunk (default: false)

Output: normalized/chunks.jsonl with DocumentChunk records`,
    inputSchema: NormalizeChunkInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  handleNormalizeChunk
);

server.registerTool(
  "indexfoundry_normalize_enrich",
  {
    title: "Enrich Metadata",
    description: `Add metadata to chunks using rule-based enrichment.

NO LLM used - purely deterministic regex and rule-based extraction.
Detects language, extracts tags via patterns, applies taxonomy mapping.

Args:
  - run_id: UUID of the run directory
  - chunks_path: Path to chunks.jsonl
  - rules: {
      detect_language: boolean,
      regex_tags: [{ pattern, tag_name, flags }],
      section_patterns: [{ pattern, section_name }],
      extract_dates: boolean,
      taxonomy: { category: [keywords] }
    }
  - force: Re-enrich (default: false)`,
    inputSchema: NormalizeEnrichInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  handleNormalizeEnrich
);

server.registerTool(
  "indexfoundry_normalize_dedupe",
  {
    title: "Deduplicate Chunks",
    description: `Remove duplicate chunks using content hashing.

Supports exact hash matching or fuzzy matching (simhash/minhash).
Can dedupe globally or within each document.

Args:
  - run_id: UUID of the run directory
  - chunks_path: Path to chunks.jsonl
  - method: "exact" | "simhash" | "minhash" (default: "exact")
  - similarity_threshold: For fuzzy matching (default: 0.95)
  - scope: "global" | "per_document" (default: "global")
  - force: Re-dedupe (default: false)

Output: dedupe_report.json with duplicate groups and removal stats`,
    inputSchema: NormalizeDedupeInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  handleNormalizeDedupe
);

// =============================================================================
// Phase 4: Index Tools
// =============================================================================

server.registerTool(
  "indexfoundry_index_embed",
  {
    title: "Generate Embeddings",
    description: `Generate vector embeddings for all chunks.

Uses a pinned embedding model for reproducibility. Supports OpenAI,
Cohere, Sentence Transformers, or local models.

Args:
  - run_id: UUID of the run directory
  - chunks_path: Path to chunks.jsonl
  - model: { provider, model_name, dimensions?, api_key_env }
  - batch_size: Chunks per API call (default: 100)
  - normalize_vectors: L2 normalize (default: true)
  - retry_config: { max_retries, backoff_ms }
  - force: Re-embed (default: false)

Output: indexed/embeddings.jsonl with { chunk_id, vector, model, dimensions }`,
    inputSchema: IndexEmbedInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handleIndexEmbed
);

server.registerTool(
  "indexfoundry_index_upsert",
  {
    title: "Upsert to Vector DB",
    description: `Upsert embeddings to a vector database.

Supports Milvus, Pinecone, Weaviate, Qdrant, Chroma, or local storage.
Configurable metadata fields and batch size.

Args:
  - run_id: UUID of the run directory
  - embeddings_path: Path to embeddings.jsonl
  - chunks_path: Path to chunks.jsonl (for metadata)
  - provider: Vector DB type
  - connection: { host, port, api_key_env, collection, namespace }
  - metadata_fields: Chunk fields to store as metadata
  - store_text: Include chunk text in metadata (default: true)
  - upsert_mode: "insert" | "upsert" | "replace"
  - batch_size: Vectors per batch (default: 100)
  - force: Re-upsert (default: false)

Output: upsert_stats.json with counts and timing`,
    inputSchema: IndexUpsertInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handleIndexUpsert
);

server.registerTool(
  "indexfoundry_index_build_profile",
  {
    title: "Build Retrieval Profile",
    description: `Define retrieval parameters and allowed filters.

Creates a profile for the query layer with search modes, hybrid config,
reranker settings, and filterable metadata fields.

Args:
  - run_id: UUID of the run directory
  - retrieval_config: { default_top_k, search_modes, hybrid_config, reranker }
  - allowed_filters: [{ field, operators }]
  - security: { require_auth, allowed_namespaces }

Output: served/retrieval_profile.json`,
    inputSchema: IndexBuildProfileInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  handleIndexBuildProfile
);

// =============================================================================
// Phase 5: Serve Tools
// =============================================================================

server.registerTool(
  "indexfoundry_serve_openapi",
  {
    title: "Generate OpenAPI Spec",
    description: `Generate OpenAPI specification for the retrieval API.

Creates a complete OpenAPI 3.0 spec with endpoints for semantic search,
hybrid search, document/chunk retrieval, health, and stats.

Args:
  - run_id: UUID of the run directory
  - api_info: { title, version, description, base_path }
  - endpoints: Which endpoints to include
  - include_schemas: Include request/response schemas (default: true)

Output: served/openapi.json`,
    inputSchema: ServeOpenapiInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  handleServeOpenapi
);

server.registerTool(
  "indexfoundry_serve_start",
  {
    title: "Start API Server",
    description: `Start the retrieval API server.

Launches an HTTP server exposing the endpoints defined in the OpenAPI spec.
Includes optional CORS, rate limiting, and request logging.

Args:
  - run_id: UUID of the run directory
  - host: Bind address (default: "127.0.0.1")
  - port: Port number (default: 8080)
  - cors_origins: Allowed CORS origins
  - rate_limit: { requests_per_minute, burst }
  - log_requests: Log all requests (default: true)

Returns: Server URL and status`,
    inputSchema: ServeStartInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handleServeStart
);

// =============================================================================
// Pipeline Tools
// =============================================================================

server.registerTool(
  "indexfoundry_pipeline_run",
  {
    title: "Run Full Pipeline",
    description: `Execute the complete ingestion pipeline end-to-end.

Runs all phases (Connect → Extract → Normalize → Index → Serve) with
a single configuration. Each phase produces artifacts and can be resumed.

Args:
  - run_id: Optional UUID (auto-generated if not provided)
  - connect: { sources, allowed_domains }
  - extract: { pdf_mode, preserve_headings }
  - normalize: { chunk_strategy, max_chars, overlap_chars, dedupe, detect_language }
  - index: { embedding_model, vector_db: { provider, collection, connection } }
  - serve: { auto_start, port }
  - force: Force all phases (default: false)
  - stop_on_error: Halt on first error (default: true)

Returns:
  - run_id, status, manifest_path
  - phases: { connect, extract, normalize, index, serve } with status each
  - summary: { sources_fetched, chunks_indexed, duration_ms, errors }`,
    inputSchema: PipelineRunInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handlePipelineRun
);

server.registerTool(
  "indexfoundry_run_status",
  {
    title: "Get Run Status",
    description: `Get the current status of a pipeline run.

Returns the manifest with phase statuses, timing, and error summary.`,
    inputSchema: RunStatusInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  handleRunStatus
);

server.registerTool(
  "indexfoundry_run_list",
  {
    title: "List Runs",
    description: `List all pipeline runs with optional filtering.

Filter by status and date range. Returns sorted list of run summaries.`,
    inputSchema: RunListInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  handleRunList
);

server.registerTool(
  "indexfoundry_run_diff",
  {
    title: "Compare Runs",
    description: `Compare two runs to see what changed.

Shows differences in sources, chunks, and indexed vectors between runs.
Useful for detecting content drift or validating pipeline changes.`,
    inputSchema: RunDiffInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  handleRunDiff
);

server.registerTool(
  "indexfoundry_run_cleanup",
  {
    title: "Cleanup Old Runs",
    description: `Remove old runs to free disk space.

Deletes run directories older than specified days. Can optionally
keep manifests for audit trail while removing artifacts.

Use dry_run=true to preview what would be deleted.`,
    inputSchema: RunCleanupInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  handleRunCleanup
);

// =============================================================================
// Server Transport
// =============================================================================

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

async function runHTTP(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  
  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION });
  });
  
  // MCP endpoint
  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  
  const port = parseInt(process.env.PORT ?? "3000");
  app.listen(port, () => {
    console.error(`${SERVER_NAME} v${SERVER_VERSION} running on http://localhost:${port}/mcp`);
  });
}

// Choose transport based on environment
const transport = process.env.TRANSPORT ?? "stdio";
if (transport === "http") {
  runHTTP().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
} else {
  runStdio().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
  });
}
