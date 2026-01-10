# IndexFoundry-MCP

**Deterministic Vector Index Factory** - An MCP server for automated, auditable vector database creation from any content source, with deployable project-based workflows.

> Tools don't think, they act.

Every tool in this server is:
- **Deterministic**: Same inputs → same outputs
- **Idempotent**: Re-running produces identical artifacts (unless `force: true`)
- **Auditable**: Every operation produces manifests, hashes, and logs
- **Composable**: Tools can be run independently or chained

## Architecture

IndexFoundry provides two complementary workflows:

### 1. Run-Based Pipeline (Fine-Grained Control)
Individual pipeline runs with isolated artifacts, suitable for experimentation and detailed auditing.

### 2. Project-Based Workflow (Deployable RAG Applications)
Self-contained projects that generate deployment-ready repositories with MCP server, Dockerfile, and Railway configuration.

## Pipeline Phases (Run-Based)

```
Connect → Extract → Normalize → Index → Serve
   ↓         ↓          ↓          ↓       ↓
  raw/    extracted/  normalized/  indexed/  served/
```

### Phase 1: Connect
Fetch content from URLs, sitemaps, folders, or PDFs. Every artifact gets a content hash.

### Phase 2: Extract
Convert raw bytes to text using pinned extractors (pdfminer, cheerio, etc.).

### Phase 3: Normalize
Chunk text deterministically, enrich metadata (no LLM), and deduplicate.

### Phase 4: Index
Generate embeddings with a pinned model, upsert to vector DB.

### Phase 5: Serve
Generate OpenAPI spec and optionally start a retrieval API.

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Run on stdio (for Claude Desktop, Cline, etc.)
npm start

# Run as HTTP server
npm run start:http
```

## Workflow Options

### Option 1: Run-Based Pipeline (Detailed Control)

Use individual pipeline tools for fine-grained control over each phase:

```typescript
// Create a new run
const runId = crypto.randomUUID();
await client.callTool("indexfoundry_connect_folder", {
  run_id: runId,
  path: "/path/to/documents",
  glob: "**/*.pdf"
});

// Extract PDF content
await client.callTool("indexfoundry_extract_pdf", {
  run_id: runId,
  pdf_path: "raw/<sha256>.pdf",
  mode: "layout"
});

// Chunk: text
await client.callTool("indexfoundry_normalize_chunk", {
  run_id: runId,
  input_paths: ["extracted/<sha256>.pages.jsonl"],
  strategy: "recursive",
  max_chars: 1500,
  overlap_chars: 150
});

// Generate embeddings
await client.callTool("indexfoundry_index_embed", {
  run_id: runId,
  model: {
    provider: "openai",
    model_name: "text-embedding-3-small",
    api_key_env: "OPENAI_API_KEY"
  }
});

// Upsert to vector DB
await client.callTool("indexfoundry_index_upsert", {
  run_id: runId,
  provider: "local",
  connection: { collection: "my_docs" }
});
```

### Option 2: Project-Based Workflow (Deployable RAG)

Create a self-contained, deployable RAG application:

```typescript
// Create a new project
await client.callTool("indexfoundry_project_create", {
  project_id: "my-rag-app",
  name: "My RAG Search",
  description: "Searchable knowledge base for documentation",
  embedding_model: {
    provider: "openai",
    model_name: "text-embedding-3-small",
    api_key_env: "OPENAI_API_KEY"
  },
  chunk_config: {
    strategy: "recursive",
    max_chars: 1500,
    overlap_chars: 150
  }
});

// Add data sources
await client.callTool("indexfoundry_project_add_source", {
  project_id: "my-rag-app",
  url: "https://docs.example.com",
  source_name: "Documentation Site",
  tags: ["docs", "api"]
});

// Build: vector database
await client.callTool("indexfoundry_project_build", {
  project_id: "my-rag-app"
});

// Query: built index
await client.callTool("indexfoundry_project_query", {
  project_id: "my-rag-app",
  query: "How do I configure authentication?",
  mode: "hybrid",
  top_k: 5
});

// Export for deployment
await client.callTool("indexfoundry_project_export", {
  project_id: "my-rag-app",
  server_name: "my-rag-server",
  include_http: true,
  railway_config: true
});
```

After export, a project directory contains a complete deployable repository:
- `Dockerfile` - Container configuration
- `railway.toml` - Railway deployment config
- `src/index.ts` - Generated MCP server with search tools
- `README.md` - Project-specific documentation

Push to GitHub and deploy:
```bash
cd projects/my-rag-app
git init
git add .
git commit -m "Initial RAG application"
git push
# Then connect to Railway and deploy
```

## Tool Overview

### Run-Based Pipeline Tools

#### Connect Phase
- `indexfoundry_connect_url` - Fetch a single URL with domain allowlisting
- `indexfoundry_connect_sitemap` - Crawl a sitemap with URL filtering
- `indexfoundry_connect_folder` - Load local files with glob patterns
- `indexfoundry_connect_pdf` - Fetch PDF with metadata extraction

#### Extract Phase
- `indexfoundry_extract_pdf` - PDF to text (layout/plain/OCR modes)
- `indexfoundry_extract_html` - HTML to clean text with structure preservation
- `indexfoundry_extract_document` - Generic document extraction (markdown, txt, CSV, JSON)

#### Normalize Phase
- `indexfoundry_normalize_chunk` - Split text into chunks (recursive/paragraph/heading/page/sentence/fixed)
- `indexfoundry_normalize_enrich` - Add metadata (language detection, regex tags, section classification)
- `indexfoundry_normalize_dedupe` - Remove duplicates (exact/simhash/minhash)

#### Index Phase
- `indexfoundry_index_embed` - Generate embeddings (OpenAI/Cohere/sentence-transformers/local)
- `indexfoundry_index_upsert` - Write to vector DB (Pinecone/Weaviate/Qdrant/Milvus/Chroma/local)
- `indexfoundry_index_build_profile` - Configure retrieval (top_k, hybrid search, reranking)

#### Serve Phase
- `indexfoundry_serve_openapi` - Generate OpenAPI 3.1 specification
- `indexfoundry_serve_start` - Start HTTP search API server
- `indexfoundry_serve_stop` - Stop running API server
- `indexfoundry_serve_status` - Get server status
- `indexfoundry_serve_query` - Query running server directly

#### Run Utilities
- `indexfoundry_run_status` - Get detailed status of a run
- `indexfoundry_run_list` - List all runs with filtering
- `indexfoundry_run_diff` - Compare two runs (config, chunks, timing)
- `indexfoundry_run_cleanup` - Delete old runs with retention policies

### Project-Based Workflow Tools

#### Project Management
- `indexfoundry_project_create` - Create a new project with embedding and chunk config
- `indexfoundry_project_list` - List all projects with optional statistics
- `indexfoundry_project_get` - Get project details, manifest, and sources
- `indexfoundry_project_delete` - Delete a project (requires `confirm: true`)

#### Source Management
- `indexfoundry_project_add_source` - Add data source (url/sitemap/folder/pdf) with tags

#### Build & Query
- `indexfoundry_project_build` - Process all pending sources (fetch, chunk, embed, upsert)
- `indexfoundry_project_query` - Search project's vector database (semantic/keyword/hybrid)

#### Deployment
- `indexfoundry_project_export` - Generate deployment files (Dockerfile, MCP server, railway.toml)

## Directory Structures

### Run-Based Structure

```
runs/<run_id>/
├── manifest.json           # Master audit trail
├── config.json             # Frozen config
├── raw/                    # Fetched artifacts
├── extracted/              # Text extraction
├── normalized/             # Chunks
├── indexed/                # Embeddings
├── served/                 # API artifacts
└── logs/                   # Event logs
```

### Project-Based Structure

```
projects/<project_id>/
├── project.json            # Project manifest (embedding config, stats)
├── sources.jsonl          # Source records (url/sitemap/folder/pdf)
├── data/
│   ├── chunks.jsonl       # Indexed chunks
│   └── vectors.jsonl     # Generated embeddings
├── runs/                  # Per-source build runs
├── src/
│   └── index.ts         # Generated MCP server
├── Dockerfile             # Container configuration
├── railway.toml           # Railway deployment config
├── package.json           # Server dependencies
├── tsconfig.json          # TypeScript config
└── README.md             # Project documentation
```

## Configuration

### Environment Variables

```bash
# Run-based pipeline
INDEXFOUNDRY_RUNS_DIR=./runs     # Where to store runs

# Embeddings
OPENAI_API_KEY=sk-...           # For OpenAI embeddings
EMBEDDING_API_KEY=sk-...         # Generic env variable (configurable per project)

# Server
PORT=3000                        # For HTTP transport
TRANSPORT=stdio                  # stdio or http
```

### Project Configuration

Projects store configuration in `project.json`:

```json
{
  "project_id": "my-rag",
  "name": "My RAG Search",
  "embedding_model": {
    "provider": "openai",
    "model_name": "text-embedding-3-small",
    "api_key_env": "OPENAI_API_KEY"
  },
  "chunk_config": {
    "strategy": "recursive",
    "max_chars": 1500,
    "overlap_chars": 150
  }
}
```

## Example Usage

### Run-Based Pipeline Example

```typescript
// Create a new run
const runId = crypto.randomUUID();

// Connect: fetch from folder
await client.callTool("indexfoundry_connect_folder", {
  run_id: runId,
  path: "/path/to/documents",
  glob: "**/*.pdf"
});

// Extract: PDF to text
await client.callTool("indexfoundry_extract_pdf", {
  run_id: runId,
  pdf_path: "raw/<sha256>.pdf",
  mode: "layout"
});

// Normalize: chunk text
await client.callTool("indexfoundry_normalize_chunk", {
  run_id: runId,
  input_paths: ["extracted/<sha256>.pages.jsonl"],
  strategy: "recursive",
  max_chars: 1500,
  overlap_chars: 150
});

// Index: generate embeddings
await client.callTool("indexfoundry_index_embed", {
  run_id: runId,
  model: {
    provider: "openai",
    model_name: "text-embedding-3-small",
    api_key_env: "OPENAI_API_KEY"
  }
});

// Upsert to local vector DB
await client.callTool("indexfoundry_index_upsert", {
  run_id: runId,
  provider: "local",
  connection: { collection: "my_docs" }
});

// Serve: start HTTP API
await client.callTool("indexfoundry_serve_start", {
  run_id: runId,
  port: 8080
});
```

### Project-Based Workflow Example

```typescript
// Create a deployable RAG project
await client.callTool("indexfoundry_project_create", {
  project_id: "my-docs-rag",
  name: "Company Documentation Search",
  description: "Searchable knowledge base for internal docs",
  embedding_model: {
    provider: "openai",
    model_name: "text-embedding-3-small",
    api_key_env": "OPENAI_API_KEY"
  },
  chunk_config: {
    strategy: "recursive",
    max_chars: 1500,
    overlap_chars: 150
  }
});

// Add multiple sources
await client.callTool("indexfoundry_project_add_source", {
  project_id: "my-docs-rag",
  url: "https://docs.company.com",
  source_name: "Main Docs",
  tags: ["docs", "internal"]
});

await client.callTool("indexfoundry_project_add_source", {
  project_id: "my-docs-rag",
  folder_path: "/path/to/pdfs",
  source_name: "Policy Documents",
  tags: ["policy", "pdf"]
});

// Build: vector database
await client.callTool("indexfoundry_project_build", {
  project_id: "my-docs-rag"
});

// Query: index
const results = await client.callTool("indexfoundry_project_query", {
  project_id: "my-docs-rag",
  query: "What is the vacation policy?",
  mode: "hybrid",
  top_k: 5,
  filter_tags: ["policy"]
});

// Export for deployment
await client.callTool("indexfoundry_project_export", {
  project_id: "my-docs-rag",
  server_name: "docs-search-server",
  server_description: "Internal documentation search API",
  include_http: true,
  railway_config: true
});
```

After export, a project directory contains a deployable repository:
```bash
cd projects/my-docs-rag
git init
git add .
git commit -m "Initial RAG application"
git push origin main
# Deploy on Railway
```

## Development

```bash
# Development with watch mode
npm run dev

# Run tests (single run)
npm test

# Run tests (watch mode)
npm run test:watch

# Lint
npm run lint

# Test with MCP Inspector
npm run inspector
```

## Testing

The MCP server has been validated with end-to-end testing:

- ✅ Project creation, listing, and retrieval
- ✅ Source addition (URL, folder, PDF, sitemap)
- ✅ Build pipeline (fetch → chunk → embed → upsert)
- ✅ Vector search with semantic, keyword, and hybrid modes
- ✅ Deployment file generation (Dockerfile, railway.toml, MCP server)

## Deployment

### Railway Deployment

1. Create and export a project:
```typescript
await client.callTool("indexfoundry_project_export", {
  project_id: "my-rag",
  railway_config: true
});
```

2. Push to GitHub and connect to Railway

3. Railway automatically detects `railway.toml` and deploys

### Docker Deployment

```bash
cd projects/my-rag
docker build -t my-rag-server .
docker run -p 8080:8080 -e OPENAI_API_KEY=sk-... my-rag-server
```

## Determinism Guarantees

1. **Sorted inputs**: File lists sorted before processing
2. **Stable IDs**: Chunk IDs derived from content + position
3. **Content hashes**: SHA256 on every artifact
4. **Pinned versions**: Extractor versions locked in config
5. **No randomness**: No sampling, shuffling, or non-deterministic algorithms

## License

PROPRIETARY SOFTWARE LICENSE
