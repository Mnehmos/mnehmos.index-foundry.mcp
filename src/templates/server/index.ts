/**
 * IndexFoundry RAG Search Server (template).
 *
 * This file is copied verbatim into exported projects by
 * `indexfoundry_project_export`, together with ./search.ts. It takes all of its
 * configuration at runtime from `project.json` and `server.config.json` in the
 * project root, so nothing here is substituted at generation time.
 *
 * It is a real, compiled source file: `npm run typecheck:template` checks it
 * against tsconfig.template.json.
 *
 * Copyright (c) vario.automation
 * Proprietary and confidential. All rights reserved.
 */

import "dotenv/config";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import express from "express";

import {
  buildSearchContext,
  runSearch,
  searchHybrid,
  type Chunk,
  type ScoredChunk,
  type SearchContext,
  type Vector,
} from "./search.js";
import { shouldStartHttp } from "./runtime.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const PROJECT_DIR = join(__dirname, "..");

// ============================================================================
// Type Definitions
// ============================================================================

interface Source {
  source_id: string;
  type: string;
  uri: string;
  source_name?: string;
  tags?: string[];
  status: string;
}

interface EmbeddingModel {
  provider: string;
  model_name: string;
  api_key_env: string;
  dimensions?: number;
}

interface ProjectManifest {
  project_id: string;
  name: string;
  description?: string;
  embedding_model?: EmbeddingModel;
  stats: {
    sources_count: number;
    chunks_count: number;
    vectors_count: number;
  };
}

interface ServerConfig {
  server_name: string;
  server_description: string;
  port: number;
  include_http: boolean;
}

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ChatRequest {
  question: string;
  conversation_id?: string; // Session identifier for multi-turn conversations
  messages?: Message[]; // Previous conversation turns
  system_prompt?: string;
  model?: string;
  top_k?: number;
}

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_SERVER_CONFIG: ServerConfig = {
  server_name: "indexfoundry-rag",
  server_description: "Search the indexed knowledge base",
  port: 8080,
  include_http: true,
};

/**
 * The embedding model used at query time MUST match the one used to build the
 * index, or query vectors land in a different space than the stored vectors.
 * This is read from project.json rather than baked in at export time.
 */
const DEFAULT_EMBEDDING_MODEL: EmbeddingModel = {
  provider: "openai",
  model_name: "text-embedding-3-small",
  api_key_env: "OPENAI_API_KEY",
};

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch (err) {
    console.error(`Failed to parse ${filePath}:`, err);
    return null;
  }
}

const serverConfig: ServerConfig = {
  ...DEFAULT_SERVER_CONFIG,
  ...(readJsonFile<Partial<ServerConfig>>(join(PROJECT_DIR, "server.config.json")) ?? {}),
};

// ============================================================================
// Data Loading
// ============================================================================

let chunks: Chunk[] = [];
let vectors: Vector[] = [];
let sources: Source[] = [];
let manifest: ProjectManifest | null = null;
let embeddingModel: EmbeddingModel = DEFAULT_EMBEDDING_MODEL;
let searchContext: SearchContext = buildSearchContext([], []);
const sourceMap = new Map<string, Source>();

function loadJsonl<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8").trim();
  if (!content) return [];
  return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

function loadData(): void {
  const chunksPath = join(DATA_DIR, "chunks.jsonl");
  const vectorsPath = join(DATA_DIR, "vectors.jsonl");
  const sourcesPath = join(PROJECT_DIR, "sources.jsonl");
  const manifestPath = join(PROJECT_DIR, "project.json");

  // Load project manifest
  manifest = readJsonFile<ProjectManifest>(manifestPath);
  if (manifest) {
    console.error(`Project: ${manifest.name || "unknown"}`);
    if (manifest.embedding_model) {
      embeddingModel = manifest.embedding_model;
    }
  }
  console.error(
    `Embedding model: ${embeddingModel.provider}/${embeddingModel.model_name} ` +
      `(key: ${embeddingModel.api_key_env})`
  );

  // Load sources from JSONL
  sources = loadJsonl<Source>(sourcesPath);
  sources.forEach((s) => sourceMap.set(s.source_id, s));
  console.error(`Loaded ${sources.length} sources`);

  chunks = loadJsonl<Chunk>(chunksPath);
  vectors = loadJsonl<Vector>(vectorsPath);
  searchContext = buildSearchContext(chunks, vectors);

  console.error(`Loaded ${chunks.length} chunks, ${vectors.length} vectors`);

  // Fail loudly if the stored vectors came from a different model than the one
  // we are about to embed queries with. Silently mismatched spaces produce
  // plausible-looking but meaningless rankings.
  const storedModel = vectors[0]?.model;
  if (storedModel && !storedModel.includes(embeddingModel.model_name)) {
    console.error(
      `WARNING: index was built with '${storedModel}' but queries will use ` +
        `'${embeddingModel.model_name}'. Semantic search results will be unreliable. ` +
        `Rebuild the index or correct embedding_model in project.json.`
    );
  }
}

// ============================================================================
// Result Enrichment
// ============================================================================

interface EnrichedResult {
  chunk_id: string;
  text: string;
  score: number;
  source_id: string;
  source_url: string | null;
  source_name: string | null;
  source_type: string | null;
  position: Chunk["position"];
  metadata: Record<string, unknown>;
}

function enrichWithSource(chunk: Chunk, score: number): EnrichedResult {
  const source = sourceMap.get(chunk.source_id);
  return {
    chunk_id: chunk.chunk_id,
    text: chunk.text,
    score: Math.round(score * 10000) / 10000, // Round to 4 decimal places
    source_id: chunk.source_id,
    source_url: source?.uri || null,
    source_name: source?.source_name || null,
    source_type: source?.type || null,
    position: chunk.position,
    metadata: chunk.metadata,
  };
}

/**
 * Generate a query embedding using the model recorded in project.json.
 */
async function generateQueryEmbedding(query: string): Promise<number[]> {
  if (embeddingModel.provider !== "openai") {
    throw new Error(
      `Unsupported embedding provider '${embeddingModel.provider}' for query-time ` +
        `embedding. The exported server currently supports 'openai' only.`
    );
  }

  const apiKey = process.env[embeddingModel.api_key_env];
  if (!apiKey) {
    throw new Error(`${embeddingModel.api_key_env} not configured`);
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: embeddingModel.model_name,
      input: query,
    }),
  });

  if (!response.ok) {
    throw new Error(`Embedding API error: ${response.status}`);
  }

  const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

// ============================================================================
// MCP Server
// ============================================================================

const server = new Server(
  { name: serverConfig.server_name, version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search",
      description: `${serverConfig.server_description}. Returns relevant text chunks with source citations.`,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural language search query",
          },
          query_vector: {
            type: "array",
            items: { type: "number" },
            description:
              "Pre-computed embedding vector for semantic search. Required for semantic/hybrid modes.",
          },
          mode: {
            type: "string",
            enum: ["semantic", "keyword", "hybrid"],
            default: "keyword",
            description:
              "Search mode: keyword (fast, exact match), semantic (embedding similarity), hybrid (combined)",
          },
          top_k: {
            type: "number",
            default: 10,
            minimum: 1,
            maximum: 100,
            description: "Number of results to return",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "get_chunk",
      description:
        "Retrieve a specific chunk by its ID. Use this to get full context for a search result.",
      inputSchema: {
        type: "object",
        properties: {
          chunk_id: {
            type: "string",
            description: "The chunk_id from a search result",
          },
        },
        required: ["chunk_id"],
      },
    },
    {
      name: "list_sources",
      description: "List all indexed sources with their URIs and status",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "stats",
      description:
        "Get index statistics including chunk count, vector count, and source count",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "search": {
      const {
        query,
        query_vector,
        mode = "keyword",
        top_k = 10,
      } = args as {
        query: string;
        query_vector?: number[];
        mode?: string;
        top_k?: number;
      };

      // Validate inputs
      if (!query || typeof query !== "string") {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "query is required" }) }],
          isError: true,
        };
      }

      const effectiveTopK = Math.min(Math.max(1, top_k), 100);

      let results: ScoredChunk[];
      try {
        results = runSearch(searchContext, {
          query,
          queryVector: query_vector,
          mode,
          topK: effectiveTopK,
        });
      } catch (err) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: (err as Error).message }) },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                results: results.map((r) => enrichWithSource(r.chunk, r.score)),
                total: results.length,
                query,
                mode,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case "get_chunk": {
      const { chunk_id } = args as { chunk_id: string };

      if (!chunk_id) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "chunk_id is required" }) }],
          isError: true,
        };
      }

      const chunk = searchContext.chunkMap.get(chunk_id);
      if (!chunk) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: "Chunk not found", chunk_id }) },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(enrichWithSource(chunk, 1.0), null, 2),
          },
        ],
      };
    }

    case "list_sources": {
      const sourceList = sources.map((s) => ({
        source_id: s.source_id,
        type: s.type,
        uri: s.uri,
        name: s.source_name || null,
        status: s.status,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ sources: sourceList, total: sourceList.length }, null, 2),
          },
        ],
      };
    }

    case "stats": {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                project: manifest?.name || serverConfig.server_name,
                chunks: chunks.length,
                vectors: vectors.length,
                sources: sources.length,
                has_embeddings: vectors.length > 0,
                embedding_model: embeddingModel.model_name,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    default:
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
        isError: true,
      };
  }
});

// ============================================================================
// HTTP Server
// ============================================================================

function startHttpServer(): void {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Request logging
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - start;
      console.error(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    });
    next();
  });

  // CORS middleware
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });

  // Health check endpoint
  app.get("/health", (_, res) => {
    res.json({
      status: "ok",
      project: manifest?.name || serverConfig.server_name,
      chunks: chunks.length,
      vectors: vectors.length,
      sources: sources.length,
      uptime: Math.floor(process.uptime()),
    });
  });

  // Stats endpoint
  app.get("/stats", (_, res) => {
    res.json({
      project: manifest?.name || serverConfig.server_name,
      description: manifest?.description || serverConfig.server_description,
      chunks: chunks.length,
      vectors: vectors.length,
      sources: sources.length,
      has_embeddings: vectors.length > 0,
      embedding_model: embeddingModel.model_name,
    });
  });

  // List sources endpoint
  app.get("/sources", (_, res) => {
    res.json({
      sources: sources.map((s) => ({
        source_id: s.source_id,
        type: s.type,
        uri: s.uri,
        name: s.source_name || null,
        status: s.status,
      })),
      total: sources.length,
    });
  });

  // Search endpoint
  app.post("/search", async (req, res) => {
    try {
      const { query, query_vector, mode = "keyword", top_k = 10 } = req.body;

      if (!query || typeof query !== "string") {
        return res.status(400).json({ error: "query is required and must be a string" });
      }

      const effectiveTopK = Math.min(Math.max(1, top_k || 10), 100);

      let results: ScoredChunk[];
      try {
        results = runSearch(searchContext, {
          query,
          queryVector: query_vector,
          mode,
          topK: effectiveTopK,
        });
      } catch (err) {
        return res.status(400).json({ error: (err as Error).message });
      }

      res.json({
        results: results.map((r) => enrichWithSource(r.chunk, r.score)),
        total: results.length,
        query,
        mode,
      });
    } catch (error) {
      console.error("Search error:", error);
      res.status(500).json({ error: "Search failed" });
    }
  });

  // Get chunk by ID
  app.get("/chunks/:chunk_id", (req, res) => {
    const chunk = searchContext.chunkMap.get(req.params.chunk_id);
    if (!chunk) {
      return res.status(404).json({ error: "Chunk not found" });
    }
    res.json(enrichWithSource(chunk, 1.0));
  });

  // Chat endpoint - RAG + LLM with streaming
  app.post("/chat", async (req, res) => {
    const {
      question,
      system_prompt,
      top_k = 10,
      model,
      conversation_id,
      messages = [],
    } = req.body as ChatRequest;

    if (!question || typeof question !== "string") {
      return res.status(400).json({ error: "question is required" });
    }

    const apiKey = process.env[embeddingModel.api_key_env] || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: `${embeddingModel.api_key_env} not configured` });
    }

    // Generate conversation_id if not provided
    const activeConversationId = conversation_id || randomUUID();

    // Build conversation history context (last 10 turns)
    const recentMessages = (messages || []).slice(-10);
    const conversationHistory =
      recentMessages.length > 0
        ? `\n\nCONVERSATION HISTORY:\n${recentMessages
            .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
            .join("\n")}`
        : "";

    // Search for relevant context using hybrid search
    const { results: searchResults } = await searchHybrid(
      searchContext,
      question,
      Math.min(top_k, 10),
      generateQueryEmbedding,
      (msg) => console.error(msg)
    );

    // Build context with source citations
    const contextParts = searchResults.map((r, i) => {
      const source = sourceMap.get(r.chunk.source_id);
      const sourceName = source?.source_name || source?.uri || "Unknown";
      return `[Source ${i + 1}: ${sourceName}]\n${r.chunk.text}`;
    });
    const context = contextParts.join("\n\n---\n\n");

    const projectName = manifest?.name || serverConfig.server_name;
    const defaultSystemPrompt = `You are a helpful assistant with access to a knowledge base about ${projectName}.
Answer questions using ONLY the retrieved documents below. Always cite sources using [Source N] notation.
If the documents don't contain relevant information to answer the question, say so clearly.

RETRIEVED DOCUMENTS:
${context || "No relevant documents found."}${conversationHistory}`;

    const finalSystemPrompt = system_prompt
      ? `${system_prompt}\n\nRETRIEVED DOCUMENTS:\n${context || "No relevant documents found."}${conversationHistory}`
      : defaultSystemPrompt;

    // Set up SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Send sources first
    res.write(
      `data: ${JSON.stringify({
        type: "sources",
        sources: searchResults.map((r) => enrichWithSource(r.chunk, r.score)),
      })}\n\n`
    );

    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model || process.env.OPENAI_MODEL || "gpt-5-nano-2025-08-07",
          messages: [
            { role: "system", content: finalSystemPrompt },
            { role: "user", content: question },
          ],
          stream: true,
          max_completion_tokens: 2048,
        }),
      });

      if (!response.ok) {
        const error = await response
          .json()
          .catch(() => ({ error: { message: "API request failed" } }));
        res.write(
          `data: ${JSON.stringify({
            type: "error",
            error: error.error?.message || "API request failed",
          })}\n\n`
        );
        res.end();
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        res.write(`data: ${JSON.stringify({ type: "error", error: "No response body" })}\n\n`);
        res.end();
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let contentStreamed = false;

      // Debug counters for diagnosing empty responses
      let chunkCount = 0;
      let finishReason: string | null = null;
      let totalLinesParsed = 0;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          totalLinesParsed++;

          if (line.startsWith("data: ")) {
            if (line === "data: [DONE]") {
              console.error(
                `[DEBUG] Stream completed. Chunks: ${chunkCount}, ` +
                  `Finish reason: ${finishReason}, Lines parsed: ${totalLinesParsed}`
              );
              continue;
            }

            try {
              const data = JSON.parse(line.slice(6));
              const content = data.choices?.[0]?.delta?.content;
              finishReason = data.choices?.[0]?.finish_reason || finishReason;

              // Log first chunk for debugging
              if (chunkCount === 0 && content) {
                console.error(
                  `[DEBUG] First content chunk received: "${content.substring(0, 50)}${
                    content.length > 50 ? "..." : ""
                  }"`
                );
              }

              if (content) {
                res.write(`data: ${JSON.stringify({ type: "delta", text: content })}\n\n`);
                contentStreamed = true;
                chunkCount++;
              }
            } catch {
              // Skip unparseable lines
            }
          }
        }
      }

      // Log warning if LLM returned no content
      if (!contentStreamed) {
        console.error("[WARN] LLM returned no content. This may indicate:");
        console.error(`  - Invalid or missing ${embeddingModel.api_key_env}`);
        console.error("  - Model rate limiting or API issues");
        console.error("  - Empty response from the model");
      }

      res.write(
        `data: ${JSON.stringify({
          type: "done",
          conversation_id: activeConversationId,
          empty_response: !contentStreamed,
        })}\n\n`
      );
      res.end();
    } catch (error) {
      console.error("Chat error:", error);
      res.write(
        `data: ${JSON.stringify({ type: "error", error: "Failed to generate response" })}\n\n`
      );
      res.end();
    }
  });

  // Error handler
  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      console.error("Unhandled error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  );

  const PORT = parseInt(process.env.PORT || String(serverConfig.port));
  app.listen(PORT, () => {
    console.error(`HTTP server listening on port ${PORT}`);
    console.error("Endpoints: /health, /stats, /sources, /search, /chunks/:id, /chat");
  });
}

// ============================================================================
// Server Startup
// ============================================================================

loadData();

// MCP clients launch this process over stdio by default. Only bind the HTTP
// API when the deployment explicitly opts in with INDEXFOUNDRY_HTTP=1.
if (shouldStartHttp(serverConfig)) {
  startHttpServer();
}

const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  console.error("Failed to connect MCP transport:", err);
  process.exit(1);
});

console.error(
  `${serverConfig.server_name} MCP server running ` +
    `(chunks: ${chunks.length}, vectors: ${vectors.length})`
);
