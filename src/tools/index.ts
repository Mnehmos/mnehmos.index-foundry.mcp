/**
 * IndexFoundry-MCP: Index Tools (Phase 4)
 *
 * Embedding generation and vector database operations.
 * Supports multiple providers with deterministic batch processing.
 *
 * Copyright (c) 2024 vario.automation
 * Proprietary and confidential. All rights reserved.
 */

import * as path from "path";
import * as fs from "fs/promises";
import type { 
  DocumentChunk, 
  EmbeddingRecord, 
  VectorManifest, 
  ToolError 
} from "../types.js";
import type { 
  IndexEmbedInput, 
  IndexUpsertInput, 
  IndexBuildProfileInput 
} from "../schemas.js";
import {
  pathExists,
  ensureDir,
  readJsonl,
  appendJsonl,
  writeJson,
  createToolError,
  now,
  timed,
} from "../utils.js";
import { getRunManager } from "../run-manager.js";

// ============================================================================
// Index Embed
// ============================================================================

export interface IndexEmbedResult {
  success: boolean;
  output_path: string;
  stats: {
    chunks_processed: number;
    embeddings_created: number;
    batches_processed: number;
    total_tokens: number;
    duration_ms: number;
  };
  model_info: {
    provider: string;
    model: string;
    dimensions: number;
  };
}

export async function indexEmbed(input: IndexEmbedInput): Promise<IndexEmbedResult | ToolError> {
  const manager = getRunManager();
  const runDir = manager.getRunDir(input.run_id);
  
  // Ensure run exists with full infrastructure
  await manager.ensureRun(input.run_id);
  const indexedDir = manager.getIndexedDir(input.run_id);
  
  try {
    const chunksPath = path.join(runDir, input.chunks_path);
    
    if (!await pathExists(chunksPath)) {
      return createToolError("EMBED_ERROR", `Chunks file not found: ${input.chunks_path}`, {
        recoverable: false,
      });
    }
    
    // Read chunks
    const chunks = await readJsonl<DocumentChunk>(chunksPath);
    
    if (chunks.length === 0) {
      return createToolError("EMBED_ERROR", "No chunks to embed", {
        recoverable: false,
      });
    }
    
    // Get API key
    const apiKey = process.env[input.model.api_key_env];
    if (!apiKey && input.model.provider !== "local") {
      return createToolError("EMBED_ERROR", 
        `API key not found in environment variable: ${input.model.api_key_env}`, {
        recoverable: false,
        suggestion: `Set ${input.model.api_key_env} environment variable`,
      });
    }
    
    // Check existing embeddings
    const outputPath = path.join(indexedDir, "embeddings.jsonl");
    const existingEmbeddings = new Set<string>();
    
    if (await pathExists(outputPath) && !input.force) {
      const existing = await readJsonl<EmbeddingRecord>(outputPath);
      for (const record of existing) {
        existingEmbeddings.add(record.chunk_id);
      }
    } else {
      // Clear existing file
      await fs.writeFile(outputPath, "");
    }
    
    // Filter chunks that need embedding
    const toEmbed = chunks.filter(c => !existingEmbeddings.has(c.chunk_id));
    
    if (toEmbed.length === 0) {
      return {
        success: true,
        output_path: "indexed/embeddings.jsonl",
        stats: {
          chunks_processed: chunks.length,
          embeddings_created: 0,
          batches_processed: 0,
          total_tokens: 0,
          duration_ms: 0,
        },
        model_info: {
          provider: input.model.provider,
          model: input.model.model_name,
          dimensions: input.model.dimensions || 1536,
        },
      };
    }
    
    let dimensions = input.model.dimensions;
    let totalTokens = 0;
    let batchesProcessed = 0;
    
    const { result: _, duration_ms } = await timed(async () => {
      // Process in batches
      for (let i = 0; i < toEmbed.length; i += input.batch_size) {
        const batch = toEmbed.slice(i, i + input.batch_size);
        const texts = batch.map(c => c.content.text);
        
        let embeddings: number[][];
        
        // Call embedding API based on provider
        switch (input.model.provider) {
          case "openai":
            embeddings = await embedWithOpenAI(
              texts, 
              input.model.model_name, 
              apiKey!,
              input.model.dimensions
            );
            break;
            
          case "local":
            // Generate deterministic placeholder embeddings for testing
            embeddings = texts.map((text, idx) => {
              const dim = input.model.dimensions || 384;
              const vec = new Array(dim).fill(0);
              // Use chunk content to generate deterministic values
              for (let j = 0; j < Math.min(text.length, dim); j++) {
                vec[j] = text.charCodeAt(j) / 255;
              }
              // Normalize
              const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0));
              return vec.map(v => v / (norm || 1));
            });
            break;
            
          default:
            return createToolError("EMBED_ERROR", 
              `Unsupported embedding provider: ${input.model.provider}`, {
              recoverable: false,
            });
        }
        
        // Track dimensions from first response
        if (!dimensions && embeddings.length > 0) {
          dimensions = embeddings[0].length;
        }
        
        // Normalize if requested
        if (input.normalize_vectors) {
          embeddings = embeddings.map(normalizeVector);
        }
        
        // Create records
        const records: EmbeddingRecord[] = batch.map((chunk, idx) => ({
          chunk_id: chunk.chunk_id,
          vector: embeddings[idx],
          model: `${input.model.provider}/${input.model.model_name}`,
          dimensions: embeddings[idx].length,
          embedded_at: now(),
        }));
        
        // Append to output file
        await appendJsonl(outputPath, records);
        
        batchesProcessed++;
        totalTokens += texts.reduce((acc, t) => acc + Math.ceil(t.length / 4), 0);
      }
    });
    
    return {
      success: true,
      output_path: "indexed/embeddings.jsonl",
      stats: {
        chunks_processed: chunks.length,
        embeddings_created: toEmbed.length,
        batches_processed: batchesProcessed,
        total_tokens: totalTokens,
        duration_ms,
      },
      model_info: {
        provider: input.model.provider,
        model: input.model.model_name,
        dimensions: dimensions || 1536,
      },
    };
  } catch (err) {
    return createToolError("EMBED_ERROR", `Failed to generate embeddings: ${err}`, {
      recoverable: true,
    });
  }
}

// ============================================================================
// Index Upsert
// ============================================================================

export interface IndexUpsertResult {
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

export async function indexUpsert(input: IndexUpsertInput): Promise<IndexUpsertResult | ToolError> {
  const manager = getRunManager();
  const runDir = manager.getRunDir(input.run_id);
  
  // Ensure run exists with full infrastructure
  await manager.ensureRun(input.run_id);
  const indexedDir = manager.getIndexedDir(input.run_id);
  
  try {
    const embeddingsPath = path.join(runDir, input.embeddings_path);
    const chunksPath = path.join(runDir, input.chunks_path);
    
    if (!await pathExists(embeddingsPath)) {
      return createToolError("DB_ERROR", `Embeddings file not found: ${input.embeddings_path}`, {
        recoverable: false,
      });
    }
    
    if (!await pathExists(chunksPath)) {
      return createToolError("DB_ERROR", `Chunks file not found: ${input.chunks_path}`, {
        recoverable: false,
      });
    }
    
    // Read data
    const embeddings = await readJsonl<EmbeddingRecord>(embeddingsPath);
    const chunks = await readJsonl<DocumentChunk>(chunksPath);
    
    // Create chunk lookup
    const chunkMap = new Map<string, DocumentChunk>();
    for (const chunk of chunks) {
      chunkMap.set(chunk.chunk_id, chunk);
    }
    
    const stats = {
      vectors_sent: 0,
      vectors_inserted: 0,
      vectors_updated: 0,
      vectors_failed: 0,
      duration_ms: 0,
    };
    
    const { duration_ms } = await timed(async () => {
      // Process based on provider
      switch (input.provider) {
        case "local":
          // Local file-based vector storage
          const localDb: Array<{
            id: string;
            vector: number[];
            metadata: Record<string, unknown>;
            text?: string;
          }> = [];
          
          for (const embedding of embeddings) {
            const chunk = chunkMap.get(embedding.chunk_id);
            if (!chunk) continue;
            
            // Extract metadata fields
            const metadata: Record<string, unknown> = {};
            for (const field of input.metadata_fields) {
              const value = getNestedField(chunk, field);
              if (value !== undefined) {
                metadata[field.replace(/\./g, "_")] = value;
              }
            }
            
            localDb.push({
              id: embedding.chunk_id,
              vector: embedding.vector,
              metadata,
              text: input.store_text ? chunk.content.text : undefined,
            });
            
            stats.vectors_sent++;
            stats.vectors_inserted++;
          }
          
          // Write local database
          await writeJson(
            path.join(indexedDir, `${input.connection.collection}.vectors.json`),
            {
              collection: input.connection.collection,
              namespace: input.connection.namespace,
              vectors: localDb,
              created_at: now(),
            }
          );
          break;
          
        case "chroma":
        case "pinecone":
        case "weaviate":
        case "qdrant":
        case "milvus":
          // External DB upsert would go here
          // For now, return error indicating not implemented
          return createToolError("DB_ERROR", 
            `Vector DB provider ${input.provider} not yet implemented. Use 'local' for testing.`, {
            recoverable: false,
            suggestion: "Use provider: 'local' for file-based storage",
          });
          
        default:
          return createToolError("DB_ERROR", 
            `Unknown vector DB provider: ${input.provider}`, {
            recoverable: false,
          });
      }
    });
    
    stats.duration_ms = duration_ms;
    
    // Create manifest
    const manifest: VectorManifest = {
      collection: input.connection.collection,
      namespace: input.connection.namespace,
      model_used: embeddings[0]?.model || "unknown",
      dimensions: embeddings[0]?.dimensions || 0,
      metadata_schema: input.metadata_fields,
      vectors_count: stats.vectors_inserted,
      created_at: now(),
    };
    
    await writeJson(path.join(indexedDir, "vector_manifest.json"), manifest);
    await writeJson(path.join(indexedDir, "upsert_stats.json"), stats);
    
    return {
      success: true,
      stats,
      vector_manifest: manifest,
    };
  } catch (err) {
    return createToolError("DB_ERROR", `Failed to upsert vectors: ${err}`, {
      recoverable: true,
    });
  }
}

// ============================================================================
// Index Build Profile
// ============================================================================

export interface IndexBuildProfileResult {
  success: boolean;
  profile_path: string;
  config: {
    retrieval: IndexBuildProfileInput["retrieval_config"];
    filters: IndexBuildProfileInput["allowed_filters"];
    security: IndexBuildProfileInput["security"];
  };
}

export async function indexBuildProfile(input: IndexBuildProfileInput): Promise<IndexBuildProfileResult | ToolError> {
  const manager = getRunManager();
  
  // Ensure run exists with full infrastructure
  await manager.ensureRun(input.run_id);
  const indexedDir = manager.getIndexedDir(input.run_id);
  
  try {
    const profile = {
      retrieval: input.retrieval_config,
      filters: input.allowed_filters,
      security: input.security,
      created_at: now(),
    };
    
    await writeJson(path.join(indexedDir, "retrieval_profile.json"), profile);
    
    return {
      success: true,
      profile_path: "indexed/retrieval_profile.json",
      config: {
        retrieval: input.retrieval_config,
        filters: input.allowed_filters,
        security: input.security,
      },
    };
  } catch (err) {
    return createToolError("CONFIG_INVALID", `Failed to build profile: ${err}`, {
      recoverable: false,
    });
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function normalizeVector(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0));
  if (norm === 0) return vec;
  return vec.map(v => v / norm);
}

function getNestedField(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  
  return current;
}

async function embedWithOpenAI(
  texts: string[],
  model: string,
  apiKey: string,
  dimensions?: number
): Promise<number[][]> {
  const OpenAI = (await import("openai")).default;
  
  const client = new OpenAI({ apiKey });
  
  const response = await client.embeddings.create({
    model,
    input: texts,
    dimensions,
  });
  
  // Sort by index to maintain order
  const sorted = response.data.sort((a, b) => a.index - b.index);
  return sorted.map(d => d.embedding);
}
