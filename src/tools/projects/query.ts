/** Project query and hybrid chat operations. */

import path from "path";
import {
  ProjectQueryInput,
  ProjectManifest,
  ChunkRecord,
  VectorRecord,
  EmbeddingModel,
} from "../../schemas-projects.js";
import {
  pathExists,
  readJson,
  readJsonl,
  createToolError,
  cosineSimilarity,
} from "../../utils.js";
import { embedText } from "./ingest.js";
import { getProjectPaths } from "./config.js";
import { buildSearchContext, searchHybrid } from "../../templates/server/search.js";
import type { ToolError } from "../../types.js";

// ============================================================================
// Project Query
// ============================================================================

export interface ProjectQueryResult {
  success: true;
  results: Array<{
    chunk_id: string;
    score: number;
    text: string;
    source_id: string;
    metadata: Record<string, unknown>;
  }>;
  total: number;
  mode: string;
}

interface ScoredQueryChunk {
  chunk_id: string;
  score: number;
}

function scoreKeywordMatches(chunks: ChunkRecord[], query: string): ScoredQueryChunk[] {
  const queryTerms = query.toLowerCase().split(/\s+/);
  return chunks.map(chunk => {
    const text = chunk.text.toLowerCase();
    const matches = queryTerms.filter(term => text.includes(term)).length;
    return {
      chunk_id: chunk.chunk_id,
      score: matches / queryTerms.length,
    };
  });
}

function scoreSemanticMatches(
  vectors: VectorRecord[],
  queryVector: number[]
): ScoredQueryChunk[] {
  return vectors.map(vector => ({
    chunk_id: vector.chunk_id,
    score: cosineSimilarity(queryVector, vector.embedding),
  }));
}

function combineHybridScores(
  semanticScores: ScoredQueryChunk[],
  keywordScores: ScoredQueryChunk[]
): ScoredQueryChunk[] {
  const keywordMap = new Map(keywordScores.map(item => [item.chunk_id, item.score]));
  return semanticScores.map(item => ({
    chunk_id: item.chunk_id,
    score: item.score * 0.7 + (keywordMap.get(item.chunk_id) || 0) * 0.3,
  }));
}

async function scoreQuery(
  input: ProjectQueryInput,
  manifest: ProjectManifest,
  chunks: ChunkRecord[],
  vectors: VectorRecord[]
): Promise<ScoredQueryChunk[]> {
  let semanticScores: ScoredQueryChunk[] = [];

  if (input.mode === "semantic" || input.mode === "hybrid") {
    const queryVector = await embedText(input.query, manifest.embedding_model);
    semanticScores = scoreSemanticMatches(vectors, queryVector);
  }

  if (input.mode === "keyword") {
    return scoreKeywordMatches(chunks, input.query);
  }

  if (input.mode === "hybrid") {
    return combineHybridScores(
      semanticScores,
      scoreKeywordMatches(chunks, input.query)
    );
  }

  return semanticScores;
}

function buildQueryResults(
  scored: ScoredQueryChunk[],
  chunks: ChunkRecord[],
  input: ProjectQueryInput
): ProjectQueryResult["results"] {
  const chunkMap = new Map(chunks.map(chunk => [chunk.chunk_id, chunk]));
  return scored
    .sort((left, right) => right.score - left.score)
    .slice(0, input.top_k)
    .map(item => {
      const chunk = chunkMap.get(item.chunk_id);
      if (!chunk) return null;
      if (input.filter_sources && !input.filter_sources.includes(chunk.source_id)) {
        return null;
      }

      return {
        chunk_id: item.chunk_id,
        score: item.score,
        text: chunk.text,
        source_id: chunk.source_id,
        metadata: chunk.metadata,
      };
    })
    .filter((result): result is NonNullable<typeof result> => result !== null);
}

export async function projectQuery(input: ProjectQueryInput): Promise<ProjectQueryResult | ToolError> {
  const paths = getProjectPaths(input.project_id);

  if (!(await pathExists(paths.manifest))) {
    return createToolError("NOT_FOUND", `Project '${input.project_id}' not found`, {
      recoverable: false,
    });
  }

  try {
    const manifest = await readJson<ProjectManifest>(paths.manifest);
    if (!(await pathExists(paths.chunks)) || !(await pathExists(paths.vectors))) {
      return {
        success: true,
        results: [],
        total: 0,
        mode: input.mode,
      };
    }

    const chunks = await readJsonl<ChunkRecord>(paths.chunks);
    const vectors = await readJsonl<VectorRecord>(paths.vectors);
    const results = buildQueryResults(
      await scoreQuery(input, manifest, chunks, vectors),
      chunks,
      input
    );

    return {
      success: true,
      results,
      total: results.length,
      mode: input.mode,
    };
  } catch (err) {
    return createToolError("QUERY_FAILED", `Query failed: ${err}`, {
      recoverable: true,
    });
  }
}

// ============================================================================
// Query Embedding
// ============================================================================

/**
 * Generate query embedding using OpenAI API
 * Used for hybrid search in /chat endpoint
 */
export async function generateQueryEmbedding(params: {
  text: string;
  model: EmbeddingModel;
}): Promise<number[]> {
  const { text, model } = params;

  const apiKey = process.env[model.api_key_env];
  if (!apiKey) {
    throw new Error(`API key not found in environment variable: ${model.api_key_env}`);
  }

  if (model.provider !== "openai") {
    throw new Error(`Unsupported embedding provider: ${model.provider}`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model.model_name,
        input: text,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0].embedding;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Search result with flattened structure for easy access
 */
export interface SearchResult {
  chunk_id: string;
  text: string;
  score: number;
  source_id: string;
  source_name?: string;
  position: {
    index: number;
    start_char: number;
    end_char: number;
  };
  metadata: Record<string, unknown>;
}

/**
 * Helper: Convert ChunkRecord to flattened SearchResult
 */
function chunkToSearchResult(chunk: ChunkRecord, score: number): SearchResult {
  return {
    chunk_id: chunk.chunk_id,
    text: chunk.text,
    score: Math.round(score * 10000) / 10000,
    source_id: chunk.source_id,
    source_name: chunk.metadata?.source_name as string | undefined,
    position: chunk.position,
    metadata: chunk.metadata,
  };
}

/**
 * Chat result with context and search metadata
 */
export interface ChatResult {
  context: string;
  searchMode: 'hybrid' | 'keyword';
  sources: SearchResult[];
  conversationId: string;
}

/**
 * Chat retrieval flow, backed by the same hybrid search the exported server
 * runs (src/templates/server/search.ts). Exported so the test suite exercises
 * the shipped algorithm rather than a stand-in.
 */
export async function chatWithHybridSearch(params: {
  question: string;
  projectDir: string;
  topK?: number;
}): Promise<ChatResult> {
  const { question, projectDir, topK = 5 } = params;

  // Load project data
  const chunksPath = path.join(projectDir, "data", "chunks.jsonl");
  const vectorsPath = path.join(projectDir, "data", "vectors.jsonl");
  const manifestPath = path.join(projectDir, "project.json");

  if (!(await pathExists(manifestPath))) {
    throw new Error(`Project not found at: ${projectDir}`);
  }

  const manifest = await readJson<ProjectManifest>(manifestPath);
  const chunks = await readJsonl<ChunkRecord>(chunksPath);
  const vectors = await readJsonl<VectorRecord>(vectorsPath);

  if (chunks.length === 0) {
    throw new Error("No chunks found in project");
  }

  // Without an API key there is nothing to embed with, so skip the semantic
  // half entirely rather than paying for a request that cannot succeed.
  const apiKeyEnv = manifest.embedding_model?.api_key_env || "OPENAI_API_KEY";
  const hasApiKey = !!process.env[apiKeyEnv];

  const context = buildSearchContext(chunks, hasApiKey ? vectors : []);

  const { results, diagnostics } = await searchHybrid(
    context,
    question,
    topK,
    (text) => generateQueryEmbedding({ text, model: manifest.embedding_model })
  );

  const searchResults = results.map((r) =>
    chunkToSearchResult(r.chunk as ChunkRecord, r.score)
  );

  return {
    context: searchResults.map((r) => r.text).join("\n\n---\n\n"),
    searchMode: diagnostics.mode,
    sources: searchResults,
    conversationId: "",
  };
}
