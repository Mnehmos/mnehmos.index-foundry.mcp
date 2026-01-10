/**
 * IndexFoundry-MCP: Serve Tools (Phase 5)
 *
 * Complete HTTP server implementation for vector search API.
 * Includes semantic search, hybrid search, and full server lifecycle management.
 *
 * Copyright (c) 2024 vario.automation
 * Proprietary and confidential. All rights reserved.
 */

import * as http from "http";
import * as path from "path";
import * as fs from "fs/promises";
import type {
  ToolError,
  VectorManifest,
  DocumentChunk,
  EmbeddingRecord
} from "../types.js";
import type {
  ServeOpenapiInput,
  ServeStartInput,
  ServeStopInput,
  ServeStatusInput,
  ServeQueryInput
} from "../schemas.js";
import {
  pathExists,
  ensureDir,
  readJson,
  readJsonl,
  writeJson,
  createToolError,
  now,
  timed,
  cosineSimilarity,
} from "../utils.js";
import { getRunManager } from "../run-manager.js";

// ============================================================================
// Server Instance Registry
// ============================================================================

interface ServerInstance {
  server: http.Server;
  run_id: string;
  host: string;
  port: number;
  started_at: string;
  requests_served: number;
  vectors: VectorRecord[];
  chunks: Map<string, DocumentChunk>;
  profile: RetrievalProfile | null;
}

interface VectorRecord {
  id: string;
  vector: number[];
  metadata: Record<string, unknown>;
  text?: string;
}

interface RetrievalProfile {
  retrieval: {
    default_top_k: number;
    search_modes: string[];
    hybrid_config?: {
      alpha: number;
      fusion_method: string;
    };
  };
  filters?: Array<{
    field: string;
    operators: string[];
  }>;
  security?: {
    require_auth: boolean;
    allowed_namespaces?: string[];
  };
}

// Global server registry (keyed by run_id)
const serverRegistry = new Map<string, ServerInstance>();

// ============================================================================
// Vector Search Implementation
// ============================================================================

function semanticSearch(
  queryVector: number[],
  vectors: VectorRecord[],
  topK: number,
  filters?: Record<string, unknown>
): Array<{ id: string; score: number; metadata: Record<string, unknown>; text?: string }> {
  // Apply filters
  let candidates = vectors;
  if (filters && Object.keys(filters).length > 0) {
    candidates = vectors.filter(v => {
      for (const [key, value] of Object.entries(filters)) {
        const fieldValue = v.metadata[key];
        if (fieldValue !== value) return false;
      }
      return true;
    });
  }

  // Calculate similarities
  const scored = candidates.map(v => ({
    id: v.id,
    score: cosineSimilarity(queryVector, v.vector),
    metadata: v.metadata,
    text: v.text,
  }));

  // Sort by score descending and take top K
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

function keywordSearch(
  query: string,
  vectors: VectorRecord[],
  topK: number,
  filters?: Record<string, unknown>
): Array<{ id: string; score: number; metadata: Record<string, unknown>; text?: string }> {
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);

  // Apply filters
  let candidates = vectors;
  if (filters && Object.keys(filters).length > 0) {
    candidates = vectors.filter(v => {
      for (const [key, value] of Object.entries(filters)) {
        const fieldValue = v.metadata[key];
        if (fieldValue !== value) return false;
      }
      return true;
    });
  }

  // Score by term frequency
  const scored = candidates
    .filter(v => v.text)
    .map(v => {
      const textLower = v.text!.toLowerCase();
      let score = 0;
      for (const term of queryTerms) {
        const regex = new RegExp(term, 'gi');
        const matches = textLower.match(regex);
        score += matches ? matches.length : 0;
      }
      // Normalize by text length
      score = score / Math.sqrt(v.text!.length);
      return {
        id: v.id,
        score,
        metadata: v.metadata,
        text: v.text,
      };
    });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

function hybridSearch(
  queryVector: number[],
  query: string,
  vectors: VectorRecord[],
  topK: number,
  alpha: number = 0.7,
  fusionMethod: string = "rrf",
  filters?: Record<string, unknown>
): Array<{ id: string; score: number; metadata: Record<string, unknown>; text?: string }> {
  // Get more results for reranking
  const expandedK = Math.min(topK * 3, vectors.length);

  const semanticResults = semanticSearch(queryVector, vectors, expandedK, filters);
  const keywordResults = keywordSearch(query, vectors, expandedK, filters);

  if (fusionMethod === "rrf") {
    // Reciprocal Rank Fusion
    const k = 60; // RRF constant
    const scores = new Map<string, number>();

    semanticResults.forEach((r, i) => {
      const rrf = alpha / (k + i + 1);
      scores.set(r.id, (scores.get(r.id) || 0) + rrf);
    });

    keywordResults.forEach((r, i) => {
      const rrf = (1 - alpha) / (k + i + 1);
      scores.set(r.id, (scores.get(r.id) || 0) + rrf);
    });

    // Build result set
    const allResults = new Map<string, { metadata: Record<string, unknown>; text?: string }>();
    for (const r of [...semanticResults, ...keywordResults]) {
      if (!allResults.has(r.id)) {
        allResults.set(r.id, { metadata: r.metadata, text: r.text });
      }
    }

    const merged = Array.from(scores.entries()).map(([id, score]) => ({
      id,
      score,
      metadata: allResults.get(id)!.metadata,
      text: allResults.get(id)!.text,
    }));

    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, topK);
  } else {
    // Weighted sum
    const semanticScoreMap = new Map(semanticResults.map(r => [r.id, r.score]));
    const keywordScoreMap = new Map(keywordResults.map(r => [r.id, r.score]));

    const allIds = new Set([
      ...semanticResults.map(r => r.id),
      ...keywordResults.map(r => r.id)
    ]);

    const allResults = new Map<string, { metadata: Record<string, unknown>; text?: string }>();
    for (const r of [...semanticResults, ...keywordResults]) {
      if (!allResults.has(r.id)) {
        allResults.set(r.id, { metadata: r.metadata, text: r.text });
      }
    }

    const merged = Array.from(allIds).map(id => {
      const semanticScore = semanticScoreMap.get(id) || 0;
      const keywordScore = keywordScoreMap.get(id) || 0;
      return {
        id,
        score: alpha * semanticScore + (1 - alpha) * keywordScore,
        metadata: allResults.get(id)!.metadata,
        text: allResults.get(id)!.text,
      };
    });

    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, topK);
  }
}

// ============================================================================
// HTTP Server Implementation
// ============================================================================

function createSearchServer(instance: ServerInstance): http.Server {
  const server = http.createServer(async (req, res) => {
    const startTime = Date.now();
    instance.requests_served++;

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const pathname = url.pathname;

    const sendJson = (statusCode: number, data: unknown) => {
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };

    const parseBody = (): Promise<unknown> => {
      return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
          try {
            resolve(body ? JSON.parse(body) : {});
          } catch {
            reject(new Error("Invalid JSON"));
          }
        });
        req.on("error", reject);
      });
    };

    try {
      // Health check
      if (pathname === "/health" && req.method === "GET") {
        sendJson(200, {
          status: "healthy",
          run_id: instance.run_id,
          vectors_count: instance.vectors.length,
          uptime_ms: Date.now() - new Date(instance.started_at).getTime(),
          requests_served: instance.requests_served,
        });
        return;
      }

      // Stats
      if (pathname === "/stats" && req.method === "GET") {
        sendJson(200, {
          run_id: instance.run_id,
          vectors_count: instance.vectors.length,
          chunks_count: instance.chunks.size,
          dimensions: instance.vectors[0]?.vector.length || 0,
          started_at: instance.started_at,
          requests_served: instance.requests_served,
          profile: instance.profile,
        });
        return;
      }

      // Get chunk by ID
      if (pathname.startsWith("/chunks/") && req.method === "GET") {
        const chunkId = pathname.replace("/chunks/", "");
        const chunk = instance.chunks.get(chunkId);

        if (!chunk) {
          sendJson(404, { error: "Chunk not found", chunk_id: chunkId });
          return;
        }

        sendJson(200, {
          chunk_id: chunk.chunk_id,
          doc_id: chunk.doc_id,
          text: chunk.content.text,
          position: chunk.position,
          metadata: chunk.metadata,
          source: chunk.source,
        });
        return;
      }

      // Get document chunks by doc_id
      if (pathname.startsWith("/documents/") && req.method === "GET") {
        const docId = pathname.replace("/documents/", "");
        const docChunks = Array.from(instance.chunks.values())
          .filter(c => c.doc_id === docId)
          .sort((a, b) => a.chunk_index - b.chunk_index);

        if (docChunks.length === 0) {
          sendJson(404, { error: "Document not found", doc_id: docId });
          return;
        }

        sendJson(200, {
          doc_id: docId,
          chunks_count: docChunks.length,
          source: docChunks[0].source,
          chunks: docChunks.map(c => ({
            chunk_id: c.chunk_id,
            chunk_index: c.chunk_index,
            text: c.content.text,
            position: c.position,
          })),
        });
        return;
      }

      // Semantic search
      if (pathname === "/search/semantic" && req.method === "POST") {
        const body = await parseBody() as {
          query?: string;
          query_vector?: number[];
          top_k?: number;
          filters?: Record<string, unknown>;
          include_text?: boolean;
        };

        if (!body.query_vector && !body.query) {
          sendJson(400, { error: "Either query or query_vector is required" });
          return;
        }

        // If only text query provided, need to embed it first
        // For now, require query_vector for semantic search
        if (!body.query_vector) {
          sendJson(400, {
            error: "query_vector is required for semantic search",
            hint: "Use /search/hybrid for text-only queries, or embed the query first"
          });
          return;
        }

        const topK = body.top_k || instance.profile?.retrieval.default_top_k || 10;

        const { result: results, duration_ms } = await timed(async () =>
          semanticSearch(body.query_vector!, instance.vectors, topK, body.filters)
        );

        sendJson(200, {
          results: results.map((r: { id: string; score: number; metadata: Record<string, unknown>; text?: string }) => ({
            chunk_id: r.id,
            score: r.score,
            text: body.include_text !== false ? r.text : undefined,
            metadata: r.metadata,
          })),
          total: results.length,
          took_ms: duration_ms,
        });
        return;
      }

      // Hybrid search
      if (pathname === "/search/hybrid" && req.method === "POST") {
        const body = await parseBody() as {
          query: string;
          query_vector?: number[];
          top_k?: number;
          alpha?: number;
          filters?: Record<string, unknown>;
          include_text?: boolean;
        };

        if (!body.query) {
          sendJson(400, { error: "query is required" });
          return;
        }

        const topK = body.top_k || instance.profile?.retrieval.default_top_k || 10;
        const alpha = body.alpha ?? instance.profile?.retrieval.hybrid_config?.alpha ?? 0.7;
        const fusionMethod = instance.profile?.retrieval.hybrid_config?.fusion_method || "rrf";

        // If no query_vector, fall back to keyword-only
        if (!body.query_vector) {
          const { result: results, duration_ms } = await timed(async () =>
            keywordSearch(body.query, instance.vectors, topK, body.filters)
          );

          sendJson(200, {
            results: results.map((r: { id: string; score: number; metadata: Record<string, unknown>; text?: string }) => ({
              chunk_id: r.id,
              score: r.score,
              text: body.include_text !== false ? r.text : undefined,
              metadata: r.metadata,
            })),
            total: results.length,
            took_ms: duration_ms,
            mode: "keyword_only",
          });
          return;
        }

        const { result: results, duration_ms } = await timed(async () =>
          hybridSearch(
            body.query_vector!,
            body.query,
            instance.vectors,
            topK,
            alpha,
            fusionMethod,
            body.filters
          )
        );

        sendJson(200, {
          results: results.map((r: { id: string; score: number; metadata: Record<string, unknown>; text?: string }) => ({
            chunk_id: r.id,
            score: r.score,
            text: body.include_text !== false ? r.text : undefined,
            metadata: r.metadata,
          })),
          total: results.length,
          took_ms: duration_ms,
          mode: "hybrid",
          alpha,
          fusion_method: fusionMethod,
        });
        return;
      }

      // Keyword search
      if (pathname === "/search/keyword" && req.method === "POST") {
        const body = await parseBody() as {
          query: string;
          top_k?: number;
          filters?: Record<string, unknown>;
          include_text?: boolean;
        };

        if (!body.query) {
          sendJson(400, { error: "query is required" });
          return;
        }

        const topK = body.top_k || instance.profile?.retrieval.default_top_k || 10;

        const { result: results, duration_ms } = await timed(async () =>
          keywordSearch(body.query, instance.vectors, topK, body.filters)
        );

        sendJson(200, {
          results: results.map((r: { id: string; score: number; metadata: Record<string, unknown>; text?: string }) => ({
            chunk_id: r.id,
            score: r.score,
            text: body.include_text !== false ? r.text : undefined,
            metadata: r.metadata,
          })),
          total: results.length,
          took_ms: duration_ms,
        });
        return;
      }

      // Not found
      sendJson(404, { error: "Endpoint not found", path: pathname });

    } catch (err) {
      console.error("Server error:", err);
      sendJson(500, {
        error: "Internal server error",
        message: err instanceof Error ? err.message : String(err)
      });
    }
  });

  return server;
}

// ============================================================================
// Serve OpenAPI
// ============================================================================

export interface ServeOpenapiResult {
  success: boolean;
  openapi_path: string;
  endpoints_generated: string[];
}

export async function serveOpenapi(input: ServeOpenapiInput): Promise<ServeOpenapiResult | ToolError> {
  const manager = getRunManager();
  
  // Ensure run exists with full infrastructure
  await manager.ensureRun(input.run_id);
  const servedDir = manager.getServedDir(input.run_id);
  const indexedDir = manager.getIndexedDir(input.run_id);

  try {
    // Read vector manifest for schema info
    let manifest: VectorManifest | null = null;
    const manifestPath = path.join(indexedDir, "vector_manifest.json");
    if (await pathExists(manifestPath)) {
      manifest = await readJson<VectorManifest>(manifestPath);
    }

    // Build OpenAPI spec
    const spec: Record<string, unknown> = {
      openapi: "3.1.0",
      info: {
        title: input.api_info.title,
        version: input.api_info.version,
        description: input.api_info.description || "Auto-generated by IndexFoundry-MCP",
      },
      servers: [
        {
          url: `http://localhost:8080${input.api_info.base_path}`,
          description: "Local development server",
        },
      ],
      paths: {},
      components: {
        schemas: {},
      },
    };

    const paths = spec.paths as Record<string, unknown>;
    const schemas = (spec.components as { schemas: Record<string, unknown> }).schemas;

    // Add common schemas
    if (input.include_schemas) {
      schemas.SearchResult = {
        type: "object",
        properties: {
          chunk_id: { type: "string" },
          text: { type: "string" },
          score: { type: "number" },
          metadata: { type: "object" },
        },
      };

      schemas.SemanticSearchRequest = {
        type: "object",
        required: ["query_vector"],
        properties: {
          query_vector: {
            type: "array",
            items: { type: "number" },
            description: "Pre-computed query embedding vector"
          },
          top_k: { type: "integer", default: 10 },
          filters: { type: "object" },
          include_text: { type: "boolean", default: true },
        },
      };

      schemas.HybridSearchRequest = {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Text search query" },
          query_vector: {
            type: "array",
            items: { type: "number" },
            description: "Optional: pre-computed query embedding for hybrid search"
          },
          top_k: { type: "integer", default: 10 },
          alpha: {
            type: "number",
            minimum: 0,
            maximum: 1,
            default: 0.7,
            description: "Weight for semantic vs keyword (1=pure semantic)"
          },
          filters: { type: "object" },
          include_text: { type: "boolean", default: true },
        },
      };

      schemas.KeywordSearchRequest = {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Text search query" },
          top_k: { type: "integer", default: 10 },
          filters: { type: "object" },
          include_text: { type: "boolean", default: true },
        },
      };

      schemas.ChunkResponse = {
        type: "object",
        properties: {
          chunk_id: { type: "string" },
          doc_id: { type: "string" },
          text: { type: "string" },
          position: { type: "object" },
          metadata: { type: "object" },
          source: { type: "object" },
        },
      };

      schemas.HealthResponse = {
        type: "object",
        properties: {
          status: { type: "string", enum: ["healthy", "degraded", "unhealthy"] },
          run_id: { type: "string" },
          vectors_count: { type: "integer" },
          uptime_ms: { type: "integer" },
          requests_served: { type: "integer" },
        },
      };

      schemas.StatsResponse = {
        type: "object",
        properties: {
          run_id: { type: "string" },
          vectors_count: { type: "integer" },
          chunks_count: { type: "integer" },
          dimensions: { type: "integer" },
          started_at: { type: "string", format: "date-time" },
          requests_served: { type: "integer" },
        },
      };
    }

    // Generate endpoints
    const generatedEndpoints: string[] = [];

    for (const endpoint of input.endpoints) {
      switch (endpoint) {
        case "search_semantic":
          paths["/search/semantic"] = {
            post: {
              summary: "Semantic vector search",
              description: "Search using pre-computed embedding vectors for semantic similarity",
              operationId: "searchSemantic",
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/SemanticSearchRequest" },
                  },
                },
              },
              responses: {
                "200": {
                  description: "Search results",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          results: {
                            type: "array",
                            items: { $ref: "#/components/schemas/SearchResult" },
                          },
                          total: { type: "integer" },
                          took_ms: { type: "number" },
                        },
                      },
                    },
                  },
                },
                "400": { description: "Invalid request" },
              },
            },
          };
          generatedEndpoints.push("POST /search/semantic");
          break;

        case "search_hybrid":
          paths["/search/hybrid"] = {
            post: {
              summary: "Hybrid semantic + keyword search",
              description: "Combined search using both vector similarity and keyword matching with configurable weighting",
              operationId: "searchHybrid",
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/HybridSearchRequest" },
                  },
                },
              },
              responses: {
                "200": {
                  description: "Search results",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          results: {
                            type: "array",
                            items: { $ref: "#/components/schemas/SearchResult" },
                          },
                          total: { type: "integer" },
                          took_ms: { type: "number" },
                          mode: { type: "string" },
                          alpha: { type: "number" },
                          fusion_method: { type: "string" },
                        },
                      },
                    },
                  },
                },
                "400": { description: "Invalid request" },
              },
            },
          };
          generatedEndpoints.push("POST /search/hybrid");
          break;

        case "get_document":
          paths["/documents/{doc_id}"] = {
            get: {
              summary: "Get document by ID",
              description: "Retrieve all chunks belonging to a document",
              operationId: "getDocument",
              parameters: [
                {
                  name: "doc_id",
                  in: "path",
                  required: true,
                  schema: { type: "string" },
                },
              ],
              responses: {
                "200": {
                  description: "Document with all chunks",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          doc_id: { type: "string" },
                          chunks_count: { type: "integer" },
                          source: { type: "object" },
                          chunks: {
                            type: "array",
                            items: { $ref: "#/components/schemas/ChunkResponse" },
                          },
                        },
                      },
                    },
                  },
                },
                "404": { description: "Document not found" },
              },
            },
          };
          generatedEndpoints.push("GET /documents/{doc_id}");
          break;

        case "get_chunk":
          paths["/chunks/{chunk_id}"] = {
            get: {
              summary: "Get chunk by ID",
              description: "Retrieve a specific chunk by its ID",
              operationId: "getChunk",
              parameters: [
                {
                  name: "chunk_id",
                  in: "path",
                  required: true,
                  schema: { type: "string" },
                },
              ],
              responses: {
                "200": {
                  description: "Chunk details",
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/ChunkResponse" },
                    },
                  },
                },
                "404": { description: "Chunk not found" },
              },
            },
          };
          generatedEndpoints.push("GET /chunks/{chunk_id}");
          break;

        case "health":
          paths["/health"] = {
            get: {
              summary: "Health check",
              description: "Check server health and basic statistics",
              operationId: "healthCheck",
              responses: {
                "200": {
                  description: "Service health status",
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/HealthResponse" },
                    },
                  },
                },
              },
            },
          };
          generatedEndpoints.push("GET /health");
          break;

        case "stats":
          paths["/stats"] = {
            get: {
              summary: "Index statistics",
              description: "Get detailed statistics about the loaded index",
              operationId: "getStats",
              responses: {
                "200": {
                  description: "Index statistics",
                  content: {
                    "application/json": {
                      schema: { $ref: "#/components/schemas/StatsResponse" },
                    },
                  },
                },
              },
            },
          };
          generatedEndpoints.push("GET /stats");
          break;
      }
    }

    // Add keyword search endpoint (always available)
    paths["/search/keyword"] = {
      post: {
        summary: "Keyword text search",
        description: "Full-text keyword search without vector similarity",
        operationId: "searchKeyword",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/KeywordSearchRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Search results",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    results: {
                      type: "array",
                      items: { $ref: "#/components/schemas/SearchResult" },
                    },
                    total: { type: "integer" },
                    took_ms: { type: "number" },
                  },
                },
              },
            },
          },
          "400": { description: "Invalid request" },
        },
      },
    };
    generatedEndpoints.push("POST /search/keyword");

    // Write OpenAPI spec
    await writeJson(path.join(servedDir, "openapi.json"), spec);

    return {
      success: true,
      openapi_path: "served/openapi.json",
      endpoints_generated: generatedEndpoints,
    };
  } catch (err) {
    return createToolError("CONFIG_INVALID", `Failed to generate OpenAPI spec: ${err}`, {
      recoverable: false,
    });
  }
}

// ============================================================================
// Serve Start
// ============================================================================

export interface ServeStartResult {
  success: boolean;
  status: "started" | "already_running" | "failed";
  endpoint: string;
  run_id: string;
  vectors_loaded: number;
  chunks_loaded: number;
  message: string;
}

export async function serveStart(input: ServeStartInput): Promise<ServeStartResult | ToolError> {
  const manager = getRunManager();
  
  // Ensure run exists with full infrastructure
  await manager.ensureRun(input.run_id);
  const runDir = manager.getRunDir(input.run_id);
  const indexedDir = manager.getIndexedDir(input.run_id);
  const normalizedDir = manager.getNormalizedDir(input.run_id);
  const servedDir = manager.getServedDir(input.run_id);

  try {
    // Check if already running
    if (serverRegistry.has(input.run_id)) {
      const existing = serverRegistry.get(input.run_id)!;
      return {
        success: true,
        status: "already_running",
        endpoint: `http://${existing.host}:${existing.port}`,
        run_id: input.run_id,
        vectors_loaded: existing.vectors.length,
        chunks_loaded: existing.chunks.size,
        message: `Server already running since ${existing.started_at}`,
      };
    }

    // Load vectors
    const localVectorsPath = path.join(indexedDir, `${input.run_id}.vectors.json`);
    const defaultVectorsPath = path.join(indexedDir, "default.vectors.json");

    let vectorsPath: string | null = null;

    // Try to find any .vectors.json file
    const indexedFiles = await fs.readdir(indexedDir).catch(() => []);
    const vectorFile = indexedFiles.find(f => f.endsWith(".vectors.json"));

    if (vectorFile) {
      vectorsPath = path.join(indexedDir, vectorFile);
    } else if (await pathExists(localVectorsPath)) {
      vectorsPath = localVectorsPath;
    } else if (await pathExists(defaultVectorsPath)) {
      vectorsPath = defaultVectorsPath;
    }

    if (!vectorsPath) {
      return createToolError("CONFIG_INVALID",
        "No vector file found. Run indexfoundry_index_upsert with provider='local' first.", {
        recoverable: false,
        suggestion: "Use indexfoundry_index_upsert with provider: 'local' to create vectors file",
      });
    }

    const vectorData = await readJson<{
      collection: string;
      vectors: VectorRecord[];
    }>(vectorsPath);

    // Load chunks
    const chunksPath = path.join(normalizedDir, "chunks.jsonl");
    let chunks: DocumentChunk[] = [];
    if (await pathExists(chunksPath)) {
      chunks = await readJsonl<DocumentChunk>(chunksPath);
    }

    const chunkMap = new Map<string, DocumentChunk>();
    for (const chunk of chunks) {
      chunkMap.set(chunk.chunk_id, chunk);
    }

    // Load retrieval profile if exists
    let profile: RetrievalProfile | null = null;
    const profilePath = path.join(indexedDir, "retrieval_profile.json");
    if (await pathExists(profilePath)) {
      profile = await readJson<RetrievalProfile>(profilePath);
    }

    // Create server instance
    const instance: ServerInstance = {
      server: null as unknown as http.Server,
      run_id: input.run_id,
      host: input.host,
      port: input.port,
      started_at: now(),
      requests_served: 0,
      vectors: vectorData.vectors || [],
      chunks: chunkMap,
      profile,
    };

    // Create HTTP server
    instance.server = createSearchServer(instance);

    // Start listening
    await new Promise<void>((resolve, reject) => {
      instance.server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          reject(new Error(`Port ${input.port} is already in use`));
        } else {
          reject(err);
        }
      });

      instance.server.listen(input.port, input.host, () => {
        resolve();
      });
    });

    // Register server
    serverRegistry.set(input.run_id, instance);

    // Save server config
    const serverConfig = {
      run_id: input.run_id,
      host: input.host,
      port: input.port,
      cors_origins: input.cors_origins,
      rate_limit: input.rate_limit,
      log_requests: input.log_requests,
      started_at: instance.started_at,
      vectors_loaded: instance.vectors.length,
      chunks_loaded: instance.chunks.size,
    };

    await writeJson(path.join(servedDir, "server_config.json"), serverConfig);

    return {
      success: true,
      status: "started",
      endpoint: `http://${input.host}:${input.port}`,
      run_id: input.run_id,
      vectors_loaded: instance.vectors.length,
      chunks_loaded: instance.chunks.size,
      message: `Server started successfully. API available at http://${input.host}:${input.port}`,
    };
  } catch (err) {
    return createToolError("CONFIG_INVALID", `Failed to start server: ${err}`, {
      recoverable: true,
      suggestion: "Check if the port is available and vectors have been indexed",
    });
  }
}

// ============================================================================
// Serve Stop
// ============================================================================

export interface ServeStopResult {
  success: boolean;
  status: "stopped" | "not_running";
  run_id: string;
  requests_served?: number;
  uptime_ms?: number;
  message: string;
}

export async function serveStop(input: ServeStopInput): Promise<ServeStopResult | ToolError> {
  try {
    const instance = serverRegistry.get(input.run_id);

    if (!instance) {
      return {
        success: true,
        status: "not_running",
        run_id: input.run_id,
        message: "No server running for this run_id",
      };
    }

    const uptime = Date.now() - new Date(instance.started_at).getTime();
    const requestsServed = instance.requests_served;

    // Close server
    await new Promise<void>((resolve, reject) => {
      instance.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Remove from registry
    serverRegistry.delete(input.run_id);

    return {
      success: true,
      status: "stopped",
      run_id: input.run_id,
      requests_served: requestsServed,
      uptime_ms: uptime,
      message: `Server stopped after ${uptime}ms, served ${requestsServed} requests`,
    };
  } catch (err) {
    return createToolError("CONFIG_INVALID", `Failed to stop server: ${err}`, {
      recoverable: true,
    });
  }
}

// ============================================================================
// Serve Status
// ============================================================================

export interface ServeStatusResult {
  success: boolean;
  running: boolean;
  servers: Array<{
    run_id: string;
    endpoint: string;
    started_at: string;
    uptime_ms: number;
    requests_served: number;
    vectors_count: number;
    chunks_count: number;
  }>;
}

export async function serveStatus(input: ServeStatusInput): Promise<ServeStatusResult | ToolError> {
  try {
    const servers: ServeStatusResult["servers"] = [];

    if (input.run_id) {
      // Check specific run
      const instance = serverRegistry.get(input.run_id);
      if (instance) {
        servers.push({
          run_id: instance.run_id,
          endpoint: `http://${instance.host}:${instance.port}`,
          started_at: instance.started_at,
          uptime_ms: Date.now() - new Date(instance.started_at).getTime(),
          requests_served: instance.requests_served,
          vectors_count: instance.vectors.length,
          chunks_count: instance.chunks.size,
        });
      }
    } else {
      // List all running servers
      for (const [runId, instance] of serverRegistry) {
        servers.push({
          run_id: runId,
          endpoint: `http://${instance.host}:${instance.port}`,
          started_at: instance.started_at,
          uptime_ms: Date.now() - new Date(instance.started_at).getTime(),
          requests_served: instance.requests_served,
          vectors_count: instance.vectors.length,
          chunks_count: instance.chunks.size,
        });
      }
    }

    return {
      success: true,
      running: servers.length > 0,
      servers,
    };
  } catch (err) {
    return createToolError("CONFIG_INVALID", `Failed to get server status: ${err}`, {
      recoverable: true,
    });
  }
}

// ============================================================================
// Serve Query (Direct query without HTTP)
// ============================================================================

export interface ServeQueryResult {
  success: boolean;
  results: Array<{
    chunk_id: string;
    score: number;
    text?: string;
    metadata: Record<string, unknown>;
  }>;
  total: number;
  took_ms: number;
  mode: string;
}

export async function serveQuery(input: ServeQueryInput): Promise<ServeQueryResult | ToolError> {
  try {
    const instance = serverRegistry.get(input.run_id);

    if (!instance) {
      return createToolError("CONFIG_INVALID",
        "No server running for this run_id. Start a server first with serveStart.", {
        recoverable: false,
        suggestion: "Use indexfoundry_serve_start to start a server first",
      });
    }

    const topK = input.top_k || instance.profile?.retrieval.default_top_k || 10;

    let results: Array<{ id: string; score: number; metadata: Record<string, unknown>; text?: string }>;
    let mode: string;

    const { duration_ms } = await timed(async () => {
      if (input.mode === "semantic") {
        if (!input.query_vector) {
          throw new Error("query_vector is required for semantic search");
        }
        results = semanticSearch(input.query_vector, instance.vectors, topK, input.filters);
        mode = "semantic";
      } else if (input.mode === "keyword") {
        if (!input.query) {
          throw new Error("query is required for keyword search");
        }
        results = keywordSearch(input.query, instance.vectors, topK, input.filters);
        mode = "keyword";
      } else {
        // Hybrid
        if (!input.query) {
          throw new Error("query is required for hybrid search");
        }
        const alpha = input.alpha ?? instance.profile?.retrieval.hybrid_config?.alpha ?? 0.7;
        const fusion = instance.profile?.retrieval.hybrid_config?.fusion_method || "rrf";

        if (input.query_vector) {
          results = hybridSearch(input.query_vector, input.query, instance.vectors, topK, alpha, fusion, input.filters);
          mode = "hybrid";
        } else {
          results = keywordSearch(input.query, instance.vectors, topK, input.filters);
          mode = "keyword_fallback";
        }
      }
    });

    return {
      success: true,
      results: results!.map(r => ({
        chunk_id: r.id,
        score: r.score,
        text: input.include_text !== false ? r.text : undefined,
        metadata: r.metadata,
      })),
      total: results!.length,
      took_ms: duration_ms,
      mode: mode!,
    };
  } catch (err) {
    return createToolError("CONFIG_INVALID", `Query failed: ${err}`, {
      recoverable: true,
    });
  }
}
