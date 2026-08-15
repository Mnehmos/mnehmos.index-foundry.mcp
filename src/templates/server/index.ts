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
import { randomUUID, timingSafeEqual } from "crypto";
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
const FRONTEND_DIR = join(PROJECT_DIR, "frontend");

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

const CHAT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_CHAT_RATE_LIMIT = 30;
const chatRateLimit = new Map<string, { count: number; resetAt: number }>();
let missingTokenWarningLogged = false;

function configuredCorsOrigins(): Set<string> {
  return new Set(
    (process.env.CORS_ORIGINS || "")
      .split(",")
      .map(origin => origin.trim())
      .filter(origin => origin.length > 0 && origin !== "*")
  );
}

function tokenMatches(expected: string, received: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes);
}

function requireApiToken(req: express.Request, res: express.Response): boolean {
  const expectedToken = process.env.RAG_API_TOKEN?.trim();
  if (!expectedToken) {
    if (process.env.NODE_ENV === "production") {
      res.status(503).json({ error: "RAG_API_TOKEN is not configured" });
      return false;
    }
    if (!missingTokenWarningLogged) {
      console.error("[WARN] RAG_API_TOKEN is not configured; chat auth is disabled outside production");
      missingTokenWarningLogged = true;
    }
    return true;
  }

  const authorization = req.header("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match || !tokenMatches(expectedToken, match[1])) {
    res.status(401).json({ error: "Bearer token required" });
    return false;
  }
  return true;
}

function rateLimitChatRequest(req: express.Request, res: express.Response): boolean {
  const configuredLimit = Number.parseInt(process.env.CHAT_RATE_LIMIT_PER_MINUTE || "", 10);
  const limit = Number.isFinite(configuredLimit) && configuredLimit > 0
    ? configuredLimit
    : DEFAULT_CHAT_RATE_LIMIT;
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  for (const [entryKey, entry] of chatRateLimit) {
    if (entry.resetAt <= now) chatRateLimit.delete(entryKey);
  }
  const current = chatRateLimit.get(key);

  if (!current || current.resetAt <= now) {
    chatRateLimit.set(key, { count: 1, resetAt: now + CHAT_RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (current.count >= limit) {
    res.setHeader("Retry-After", Math.ceil((current.resetAt - now) / 1000));
    res.status(429).json({ error: "Chat rate limit exceeded" });
    return false;
  }

  current.count++;
  return true;
}

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

function registerRequestMiddleware(app: express.Express): void {
  // Request logging
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - start;
      console.error(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    });
    next();
  });

  // CORS middleware. Same-origin requests work by default; cross-origin
  // callers must be listed in CORS_ORIGINS (comma-separated exact origins).
  app.use((req, res, next) => {
    const origin = req.header("origin");
    const requestOrigin = `${req.protocol}://${req.get("host")}`;
    if (origin && origin !== requestOrigin && !configuredCorsOrigins().has(origin)) {
      return res.status(403).json({ error: "Origin is not allowed" });
    }
    if (origin) {
      res.header("Access-Control-Allow-Origin", origin);
      res.header("Vary", "Origin");
    }
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });
}

function registerFrontendRoute(app: express.Express): void {
  if (!existsSync(FRONTEND_DIR)) return;

  // Serve the generated workbench from the same origin as the RAG API.
  // This keeps exported projects deployable as one Railway service while
  // preserving the API-only behavior for projects without a frontend.
  app.use(express.static(FRONTEND_DIR, { index: "index.html" }));
}

function registerHealthRoute(app: express.Express): void {
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
}

function registerStatsRoute(app: express.Express): void {
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
}

function registerSourcesRoute(app: express.Express): void {
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
}

function registerSearchRoute(app: express.Express): void {
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
}

function registerChunkRoute(app: express.Express): void {
  // Get chunk by ID
  app.get("/chunks/:chunk_id", (req, res) => {
    const chunk = searchContext.chunkMap.get(req.params.chunk_id);
    if (!chunk) {
      return res.status(404).json({ error: "Chunk not found" });
    }
    res.json(enrichWithSource(chunk, 1.0));
  });
}

function buildConversationHistory(messages: Message[] | null = []): string {
  const recentMessages = (messages || []).slice(-10);
  if (recentMessages.length === 0) return "";

  return `\\n\\nCONVERSATION HISTORY:\\n${recentMessages
    .map(message => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
    .join("\\n")}`;
}

function buildRetrievedContext(searchResults: ScoredChunk[]): string {
  return searchResults
    .map((result, index) => {
      const source = sourceMap.get(result.chunk.source_id);
      const sourceName = source?.source_name || source?.uri || "Unknown";
      return `[Source ${index + 1}: ${sourceName}]\\n${result.chunk.text}`;
    })
    .join("\\n\\n---\\n\\n");
}

function buildChatSystemPrompt(
  systemPrompt: string | undefined,
  context: string,
  conversationHistory: string
): string {
  const projectName = manifest?.name || serverConfig.server_name;
  const retrievedDocuments = context || "No relevant documents found.";
  const defaultPrompt = `You are a helpful assistant with access to a knowledge base about ${projectName}.
Answer questions using ONLY the retrieved documents below. Always cite sources using [Source N] notation.
If the documents don't contain relevant information to answer the question, say so clearly.

RETRIEVED DOCUMENTS:
${retrievedDocuments}${conversationHistory}`;

  return systemPrompt
    ? `${systemPrompt}\\n\\nRETRIEVED DOCUMENTS:\\n${retrievedDocuments}${conversationHistory}`
    : defaultPrompt;
}

function writeSse(res: express.Response, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\\n\\n`);
}

async function streamChatCompletion(
  response: Response,
  res: express.Response
): Promise<boolean | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    writeSse(res, { type: "error", error: "No response body" });
    res.end();
    return null;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let contentStreamed = false;
  let chunkCount = 0;
  let finishReason: string | null = null;
  let totalLinesParsed = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      totalLinesParsed++;
      if (!line.startsWith("data: ")) continue;
      if (line === "data: [DONE]") {
        console.error(
          `[DEBUG] Stream completed. Chunks: ${chunkCount}, Finish reason: ${finishReason}, Lines parsed: ${totalLinesParsed}`
        );
        continue;
      }

      try {
        const data = JSON.parse(line.slice(6));
        const content = data.choices?.[0]?.delta?.content;
        finishReason = data.choices?.[0]?.finish_reason || finishReason;

        if (chunkCount === 0 && content) {
          console.error(
            `[DEBUG] First content chunk received: "${content.substring(0, 50)}${content.length > 50 ? "..." : ""}"`
          );
        }

        if (content) {
          writeSse(res, { type: "delta", text: content });
          contentStreamed = true;
          chunkCount++;
        }
      } catch {
        // Skip unparseable lines.
      }
    }
  }

  return contentStreamed;
}

function registerChatRoute(app: express.Express): void {
  app.post("/chat", async (req, res) => {
    if (!requireApiToken(req, res) || !rateLimitChatRequest(req, res)) return;

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

    const embeddingApiKey = process.env[embeddingModel.api_key_env];
    const chatApiKey = process.env.OPENAI_API_KEY;
    if (!embeddingApiKey) {
      return res.status(500).json({ error: `${embeddingModel.api_key_env} not configured` });
    }
    if (!chatApiKey) {
      return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
    }

    const activeConversationId = conversation_id || randomUUID();
    const conversationHistory = buildConversationHistory(messages);
    const { results: searchResults } = await searchHybrid(
      searchContext,
      question,
      Math.min(top_k, 10),
      generateQueryEmbedding,
      message => console.error(message)
    );
    const context = buildRetrievedContext(searchResults);
    const finalSystemPrompt = buildChatSystemPrompt(
      system_prompt,
      context,
      conversationHistory
    );

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    writeSse(res, {
      type: "sources",
      sources: searchResults.map(result => enrichWithSource(result.chunk, result.score)),
    });

    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${chatApiKey}`,
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
        writeSse(res, {
          type: "error",
          error: error.error?.message || "API request failed",
        });
        res.end();
        return;
      }

      const contentStreamed = await streamChatCompletion(response, res);
      if (contentStreamed === null) return;

      if (!contentStreamed) {
        console.error("[WARN] LLM returned no content. This may indicate:");
        console.error(`  - Invalid or missing ${embeddingModel.api_key_env}`);
        console.error("  - Model rate limiting or API issues");
        console.error("  - Empty response from the model");
      }

      writeSse(res, {
        type: "done",
        conversation_id: activeConversationId,
        empty_response: !contentStreamed,
      });
      res.end();
    } catch (error) {
      console.error("Chat error:", error);
      writeSse(res, { type: "error", error: "Failed to generate response" });
      res.end();
    }
  });
}

function registerErrorHandler(app: express.Express): void {
  // Error handler
  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      console.error("Unhandled error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  );
}

function startHttpServer(): void {

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  registerRequestMiddleware(app);
  registerFrontendRoute(app);
  registerHealthRoute(app);
  registerStatsRoute(app);
  registerSourcesRoute(app);
  registerSearchRoute(app);
  registerChunkRoute(app);
  registerChatRoute(app);
  registerErrorHandler(app);

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
