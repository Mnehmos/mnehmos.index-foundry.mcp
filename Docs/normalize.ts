/**
 * IndexFoundry-MCP Normalize Phase Tools
 * 
 * Phase 3: Chunking and enriching text.
 * All normalizers produce artifacts in runs/<run_id>/normalized/
 */

import type { 
  NormalizeChunkInput, 
  NormalizeEnrichInput, 
  NormalizeDedupeInput 
} from "../schemas/index.js";

export async function handleNormalizeChunk(
  params: NormalizeChunkInput
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown }> {
  // TODO: Implement text chunking
  return {
    content: [{ type: "text", text: `[STUB] Would chunk ${params.input_paths.length} files with strategy: ${params.strategy}` }],
    structuredContent: {
      success: false,
      error: { code: "NOT_IMPLEMENTED", message: "Chunking not yet implemented" }
    }
  };
}

export async function handleNormalizeEnrich(
  params: NormalizeEnrichInput
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown }> {
  // TODO: Implement metadata enrichment
  return {
    content: [{ type: "text", text: `[STUB] Would enrich chunks from: ${params.chunks_path}` }],
    structuredContent: {
      success: false,
      error: { code: "NOT_IMPLEMENTED", message: "Enrichment not yet implemented" }
    }
  };
}

export async function handleNormalizeDedupe(
  params: NormalizeDedupeInput
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown }> {
  // TODO: Implement deduplication
  return {
    content: [{ type: "text", text: `[STUB] Would dedupe chunks using method: ${params.method}` }],
    structuredContent: {
      success: false,
      error: { code: "NOT_IMPLEMENTED", message: "Deduplication not yet implemented" }
    }
  };
}
