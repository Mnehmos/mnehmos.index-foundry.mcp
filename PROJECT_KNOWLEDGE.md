# IndexFoundry-MCP - Knowledge Base Document

## Quick Reference

| Property | Value |
|----------|-------|
| **Repository** | https://github.com/Mnehmos/mnehmos.index-foundry.mcp |
| **Primary Language** | TypeScript |
| **Project Type** | MCP Server |
| **Status** | Active |
| **Last Updated** | 2026-01-10 |

## Overview

IndexFoundry-MCP is a deterministic vector index factory that provides MCP tools for building, managing, and deploying production-ready RAG (Retrieval-Augmented Generation) applications. It transforms raw content from URLs, PDFs, sitemaps, and local folders into searchable vector databases with full auditability and reproducibility guarantees. The server supports both fine-grained run-based pipelines for experimentation and project-based workflows that generate deployable repositories with Docker, Railway configuration, and chat interfaces.

## Architecture

### System Design

IndexFoundry implements two complementary architectural patterns:

1. **Run-Based Pipeline**: A five-phase deterministic pipeline (Connect → Extract → Normalize → Index → Serve) where each run produces isolated, auditable artifacts with content hashes and manifests. Ideal for experimentation and detailed debugging.

2. **Project-Based Workflow**: A higher-level abstraction that manages multi-source RAG applications as self-contained deployable repositories. Each project generates a complete MCP server, Dockerfile, Railway configuration, and chat UI ready for production deployment.

The server connects to MCP clients via stdio transport and exposes 35+ tools across five pipeline phases plus project management, classification, table extraction, and debugging capabilities. All operations are idempotent with SHA256 content hashing ensuring reproducible builds.

### Key Components

| Component | Purpose | Location |
|-----------|---------|----------|
| Main Server | MCP server initialization and tool registration | `src/index.ts` |
| Run Manager | Manages pipeline runs, manifests, and artifacts | `src/run-manager.ts` |
| Project Manager | High-level project lifecycle and deployment | `src/tools/projects.ts` |
| Connect Tools | Fetch content from URLs, sitemaps, PDFs, folders | `src/tools/connect.ts` |
| Extract Tools | Extract text from PDFs, HTML, documents | `src/tools/extract.ts` |
| Normalize Tools | Chunking, enrichment, deduplication | `src/tools/normalize.ts` |
| Index Tools | Embedding generation and vector upsert | `src/tools/index.ts` |
| Serve Tools | API server generation and query endpoints | `src/tools/serve.ts` |
| Classification Tools | Query intent classification for retrieval | `src/tools/classify.ts` |
| Table Tools | Table extraction and linearization | `src/tools/tables.ts` |
| Debug Tools | Retrieval debugging and similarity tracing | `src/tools/debug.ts` |
| Binary Handler | Content type detection and extraction | `src/tools/binary-handler.ts` |
| Schemas | Zod schemas for input validation | `src/schemas.ts`, `src/schemas-projects.ts` |
| Types | TypeScript type definitions | `src/types.ts` |
| Utilities | File I/O, hashing, JSON operations | `src/utils.ts` |

### Data Flow

```
PROJECT-BASED WORKFLOW:
User → project_create → Project Directory Created
     → project_add_source (1..N times) → Sources Queued
     → project_build → Fetch → Extract → Chunk → Embed → Upsert → data/chunks.jsonl + vectors.jsonl
     → project_query → Semantic/Keyword/Hybrid Search → Ranked Results
     → project_export → Generate MCP Server + Dockerfile + Railway Config
     → project_serve → Local Dev Server → Test Chat UI
     → project_deploy → Railway Production Deployment

RUN-BASED PIPELINE:
User → connect_* tools → raw/ artifacts (content hashed)
     → extract_* tools → extracted/ JSONL files
     → normalize_chunk → normalized/ chunks with IDs
     → normalize_enrich → metadata enrichment
     → normalize_dedupe → duplicate removal
     → index_embed → indexed/ vectors with embeddings
     → index_upsert → Vector DB (Pinecone/Weaviate/Qdrant/local)
     → serve_start → HTTP API Server
     → serve_query → Search Results
```

## API Surface

### Public Interfaces

#### Project Lifecycle Tools

##### Tool: `indexfoundry_project_create`
- **Purpose**: Create a new RAG project with embedding and chunking configuration
- **Parameters**:
  - `project_id` (string): Unique identifier for the project
  - `name` (string): Human-readable project name
  - `description` (string, optional): Project description
  - `embedding_model` (object): Embedding provider configuration
    - `provider` ("openai" | "cohere" | "sentence-transformers" | "local")
    - `model_name` (string): Model identifier (e.g., "text-embedding-3-small")
    - `api_key_env` (string): Environment variable name for API key
  - `chunk_config` (object): Chunking strategy
    - `strategy` ("recursive" | "hierarchical" | "paragraph" | "heading" | "page" | "sentence" | "fixed")
    - `max_chars` (number): Maximum characters per chunk
    - `overlap_chars` (number): Character overlap between chunks
- **Returns**: `{ success: true, project_id, path, manifest }`

##### Tool: `indexfoundry_project_add_source`
- **Purpose**: Add a content source to a project (URL, sitemap, folder, or PDF)
- **Parameters**:
  - `project_id` (string): Target project
  - `url` (string, optional): Single webpage URL
  - `sitemap_url` (string, optional): Sitemap XML URL
  - `folder_path` (string, optional): Local folder path
  - `pdf_path` (string, optional): PDF file path or URL
  - `source_name` (string, optional): Human-readable source name
  - `tags` (string[], optional): Tags for filtering
  - `glob` (string, optional): Glob pattern for folder sources
- **Returns**: `{ success: true, source_id, source_type }`

##### Tool: `indexfoundry_project_build`
- **Purpose**: Process all pending sources (fetch → chunk → embed → upsert)
- **Parameters**:
  - `project_id` (string): Target project
  - `force` (boolean, optional): Force rebuild of processed sources
  - `dry_run` (boolean, optional): Preview without executing
- **Returns**: `{ success: true, metrics: { chunks_created, vectors_created, tokens_used, estimated_cost_usd, sources_processed } }`

##### Tool: `indexfoundry_project_query`
- **Purpose**: Search the project's vector database
- **Parameters**:
  - `project_id` (string): Target project
  - `query` (string): Search query text
  - `mode` ("semantic" | "keyword" | "hybrid"): Search mode
  - `top_k` (number, optional): Number of results to return (default: 5)
  - `filter_tags` (string[], optional): Filter by source tags
  - `include_text` (boolean, optional): Include chunk text in results
- **Returns**: `{ results: [{ chunk_id, score, text, source_id, metadata }], mode, took_ms }`

##### Tool: `indexfoundry_project_export`
- **Purpose**: Generate deployment files (MCP server, Dockerfile, Railway config)
- **Parameters**:
  - `project_id` (string): Target project
  - `server_name` (string, optional): Generated server name
  - `server_description` (string, optional): Server description
  - `include_http` (boolean, optional): Include HTTP endpoints
  - `railway_config` (boolean, optional): Generate railway.toml
- **Returns**: `{ success: true, files_generated: string[], deployment_instructions }`

##### Tool: `indexfoundry_project_serve`
- **Purpose**: Start local development server for testing
- **Parameters**:
  - `project_id` (string): Target project
  - `port` (number, optional): HTTP port (default: 8080)
  - `mode` ("dev" | "build", optional): Development mode with hot reload or production build
  - `open_browser` (boolean, optional): Open frontend in browser
- **Returns**: `{ success: true, endpoint: string, pid: number, port, mode }`

##### Tool: `indexfoundry_project_list`
- **Purpose**: List all projects with optional statistics
- **Parameters**:
  - `include_stats` (boolean, optional): Include chunk/vector counts
- **Returns**: `{ projects: [{ project_id, name, created_at, stats? }] }`

##### Tool: `indexfoundry_project_get`
- **Purpose**: Get detailed project information
- **Parameters**:
  - `project_id` (string): Target project
- **Returns**: `{ manifest, sources: SourceRecord[], path }`

##### Tool: `indexfoundry_project_delete`
- **Purpose**: Delete a project and all its data
- **Parameters**:
  - `project_id` (string): Target project
  - `confirm` (boolean): Safety confirmation (must be true)
- **Returns**: `{ success: true, deleted_path }`

##### Tool: `indexfoundry_project_deploy`
- **Purpose**: Deploy project to Railway
- **Parameters**:
  - `project_id` (string): Target project
  - `dry_run` (boolean, optional): Preview commands without executing
- **Returns**: `{ success: true, deployment_url, commands_executed }`

##### Tool: `indexfoundry_project_serve_stop`
- **Purpose**: Stop a running development server
- **Parameters**:
  - `project_id` (string): Target project
  - `force` (boolean, optional): Force kill if graceful shutdown fails
- **Returns**: `{ success: true, pid, uptime_seconds }`

##### Tool: `indexfoundry_project_serve_status`
- **Purpose**: Get status of running project servers
- **Parameters**:
  - `project_id` (string, optional): Specific project or all projects if omitted
- **Returns**: `{ servers: [{ project_id, endpoint, pid, port, mode, uptime_seconds }] }`

#### Run-Based Pipeline Tools

##### Phase 1: Connect Tools

**`indexfoundry_connect_url`**
- **Purpose**: Fetch a single URL and store raw content
- **Parameters**: `run_id`, `url`, `allowed_domains?`, `timeout_ms?`
- **Returns**: Artifact path, content hash, status

**`indexfoundry_connect_sitemap`**
- **Purpose**: Crawl sitemap XML and fetch all linked pages
- **Parameters**: `run_id`, `sitemap_url`, `url_pattern?`, `max_urls?`
- **Returns**: Fetched URL count, artifacts, errors

**`indexfoundry_connect_folder`**
- **Purpose**: Load files from local folder using glob patterns
- **Parameters**: `run_id`, `path`, `glob`, `max_files?`
- **Returns**: File count, total bytes, artifact paths

**`indexfoundry_connect_pdf`**
- **Purpose**: Fetch PDF with specialized validation
- **Parameters**: `run_id`, `url_or_path`
- **Returns**: Artifact path, page count, metadata

##### Phase 2: Extract Tools

**`indexfoundry_extract_pdf`**
- **Purpose**: Extract text from PDF page-by-page
- **Parameters**: `run_id`, `pdf_path`, `mode` (layout/plain/OCR)
- **Returns**: JSONL output path, page count, extraction method

**`indexfoundry_extract_html`**
- **Purpose**: Extract clean text and structure from HTML
- **Parameters**: `run_id`, `html_path`, `output_format` (text/markdown)
- **Returns**: Extracted text, heading structure, table count

**`indexfoundry_extract_document`**
- **Purpose**: Generic document extraction (markdown, txt, CSV, JSON)
- **Parameters**: `run_id`, `document_path`
- **Returns**: Extracted text, detected encoding, line count

##### Phase 3: Normalize Tools

**`indexfoundry_normalize_chunk`**
- **Purpose**: Split text into semantic chunks with deterministic IDs
- **Parameters**: `run_id`, `input_paths`, `strategy`, `max_chars`, `overlap_chars`
- **Returns**: Chunk count, output JSONL path, average chunk size

**`indexfoundry_normalize_enrich`**
- **Purpose**: Enrich chunks with metadata (language, tags, sections)
- **Parameters**: `run_id`, `chunk_paths`, `enrichment_rules`
- **Returns**: Enriched chunk count, added metadata fields

**`indexfoundry_normalize_dedupe`**
- **Purpose**: Remove duplicate chunks by content hash or fuzzy similarity
- **Parameters**: `run_id`, `chunk_paths`, `method` (exact/simhash/minhash)
- **Returns**: Unique chunks, duplicates removed, deduplication method

##### Phase 4: Index Tools

**`indexfoundry_index_embed`**
- **Purpose**: Generate vector embeddings for chunks
- **Parameters**: `run_id`, `model: { provider, model_name, api_key_env }`
- **Returns**: Vector count, embedding dimensions, API cost estimate

**`indexfoundry_index_upsert`**
- **Purpose**: Upsert vectors to database
- **Parameters**: `run_id`, `provider` (local/pinecone/weaviate/qdrant/milvus/chroma), `connection`
- **Returns**: Upserted count, vector database collection

**`indexfoundry_index_build_profile`**
- **Purpose**: Define retrieval configuration
- **Parameters**: `run_id`, `top_k`, `hybrid_settings`, `reranking`
- **Returns**: Profile configuration, saved path

##### Phase 5: Serve Tools

**`indexfoundry_serve_start`**
- **Purpose**: Start HTTP search API server
- **Parameters**: `run_id`, `port`, `endpoints`
- **Returns**: Server URL, loaded vectors/chunks, startup time

**`indexfoundry_serve_query`**
- **Purpose**: Query running server directly
- **Parameters**: `run_id`, `query`, `mode` (semantic/keyword/hybrid), `top_k`
- **Returns**: Ranked results with scores, metadata, timing

**`indexfoundry_serve_stop`**, **`indexfoundry_serve_status`**, **`indexfoundry_serve_openapi`**
- Server lifecycle and documentation tools

#### Utility Tools

**`indexfoundry_run_status`** - Get run phase completion and timing
**`indexfoundry_run_list`** - List all runs with filtering
**`indexfoundry_run_diff`** - Compare two runs for config/chunk differences
**`indexfoundry_run_cleanup`** - Delete old runs with retention policies

#### Advanced Tools

**`indexfoundry_classify_query`** - Classify query type and retrieval needs
**`indexfoundry_extract_tables`** - Extract and linearize tables for RAG
**`indexfoundry_debug_query`** - Debug retrieval with similarity tracing

### Configuration

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `INDEXFOUNDRY_RUNS_DIR` | string | `./runs` | Directory for run-based pipeline artifacts |
| `OPENAI_API_KEY` | string | (required) | OpenAI API key for embeddings |
| `EMBEDDING_API_KEY` | string | (optional) | Generic API key for alternative embedding providers |
| `PORT` | number | `3000` | HTTP server port for MCP HTTP transport |
| `TRANSPORT` | string | `stdio` | MCP transport mode (stdio or http) |

## Usage Examples

### Basic Usage: Project-Based RAG Application

```typescript
// Create a RAG project for documentation search
await client.callTool("indexfoundry_project_create", {
  project_id: "my-docs-rag",
  name: "Documentation Search",
  description: "Searchable knowledge base for company docs",
  embedding_model: {
    provider: "openai",
    model_name: "text-embedding-3-small",
    api_key_env: "OPENAI_API_KEY"
  },
  chunk_config: {
    strategy: "hierarchical",
    max_chars: 1500,
    overlap_chars: 150
  }
});

// Add documentation website as source
await client.callTool("indexfoundry_project_add_source", {
  project_id: "my-docs-rag",
  url: "https://docs.example.com",
  source_name: "Main Documentation",
  tags: ["docs", "api"]
});

// Add PDF policy documents
await client.callTool("indexfoundry_project_add_source", {
  project_id: "my-docs-rag",
  folder_path: "/path/to/pdfs",
  source_name: "Policy Documents",
  tags: ["policy", "pdf"],
  glob: "**/*.pdf"
});

// Build the vector database (requires OPENAI_API_KEY)
await client.callTool("indexfoundry_project_build", {
  project_id: "my-docs-rag"
});
// Returns: { success: true, metrics: { chunks_created: 245, vectors_created: 245, tokens_used: 98234, estimated_cost_usd: 0.002 } }

// Query the index
await client.callTool("indexfoundry_project_query", {
  project_id: "my-docs-rag",
  query: "What is the vacation policy?",
  mode: "hybrid",
  top_k: 5,
  filter_tags: ["policy"]
});

// Export deployment files
await client.callTool("indexfoundry_project_export", {
  project_id: "my-docs-rag",
  server_name: "docs-search-server",
  include_http: true,
  railway_config: true
});

// Test locally before deploying
await client.callTool("indexfoundry_project_serve", {
  project_id: "my-docs-rag",
  port: 8080,
  mode: "dev",
  open_browser: true
});
```

### Advanced Patterns: Run-Based Pipeline

```typescript
// Fine-grained control over the pipeline for experimentation
const runId = crypto.randomUUID();

// Phase 1: Connect - Fetch PDF documentation
await client.callTool("indexfoundry_connect_folder", {
  run_id: runId,
  path: "/path/to/documents",
  glob: "**/*.pdf"
});

// Phase 2: Extract - PDF to text with layout preservation
await client.callTool("indexfoundry_extract_pdf", {
  run_id: runId,
  pdf_path: "raw/<sha256>.pdf",
  mode: "layout"
});

// Phase 3: Normalize - Hierarchical chunking with parent context
await client.callTool("indexfoundry_normalize_chunk", {
  run_id: runId,
  input_paths: ["extracted/<sha256>.pages.jsonl"],
  strategy: "hierarchical",
  max_chars: 1500,
  overlap_chars: 150
});

// Phase 3b: Enrich with language detection and tagging
await client.callTool("indexfoundry_normalize_enrich", {
  run_id: runId,
  chunk_paths: ["normalized/chunks.jsonl"],
  enrichment_rules: {
    detect_language: true,
    regex_tags: {
      "technical": "\\b(API|SDK|authentication)\\b"
    }
  }
});

// Phase 3c: Deduplicate
await client.callTool("indexfoundry_normalize_dedupe", {
  run_id: runId,
  chunk_paths: ["normalized/chunks_enriched.jsonl"],
  method: "simhash"
});

// Phase 4: Index - Generate embeddings
await client.callTool("indexfoundry_index_embed", {
  run_id: runId,
  model: {
    provider: "openai",
    model_name: "text-embedding-3-small",
    api_key_env: "OPENAI_API_KEY"
  }
});

// Phase 4b: Upsert to vector database
await client.callTool("indexfoundry_index_upsert", {
  run_id: runId,
  provider: "local",
  connection: { collection: "my_docs" }
});

// Phase 5: Serve - Start HTTP API
await client.callTool("indexfoundry_serve_start", {
  run_id: runId,
  port: 8080
});

// Query the running server
await client.callTool("indexfoundry_serve_query", {
  run_id: runId,
  query: "How do I configure authentication?",
  mode: "hybrid",
  top_k: 5
});

// Compare two runs for differences
await client.callTool("indexfoundry_run_diff", {
  run_id_a: runId,
  run_id_b: previousRunId,
  compare_config: true,
  compare_chunks: true,
  compare_timing: true
});
```

## Dependencies

### Runtime Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| @modelcontextprotocol/sdk | ^1.12.1 | MCP protocol implementation |
| cheerio | ^1.0.0 | HTML parsing and extraction |
| fast-xml-parser | ^4.5.1 | XML/sitemap parsing |
| franc-min | ^6.2.0 | Language detection |
| glob | ^11.0.0 | File pattern matching |
| openai | ^4.77.0 | OpenAI API client for embeddings |
| pdf-parse | ^1.1.1 | PDF text extraction |
| simhash-js | ^1.0.0 | Fuzzy deduplication |
| tesseract.js | ^7.0.0 | OCR for scanned PDFs |
| uuid | ^11.0.3 | UUID generation for run IDs |
| zod | ^3.24.1 | Schema validation |

### Development Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| @types/node | ^22.10.2 | Node.js type definitions |
| @types/pdf-parse | ^1.1.4 | PDF parser type definitions |
| @types/uuid | ^10.0.0 | UUID type definitions |
| pdf-lib | ^1.17.1 | PDF manipulation for tests |
| rimraf | ^6.0.1 | Cross-platform rm -rf |
| tsx | ^4.19.2 | TypeScript execution for development |
| typescript | ^5.7.2 | TypeScript compiler |
| vitest | ^2.1.8 | Unit testing framework |

## Operational Protocols

### The Librarian Protocol: Active Data Curation

**Reference:** [`ADR-007-LIBRARIAN-PROTOCOL.md`](./Docs/ADR-007-LIBRARIAN-PROTOCOL.md) | [`LIBRARIAN-EXAMPLES.md`](./Docs/LIBRARIAN-EXAMPLES.md)

The **Librarian Protocol** is an operational workflow layer for IndexFoundry that adds **state verification** and **self-correction** capabilities. It is **not a new mode**—it is a documented protocol pattern that orchestrates IndexFoundry's existing tools in a deterministic, auditable manner.

#### Key Principles

1. **"Reason Over State"**: Always audit project manifest before querying or serving
2. **Query Classification**: Determine if RAG retrieval is needed
3. **Retrieval Validation**: Verify chunk quality before trusting results
4. **Self-Correction**: Automatically repair poor retrieval through re-chunking or re-indexing
5. **Deployment Safety**: Full pre-flight checks before exporting/serving

#### Librarian Workflow

```
User Request → Manifest Audit → Query Classification → Retrieve →
Validate Quality → [Valid: Return] OR [Invalid: Debug/Repair] → Final Response
```

#### Core Protocols

| Protocol | Purpose | Tools Used |
|----------|---------|-----------|
| **State Check** | Verify project manifest, sources, chunks, vectors | `project_get` |
| **Intent Classification** | Determine if query needs RAG | `classify_query` |
| **Retrieval** | Search with adaptive mode | `project_query` |
| **Quality Validation** | Check similarity scores | `debug_query` (if marginal) |
| **Self-Repair** | Re-chunk, remove sources, rebuild | `project_remove_source`, `project_build` |
| **Pre-Flight Checks** | Validate before deployment | `project_get`, `project_query` (test) |

#### Example: Query with Full Audit

```typescript
// 1. Audit manifest (is index fresh?)
const project = await indexfoundry_project_get({ project_id });

// 2. Classify query (does it need RAG?)
const classification = await indexfoundry_classify_query({ query });

// 3. Retrieve (if needed)
if (classification.needs_retrieval) {
  const results = await indexfoundry_project_query({
    project_id, query, mode: "hybrid"
  });
  
  // 4. Validate scores (are they trustworthy?)
  const avgScore = results.reduce((s) => s.score) / results.length;
  if (avgScore < 0.65) {
    // 5. Debug if low quality
    const debug = await indexfoundry_debug_query({ query });
    // Consider re-chunking or repair
  }
}

// 6. Return answer with audit trail and metadata
return { answer, audit: { checks, scores, sources } };
```

#### When to Use Librarian Patterns

| Scenario | Pattern | Benefit |
|----------|---------|---------|
| Novice users | Use full Librarian workflow | Safe defaults, automatic repair |
| Production deployments | Pre-flight checks | Validates index state before shipping |
| Low retrieval scores | Debug + repair | Automatic quality improvement |
| Long-running projects | Periodic state audit | Detects stale data, triggers rebuilds |
| Multi-source projects | Batch management + repair | Handles failures gracefully |

#### Example Projects Using Librarian Patterns

- [`queryWithAudit()`](./Docs/LIBRARIAN-EXAMPLES.md#example-1-query-with-full-audit-trail) - Full query lifecycle with state validation
- [`debugAndRepair()`](./Docs/LIBRARIAN-EXAMPLES.md#example-2-retrieval-debugging--re-chunking) - Auto-recovery for poor retrieval
- [`deploymentPreFlight()`](./Docs/LIBRARIAN-EXAMPLES.md#example-3-deployment-pre-flight-check) - Pre-deployment validation
- [`manageBatchSources()`](./Docs/LIBRARIAN-EXAMPLES.md#example-4-batch-source-management-with-repair) - Bulk operations with error recovery

#### Score Thresholds

| Metric | Threshold | Action |
|--------|-----------|--------|
| Min chunk score | 0.50 | Below = likely irrelevant |
| Avg result score | 0.65 | Below = consider repair |
| Classification confidence | 0.50 | Below = unclear intent |

#### Documentation

- **Full Specification**: [`ADR-007-LIBRARIAN-PROTOCOL.md`](./Docs/ADR-007-LIBRARIAN-PROTOCOL.md) - Complete protocol definition
- **Workflow Examples**: [`LIBRARIAN-EXAMPLES.md`](./Docs/LIBRARIAN-EXAMPLES.md) - Step-by-step implementations
- **Analysis**: [`MODE-COMPARISON-ANALYSIS.md`](./Docs/MODE-COMPARISON-ANALYSIS.md) - Design rationale

---

## Integration Points

### Works With

| Project | Integration Type | Description |
|---------|-----------------|-------------|
| mnehmos.ooda.mcp | Peer | OODA loop MCP server can consume IndexFoundry projects for knowledge retrieval in decision-making workflows |
| mnehmos.multi-agent.framework | Dependency | Multi-agent framework uses IndexFoundry for RAG-enabled agent memory and context retrieval |
| mnehmos.synch.mcp | Peer | Synch can trigger IndexFoundry rebuilds when documentation sources are updated |

### External Services

| Service | Purpose | Required |
|---------|---------|----------|
| OpenAI API | Generate text embeddings (text-embedding-3-small, text-embedding-3-large) | Yes (for embedding generation) |
| Cohere API | Alternative embedding provider | No (optional) |
| Pinecone | Cloud vector database | No (optional, supports local storage) |
| Weaviate | Open-source vector database | No (optional) |
| Qdrant | Vector search engine | No (optional) |
| Milvus | Vector database for AI applications | No (optional) |
| Chroma | Embedding database | No (optional) |
| Railway | Production deployment platform | No (optional, for project_deploy) |

## Development Guide

### Prerequisites

- Node.js >=20.0.0
- npm or equivalent package manager
- OpenAI API key (for embedding generation)
- Git for version control

### Setup

```bash
# Clone the repository
git clone https://github.com/Mnehmos/mnehmos.index-foundry.mcp
cd mnehmos.index-foundry.mcp

# Install dependencies
npm install

# Build TypeScript
npm run build

# Set up environment variables
echo "OPENAI_API_KEY=sk-..." > .env
```

### Running Locally

```bash
# Development mode with hot reload
npm run dev

# Build for production
npm run build

# Run production server (stdio transport for MCP clients)
npm start

# Run with HTTP transport (for testing with curl/Postman)
PORT=3000 TRANSPORT=http npm start
```

### Testing

```bash
# Run all tests
npm test

# Run specific test suites
npm test -- hierarchical-chunking.test.ts
npm test -- hybrid-search-chat.test.ts
npm test -- query-classification.test.ts

# Run tests with coverage
npm test -- --coverage

# Test MCP server with Inspector
npx @modelcontextprotocol/inspector npm start
```

### Building

```bash
# Build TypeScript to JavaScript
npm run build

# Clean build artifacts
npm run clean

# Build output location
# dist/
```

## Maintenance Notes

### Known Issues

1. **Windows Path Handling**: Template copying uses `xcopy` which requires Windows. Cross-platform path handling could be improved for macOS/Linux development.
2. **Large PDF Memory**: PDFs over 50MB may cause memory pressure during OCR extraction with Tesseract.js.
3. **Rate Limiting**: OpenAI embedding API rate limits are not automatically handled; users must manage batch sizes manually.

### Future Considerations

1. **Streaming Embeddings**: Add support for streaming large batches to reduce memory footprint.
2. **Multi-Modal Support**: Extend extraction to handle images, audio transcripts, and video captions.
3. **Incremental Indexing**: Implement change detection to avoid re-embedding unchanged content.
4. **BM25 Reranking**: Add BM25 scoring as an alternative to semantic reranking.
5. **Custom Chunking Strategies**: Allow users to provide custom chunking functions via JavaScript modules.
6. **Graph-Based Retrieval**: Extend hierarchical chunking to build knowledge graphs for reasoning.

### Code Quality

| Metric | Status |
|--------|--------|
| Tests | Yes with Vitest - coverage for chunking, search, classification, table extraction |
| Linting | ESLint configured for TypeScript |
| Type Safety | TypeScript strict mode enabled |
| Documentation | JSDoc comments on all public functions, detailed README |

---

## Appendix: File Structure

```
mnehmos.index-foundry.mcp/
├── src/
│   ├── index.ts                  # Main MCP server entry point and tool registration
│   ├── run-manager.ts            # Run-based pipeline orchestration and manifest tracking
│   ├── schemas.ts                # Zod schemas for run-based tools (connect, extract, normalize, index, serve)
│   ├── schemas-projects.ts       # Zod schemas for project-based tools (create, build, query, export)
│   ├── types.ts                  # TypeScript type definitions (DocumentChunk, RunManifest, PhaseManifest)
│   ├── utils.ts                  # File I/O, hashing (SHA256), JSONL operations, error handling
│   └── tools/
│       ├── connect.ts            # Phase 1: URL, sitemap, folder, PDF fetching
│       ├── extract.ts            # Phase 2: PDF, HTML, document text extraction
│       ├── normalize.ts          # Phase 3: Chunking (recursive, hierarchical, etc.), enrichment, deduplication
│       ├── index.ts              # Phase 4: Embedding generation (OpenAI, Cohere), vector upsert
│       ├── serve.ts              # Phase 5: HTTP server, query endpoints, OpenAPI spec generation
│       ├── utilities.ts          # Run utilities: status, list, diff, cleanup
│       ├── projects.ts           # Project lifecycle: create, add source, build, query, export, serve, deploy
│       ├── classify.ts           # Query classification (factual, procedural, conceptual, etc.)
│       ├── tables.ts             # Table extraction and linearization for RAG
│       ├── debug.ts              # Retrieval debugging with similarity tracing
│       ├── binary-handler.ts     # Content type detection and binary file handling
│       └── hydrate.ts            # Context hydration (parent chunk retrieval)
├── tests/
│   ├── hierarchical-chunking.test.ts    # Tests for hierarchical chunking with parent-child relationships
│   ├── hybrid-search-chat.test.ts       # Tests for hybrid search (keyword + semantic + RRF fusion)
│   ├── query-classification.test.ts     # Tests for query intent classification
│   ├── table-processing.test.ts         # Tests for table extraction and linearization
│   ├── context-expansion.test.ts        # Tests for parent context hydration
│   ├── retrieval-debug.test.ts          # Tests for similarity debugging
│   └── binary-handler.test.ts           # Tests for binary file detection and handling
├── projects/                      # Generated RAG projects (each is a deployable repository)
│   ├── dnd-chatbot/              # Example: D&D rules chatbot
│   ├── rural-az-automation/      # Example: Rural AZ documentation search
│   ├── graham-chamber-demo/      # Example: Graham Chamber commerce search
│   └── mnehmos-screen-vision/    # Example: Screen vision documentation
├── Docs/                          # Documentation and examples (legacy, being phased out)
├── package.json                   # NPM package manifest with dependencies and scripts
├── tsconfig.json                  # TypeScript compiler configuration (strict mode, ESM, Node 20)
├── vitest.config.ts               # Vitest testing framework configuration
├── README.md                      # User-facing documentation with architecture and usage examples
└── PROJECT_KNOWLEDGE.md           # This document
```

---

*Generated by Project Review Orchestrator | 2025-12-29*
*Source: https://github.com/Mnehmos/mnehmos.index-foundry.mcp*
