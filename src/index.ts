#!/usr/bin/env node
/**
 * IndexFoundry-MCP: Main Server Entry Point
 *
 * A deterministic vector index factory for MCP.
 * Five-phase pipeline: Connect → Extract → Normalize → Index → Serve
 *
 * Copyright (c) 2024 vario.automation
 * Proprietary and confidential. All rights reserved.
 *
 * This source code is the property of vario.automation and is protected
 * by trade secret and copyright law. Unauthorized copying, modification,
 * distribution, or use of this software is strictly prohibited.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Tool implementations
import {
  connectUrl,
  connectSitemap,
  connectFolder,
  connectPdf,
} from "./tools/connect.js";

import {
  extractPdf,
  extractHtml,
  extractDocument,
} from "./tools/extract.js";

import {
  normalizeChunk,
  normalizeEnrich,
  normalizeDedupe,
} from "./tools/normalize.js";

import {
  indexEmbed,
  indexUpsert,
  indexBuildProfile,
} from "./tools/index.js";

import {
  serveOpenapi,
  serveStart,
  serveStop,
  serveStatus,
  serveQuery,
} from "./tools/serve.js";

import {
  runStatus,
  runList,
  runDiff,
  runCleanup,
} from "./tools/utilities.js";

import {
  classifyQuery,
  ClassifyQueryInputSchema,
} from "./tools/classify.js";

import {
  extractTables,
  ExtractTableInputSchema,
} from "./tools/tables.js";

import {
  debugQuery,
  DebugQueryInputSchema,
} from "./tools/debug.js";

import {
  projectCreate,
  projectList,
  projectGet,
  projectDelete,
  projectAddSource,
  projectRemoveSource,
  projectBuild,
  projectBuildStatus,
  projectQuery,
  projectExport,
  projectDeploy,
  projectServe,
  projectServeStop,
  projectServeStatus,
  initProjectManager,
} from "./tools/projects.js";

import {
  librarianAudit,
  librarianAssessQuality,
  formatAuditResponse,
  formatQualityResponse,
  initLibrarian,
  getServerInfo,
  LibrarianAuditSchema,
  LibrarianAssessSchema,
} from "./tools/librarian.js";

// Schemas
import {
  ConnectUrlSchema,
  ConnectSitemapSchema,
  ConnectFolderSchema,
  ConnectPdfSchema,
  ExtractPdfSchema,
  ExtractHtmlSchema,
  ExtractDocumentSchema,
  NormalizeChunkSchema,
  NormalizeEnrichSchema,
  NormalizeDedupeSchema,
  IndexEmbedSchema,
  IndexUpsertSchema,
  IndexBuildProfileSchema,
  ServeOpenapiSchema,
  ServeStartSchema,
  ServeStopSchema,
  ServeStatusSchema,
  ServeQuerySchema,
  RunStatusSchema,
  RunListSchema,
  RunDiffSchema,
  RunCleanupSchema,
} from "./schemas.js";

import {
  ProjectCreateSchema,
  ProjectListSchema,
  ProjectGetSchema,
  ProjectDeleteSchema,
  ProjectAddSourceSchema,
  ProjectAddSourceBaseSchema,
  ProjectRemoveSourceSchema,
  ProjectRemoveSourceBaseSchema,
  ProjectBuildSchema,
  ProjectBuildStatusSchema,
  ProjectQuerySchema,
  ProjectExportSchema,
  ProjectDeploySchema,
  ProjectServeSchema,
  ProjectServeStopSchema,
  ProjectServeStatusSchema,
} from "./schemas-projects.js";

import { initRunManager } from "./run-manager.js";
import { fileURLToPath } from "url";
import * as path from "path";

// Get the directory where the MCP server is installed
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_BASE_DIR = path.resolve(__dirname, "..");

// Initialize the MCP server
const server = new McpServer({
  name: "indexfoundry-mcp",
  version: "0.1.0",
});

// ============================================================================
// PHASE 1: CONNECT TOOLS
// ============================================================================

server.tool(
  "indexfoundry_connect_url",
  "Fetch a single URL and store raw content. Supports domain allowlisting, timeout configuration, and content validation.",
  ConnectUrlSchema.shape,
  async (args) => {
    const result = await connectUrl(args as z.infer<typeof ConnectUrlSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_connect_sitemap",
  "Crawl a sitemap XML file and fetch all linked pages. Supports URL pattern filtering, concurrent fetching, and depth limits.",
  ConnectSitemapSchema.shape,
  async (args) => {
    const result = await connectSitemap(args as z.infer<typeof ConnectSitemapSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_connect_folder",
  "Load files from a local folder using glob patterns. Validates file sizes and content types.",
  ConnectFolderSchema.shape,
  async (args) => {
    const result = await connectFolder(args as z.infer<typeof ConnectFolderSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_connect_pdf",
  "Fetch a PDF file from URL or local path with specialized validation and metadata extraction.",
  ConnectPdfSchema.shape,
  async (args) => {
    const result = await connectPdf(args as z.infer<typeof ConnectPdfSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ============================================================================
// PHASE 2: EXTRACT TOOLS
// ============================================================================

server.tool(
  "indexfoundry_extract_pdf",
  "Extract text from PDF files, producing page-by-page JSONL output. Handles multi-column layouts and embedded fonts.",
  ExtractPdfSchema.shape,
  async (args) => {
    const result = await extractPdf(args as z.infer<typeof ExtractPdfSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_extract_html",
  "Extract text and structure from HTML content. Preserves headings, tables, and semantic markup. Outputs clean text or markdown.",
  ExtractHtmlSchema.shape,
  async (args) => {
    const result = await extractHtml(args as z.infer<typeof ExtractHtmlSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_extract_document",
  "Generic document extractor for markdown, plain text, CSV, and JSON files. Normalizes encoding and line endings.",
  ExtractDocumentSchema.shape,
  async (args) => {
    const result = await extractDocument(args as z.infer<typeof ExtractDocumentSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ============================================================================
// PHASE 3: NORMALIZE TOOLS
// ============================================================================

server.tool(
  "indexfoundry_normalize_chunk",
  "Split extracted text into semantic chunks. Supports strategies: recursive (default), hierarchical (parent-child from markdown headings), paragraph, heading, page, sentence, fixed. Produces deterministic SHA256 chunk IDs.",
  NormalizeChunkSchema.shape,
  async (args) => {
    const result = await normalizeChunk(args as z.infer<typeof NormalizeChunkSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_normalize_enrich",
  "Enrich chunks with metadata: language detection, regex-based tagging, section classification, and taxonomy mapping.",
  NormalizeEnrichSchema.shape,
  async (args) => {
    const result = await normalizeEnrich(args as z.infer<typeof NormalizeEnrichSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_normalize_dedupe",
  "Deduplicate chunks by exact content hash or fuzzy similarity (simhash). Preserves the first occurrence and tracks duplicates.",
  NormalizeDedupeSchema.shape,
  async (args) => {
    const result = await normalizeDedupe(args as z.infer<typeof NormalizeDedupeSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ============================================================================
// PHASE 4: INDEX TOOLS
// ============================================================================

server.tool(
  "indexfoundry_index_embed",
  "Generate vector embeddings for chunks using OpenAI or local models. Batch processing with retry logic and rate limiting.",
  IndexEmbedSchema.shape,
  async (args) => {
    const result = await indexEmbed(args as z.infer<typeof IndexEmbedSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_index_upsert",
  "Upsert vectors to a vector database. Supports local file-based storage and external providers (Pinecone, Weaviate, Qdrant, Milvus, Chroma).",
  IndexUpsertSchema.shape,
  async (args) => {
    const result = await indexUpsert(args as z.infer<typeof IndexUpsertSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_index_build_profile",
  "Define retrieval configuration: top_k, hybrid search settings, reranking, metadata filters, and scoring adjustments.",
  IndexBuildProfileSchema.shape,
  async (args) => {
    const result = await indexBuildProfile(args as z.infer<typeof IndexBuildProfileSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ============================================================================
// PHASE 5: SERVE TOOLS
// ============================================================================

server.tool(
  "indexfoundry_serve_openapi",
  "Generate an OpenAPI 3.1 specification for the index API. Configurable endpoints: search_semantic, search_hybrid, get_chunk, health, stats.",
  ServeOpenapiSchema.shape,
  async (args) => {
    const result = await serveOpenapi(args as z.infer<typeof ServeOpenapiSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_serve_start",
  "Start an HTTP search API server for a run. Loads vectors and chunks into memory, serves semantic/hybrid/keyword search endpoints.",
  ServeStartSchema.shape,
  async (args) => {
    const result = await serveStart(args as z.infer<typeof ServeStartSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_serve_stop",
  "Stop a running search API server for a run. Returns server uptime and request count.",
  ServeStopSchema.shape,
  async (args) => {
    const result = await serveStop(args as z.infer<typeof ServeStopSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_serve_status",
  "Get status of running search servers. Shows endpoint, uptime, request count, and loaded vector/chunk counts.",
  ServeStatusSchema.shape,
  async (args) => {
    const result = await serveStatus(args as z.infer<typeof ServeStatusSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_serve_query",
  "Query a running search server directly (without HTTP). Supports semantic, keyword, and hybrid search modes.",
  ServeQuerySchema.shape,
  async (args) => {
    const result = await serveQuery(args as z.infer<typeof ServeQuerySchema>);
    return {
      content: [{ type: "text", text: formatQueryResults(result) }],
    };
  }
);

// ============================================================================
// UTILITY TOOLS
// ============================================================================

server.tool(
  "indexfoundry_run_status",
  "Get detailed status of a run including phase completion, timing, errors, and artifact counts.",
  RunStatusSchema.shape,
  async (args) => {
    const result = await runStatus(args as z.infer<typeof RunStatusSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_run_list",
  "List all runs with optional filtering by status, date range, and sorting options.",
  RunListSchema.shape,
  async (args) => {
    const result = await runList(args as z.infer<typeof RunListSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_run_diff",
  "Compare two runs: configuration differences, source changes, chunk deltas, and timing comparisons.",
  RunDiffSchema.shape,
  async (args) => {
    const result = await runDiff(args as z.infer<typeof RunDiffSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_run_cleanup",
  "Delete old runs with optional manifest preservation. Supports age-based and count-based retention policies.",
  RunCleanupSchema.shape,
  async (args) => {
    const result = await runCleanup(args as z.infer<typeof RunCleanupSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ============================================================================
// PROJECT TOOLS
// ============================================================================

server.tool(
  "indexfoundry_project_create",
  `🏗️ [STEP 1/5: CREATE] Create a new RAG project.

📁 STORAGE LOCATION:
Projects are stored in the IndexFoundry installation directory:
  {indexfoundry-install-path}/projects/{project_id}/

PROJECT PIPELINE OVERVIEW:
1. project_create → Initialize project structure
2. project_add_source → Add URLs, PDFs, folders, or sitemaps
3. project_build → Chunk and embed content
4. project_export → Generate deployment files
5. project_serve → Start local server for testing

WHAT THIS DOES:
- Creates project directory structure (data/, src/, frontend/)
- Initializes project.json manifest with embedding config
- Generates deployment boilerplate (Dockerfile, package.json)
- Creates frontend/index.html chat interface

LIBRARIAN PROTOCOL TIP:
After creating a project, use librarian_audit to verify project state
before proceeding with add_source or build operations.

NEXT STEPS:
- Use project_add_source to add your content (URLs, PDFs, folders)
- Multiple sources can be added before building`,
  ProjectCreateSchema.shape,
  async (args) => {
    const result = await projectCreate(args as z.infer<typeof ProjectCreateSchema>);
    // Include server info in result
    const serverInfo = getServerInfo(SERVER_BASE_DIR);
    return {
      content: [{ type: "text", text: JSON.stringify({
        ...result,
        storage_info: {
          project_path: `${serverInfo.projects_dir}/${(args as z.infer<typeof ProjectCreateSchema>).project_id}`,
          indexfoundry_base: serverInfo.server_base_dir,
        }
      }, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_project_list",
  `📋 List all IndexFoundry projects.

📁 STORAGE LOCATION:
All projects are stored in: {indexfoundry-install-path}/projects/
Each project has its own subdirectory with data/, src/, and frontend/.

USE WHEN: You need to see what projects exist or check their stats

RETURNS: Array of { project_id, name, created_at, stats? }`,
  ProjectListSchema.shape,
  async (args) => {
    const result = await projectList(args as z.infer<typeof ProjectListSchema>);
    const serverInfo = getServerInfo(SERVER_BASE_DIR);
    return {
      content: [{ type: "text", text: JSON.stringify({
        ...result,
        storage_info: {
          projects_directory: serverInfo.projects_dir,
          indexfoundry_base: serverInfo.server_base_dir,
        }
      }, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_project_get",
  `📖 Get detailed information about a specific project.

USE WHEN: You need to check project status, sources, or configuration

RETURNS: { manifest, sources[], path } - full project state`,
  ProjectGetSchema.shape,
  async (args) => {
    const result = await projectGet(args as z.infer<typeof ProjectGetSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_project_delete",
  `🗑️ Delete a project and all its data. Requires confirm: true for safety.`,
  ProjectDeleteSchema.shape,
  async (args) => {
    const result = await projectDelete(args as z.infer<typeof ProjectDeleteSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_project_add_source",
  `📥 [STEP 2/5: ADD] Add data source(s) to a project.

PREREQUISITES: project_create must have been run first

SOURCE TYPES (use exactly one per source):
- url: Single webpage (HTML content extracted)
- sitemap_url: Crawl all pages in sitemap.xml
- folder_path: Local folder with text/markdown/PDF files
- pdf_path: Single PDF file (local path or URL)

MODES:
- Single: Provide one source directly in parameters
- Batch: Use \`batch\` array for multiple sources at once (max 50)

WHAT THIS DOES:
- Validates source(s) are accessible
- Creates source record(s) in sources.jsonl
- Skips duplicates (same URI already exists)
- Queues source(s) for processing by project_build

NEXT STEPS:
- Add more sources with additional calls to project_add_source
- Run project_build when all sources are added`,
  ProjectAddSourceBaseSchema.shape,
  async (args) => {
    const result = await projectAddSource(args as z.infer<typeof ProjectAddSourceSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_project_remove_source",
  `🗑️ Remove source(s) from a project with cascade deletion.

PREREQUISITES: project_create must have been run

MODES:
- Single: Provide source_id or source_uri to remove one source
- Batch: Use \`batch\` array for multiple removals (max 50)

CASCADE OPTIONS:
- remove_chunks: Remove associated chunks (default: true)
- remove_vectors: Remove associated vectors (default: true)

SAFETY: Requires confirm: true when cascade is enabled

WHAT THIS DOES:
- Removes source record(s) from sources.jsonl
- Optionally removes chunks and vectors for those sources
- Updates manifest stats

USE WHEN: You need to remove bad/duplicate sources or replace content`,
  ProjectRemoveSourceBaseSchema.shape,
  async (args) => {
    const result = await projectRemoveSource(args as z.infer<typeof ProjectRemoveSourceSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_project_build",
  `⚙️ [STEP 3/5: BUILD] Process pending sources into searchable chunks.

PREREQUISITES:
- project_create must have been run
- project_add_source must have added at least one source

CHUNKING OPTIONS (optional chunk_options):
- max_sources_per_build: Process N sources per call (default: 10)
- fetch_concurrency: Parallel URL fetches (default: 3)
- enable_checkpointing: Enable resume capability (default: true)

WHAT THIS DOES:
1. Fetches content from pending sources (up to max_sources_per_build)
2. Extracts text (HTML parsing, PDF extraction, etc.)
3. Chunks text with overlap for context continuity
4. Generates embeddings using OpenAI API (requires OPENAI_API_KEY)
5. Saves checkpoint after each source for resumability
6. Returns progress with remaining sources count

RESUME: Use resume_from_checkpoint=true to continue after timeout/failure

COST: ~$0.02 per 1M tokens embedded (text-embedding-3-small)

NEXT STEPS:
- If has_more=true: call project_build again to continue
- Use project_build_status to check checkpoint state
- Use project_query to test search quality`,
  ProjectBuildSchema.shape,
  async (args) => {
    const result = await projectBuild(args as z.infer<typeof ProjectBuildSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_project_build_status",
  `📊 Get build status and checkpoint information for a project.

USE WHEN: You need to check if a build is in progress or can be resumed

RETURNS:
- state: 'idle' | 'in_progress' | 'checkpoint_available'
- checkpoint: Details about saved checkpoint (if any)
- pending_sources: Number of sources waiting to be processed
- failed_sources: Number of sources that failed
- recommendation: Suggested next action

USE THIS BEFORE project_build to determine optimal strategy`,
  ProjectBuildStatusSchema.shape,
  async (args) => {
    const result = await projectBuildStatus(args as z.infer<typeof ProjectBuildStatusSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// Format query results (project_query, serve_query) as clean markdown for LLM consumption
function formatQueryResults(result: unknown): string {
  if (!result || typeof result !== 'object') {
    return JSON.stringify(result, null, 2);
  }
  
  const r = result as Record<string, unknown>;
  
  // Handle errors
  if (r.success === false) {
    return `## ❌ Query Failed\n\n**Error:** ${r.error || 'Unknown error'}\n**Code:** ${r.code || 'UNKNOWN'}`;
  }
  
  // Format successful results
  const results = r.results as Array<{
    chunk_id?: string;
    id?: string;
    score: number;
    text?: string;
    source_id?: string;
    metadata?: Record<string, unknown>;
  }> | undefined;
  
  if (!results || results.length === 0) {
    return `## 🔍 Query Results\n\n**No results found.**\n\nTry:\n- Different search terms\n- Using hybrid mode for better recall\n- Checking if the project has been built`;
  }
  
  const tookMs = r.took_ms as number | undefined;
  const timing = tookMs ? ` | **Time:** ${tookMs}ms` : '';
  
  const lines: string[] = [
    `## 🔍 Query Results`,
    ``,
    `**Found:** ${results.length} result${results.length !== 1 ? 's' : ''} | **Mode:** ${r.mode || 'unknown'}${timing}`,
    ``,
    `---`,
  ];
  
  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    const scorePercent = (item.score * 100).toFixed(1);
    const chunkId = item.chunk_id || item.id || 'unknown';
    const sourceId = item.source_id || (item.metadata?.source_id as string) || chunkId;
    
    lines.push(``);
    lines.push(`### Result ${i + 1} — Score: ${scorePercent}%`);
    lines.push(``);
    lines.push(`**Source:** \`${sourceId}\``);
    
    if (item.text) {
      lines.push(``);
      lines.push(item.text);
    } else {
      lines.push(``);
      lines.push(`*[Text not included - set include_text=true]*`);
    }
    
    lines.push(``);
    lines.push(`---`);
  }
  
  return lines.join('\n');
}

server.tool(
  "indexfoundry_project_query",
  `🔍 Search a project's vector database (for testing).

PREREQUISITES: project_build must have processed sources

MODES:
- keyword: Fast exact-match search
- semantic: Embedding similarity (requires query embedding)
- hybrid: Combines keyword + semantic with RRF fusion

USE WHEN: You want to test search quality before deploying`,
  ProjectQuerySchema.shape,
  async (args) => {
    const result = await projectQuery(args as z.infer<typeof ProjectQuerySchema>);
    return {
      content: [{ type: "text", text: formatQueryResults(result) }],
    };
  }
);

server.tool(
  "indexfoundry_project_export",
  `📦 [STEP 4/5: EXPORT] Generate deployment files for the project.

PREREQUISITES: project_build must have processed sources

WHAT THIS DOES:
1. Generates src/index.ts - MCP server with HTTP endpoints
2. Creates Dockerfile for containerized deployment
3. Creates railway.toml for Railway deployment
4. Generates DEPLOYMENT.md with step-by-step instructions
5. Creates frontend/ with chat UI

NEXT STEPS:
- Run project_serve to test locally
- Push to GitHub and deploy to Railway
- Or use project_deploy for automated Railway deployment`,
  ProjectExportSchema.shape,
  async (args) => {
    const result = await projectExport(args as z.infer<typeof ProjectExportSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_project_deploy",
  `☁️ Deploy a project to Railway (production deployment).

PREREQUISITES:
- project_export must have generated deployment files
- Railway CLI must be installed and authenticated
- OPENAI_API_KEY must be available for /chat endpoint

USE dry_run=true FIRST to preview commands without executing

WHAT THIS DOES:
1. Initializes Railway project in project directory
2. Sets environment variables (OPENAI_API_KEY, etc.)
3. Deploys to Railway using Dockerfile
4. Returns public URL

ALTERNATIVE: Use project_serve for local testing first`,
  ProjectDeploySchema.shape,
  async (args) => {
    const result = await projectDeploy(args as z.infer<typeof ProjectDeploySchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_project_serve",
  `🚀 [STEP 5/5: SERVE] Start a local development server for testing a project.

PREREQUISITES:
- project_create must have been run
- project_add_source must have added at least one source
- project_build must have processed sources into chunks/vectors
- project_export must have generated the server code

WHAT THIS DOES:
1. Checks if dependencies are installed (runs npm install if needed)
2. For mode='dev': uses tsx for hot reload during development
3. For mode='build': compiles TypeScript then runs production Node.js
4. Polls /health endpoint to confirm server is ready
5. Optionally opens frontend/index.html in browser

RETURNS: { endpoint, pid, port, mode } - use endpoint to test the chat UI

NEXT STEPS:
- Open frontend/index.html in browser to test the chat interface
- Use project_serve_status to check server health
- Use project_serve_stop when done testing
- Use project_deploy to deploy to Railway for production`,
  ProjectServeSchema.shape,
  async (args) => {
    const result = await projectServe(args as z.infer<typeof ProjectServeSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_project_serve_stop",
  `🛑 Stop a running project development server.

USE WHEN: You need to stop a server started with project_serve

WHAT THIS DOES:
1. Sends SIGTERM for graceful shutdown
2. Waits 2 seconds for cleanup
3. Uses SIGKILL if force=true or process won't stop
4. Cleans up PID file and tracking state

RETURNS: { pid, uptime_seconds } - confirms server was stopped`,
  ProjectServeStopSchema.shape,
  async (args) => {
    const result = await projectServeStop(args as z.infer<typeof ProjectServeStopSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_project_serve_status",
  `📊 Get status of running project servers.

USE WHEN: You need to check if a server is running or find its endpoint

WHAT THIS DOES:
- If project_id provided: checks status of that specific project's server
- If project_id omitted: scans all projects for running servers
- Validates process is actually running (handles stale PID files)

RETURNS: Array of running servers with { endpoint, pid, port, mode, uptime_seconds }`,
  ProjectServeStatusSchema.shape,
  async (args) => {
    const result = await projectServeStatus(args as z.infer<typeof ProjectServeStatusSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ============================================================================
// CLASSIFICATION TOOLS
// ============================================================================

server.tool(
  "indexfoundry_classify_query",
  "🔍 Classify a query to determine if RAG retrieval is needed and what type of query it is. Returns query type (factual/procedural/conceptual/navigational/conversational), complexity, confidence, and retrieval hints.",
  ClassifyQueryInputSchema.shape,
  async (args) => {
    const result = await classifyQuery(args as z.infer<typeof ClassifyQueryInputSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ============================================================================
// TABLE PROCESSING TOOLS
// ============================================================================

server.tool(
  "indexfoundry_extract_tables",
  "📊 Extract and linearize tables from markdown, HTML, or CSV content. Produces structured table data, linearized text for vector embedding, and chunks for RAG retrieval.",
  ExtractTableInputSchema.shape,
  async (args) => {
    const result = await extractTables(args as z.infer<typeof ExtractTableInputSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ============================================================================
// DEBUG TOOLS
// ============================================================================

server.tool(
  "indexfoundry_debug_query",
  "🔍 Debug retrieval queries with pipeline tracing, similarity scores, and expected/actual comparison. Diagnose why queries don't return expected results.",
  DebugQueryInputSchema.shape,
  async (args) => {
    const result = await debugQuery(args as z.infer<typeof DebugQueryInputSchema>);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// ============================================================================
// LIBRARIAN PROTOCOL TOOLS (ADR-007)
// ============================================================================

server.tool(
  "indexfoundry_librarian_audit",
  `📚 [LIBRARIAN PROTOCOL] Audit project state for health and readiness.

THE LIBRARIAN PROTOCOL:
The Librarian is an Active Data Curator that validates index state before
queries and self-corrects when retrieval quality is poor. Use this tool
to implement the "Reason Over State" principle.

WHAT THIS DOES:
1. Validates project manifest exists and is valid
2. Counts sources (pending/failed/processed)
3. Verifies chunks and vectors are in sync
4. Checks if server is running
5. Generates actionable recommendations

USE WHEN:
- Before running queries on a project
- After adding sources to check build status
- To diagnose retrieval problems
- Before deploying to production

LIBRARIAN THRESHOLDS (customizable):
- min_chunk_score: 0.50 (individual relevance)
- avg_result_score: 0.65 (overall quality gate)
- classification_confidence: 0.50 (intent reliability)

RETURNS: State audit with health status, issues, and recommendations`,
  LibrarianAuditSchema.shape,
  async (args) => {
    const result = await librarianAudit(args as z.infer<typeof LibrarianAuditSchema>);
    if (result.success) {
      return {
        content: [{ type: "text", text: formatAuditResponse(result.audit) }],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.tool(
  "indexfoundry_librarian_assess",
  `📊 [LIBRARIAN PROTOCOL] Assess retrieval quality after a query.

THE LIBRARIAN PROTOCOL:
After running project_query, use this tool to assess whether the results
meet quality thresholds. The Librarian will recommend debugging or repair
actions if quality is marginal or poor.

WHAT THIS DOES:
1. Calculates min/max/avg scores from results
2. Compares against quality thresholds
3. Assigns quality level (excellent/good/marginal/poor)
4. Generates recommendations based on quality
5. Suggests debug_query or re-chunking if needed

QUALITY LEVELS:
- Excellent: avg >= 0.80, min >= 0.60
- Good: meets configured thresholds
- Marginal: close to threshold (within 80%)
- Poor: below thresholds

USE WHEN:
- After project_query to validate results
- Before returning answers to users
- To decide if re-indexing is needed

RETURNS: Quality assessment with scores, thresholds, and recommendations`,
  LibrarianAssessSchema.shape,
  async (args) => {
    const result = librarianAssessQuality(args as z.infer<typeof LibrarianAssessSchema>);
    return {
      content: [{ type: "text", text: formatQualityResponse(result) }],
    };
  }
);

server.tool(
  "indexfoundry_get_server_info",
  `ℹ️ Get IndexFoundry server installation information.

WHAT THIS RETURNS:
- server_base_dir: Where IndexFoundry is installed
- projects_dir: Where all projects are stored
- runs_dir: Where run-based pipeline artifacts are stored

USE WHEN:
- You need to tell users where their projects are stored
- You need to reference absolute paths in other tools
- You want to verify the IndexFoundry installation

This is helpful for explaining to users that projects they create
are stored within the IndexFoundry installation directory, not in
their working directory.`,
  z.object({}).shape,
  async () => {
    const serverInfo = getServerInfo(SERVER_BASE_DIR);
    return {
      content: [{ type: "text", text: JSON.stringify({
        success: true,
        ...serverInfo,
        note: "Projects created with project_create are stored in projects_dir. Each project has its own subdirectory with data/, src/, and frontend/."
      }, null, 2) }],
    };
  }
);

// ============================================================================
// SERVER STARTUP
// ============================================================================

async function main() {
  // Initialize the run manager with absolute path to server directory
  // The runs_dir in config will create ./runs under this base
  initRunManager(SERVER_BASE_DIR, {
    storage: {
      runs_dir: "runs", // Just "runs", not "./runs" to avoid path issues
      max_runs: 100,
      cleanup_policy: "fifo",
    },
  });

  // Initialize the project manager
  initProjectManager(SERVER_BASE_DIR);

  // Initialize the Librarian protocol tools
  initLibrarian(SERVER_BASE_DIR);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("IndexFoundry-MCP server started");
  console.error(`  Projects directory: ${SERVER_BASE_DIR}/projects`);
  console.error(`  Runs directory: ${SERVER_BASE_DIR}/runs`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
