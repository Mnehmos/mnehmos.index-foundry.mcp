/**
 * IndexFoundry-MCP: Normalize Tools (Phase 3)
 *
 * Chunking, enrichment, and deduplication tools.
 * All operations are deterministic and produce auditable outputs.
 *
 * Copyright (c) 2024 vario.automation
 * Proprietary and confidential. All rights reserved.
 */

import * as path from "path";
import * as fs from "fs/promises";
import type { DocumentChunk, ToolError } from "../types.js";
import type { 
  NormalizeChunkInput, 
  NormalizeEnrichInput, 
  NormalizeDedupeInput 
} from "../schemas.js";
import {
  sha256,
  generateChunkId,
  pathExists,
  ensureDir,
  readJsonl,
  appendJsonl,
  writeJson,
  normalizeText,
  estimateTokens,
  hashConfig,
  createToolError,
  now,
  parseHeadingLevel,
  getParentContext,
} from "../utils.js";
import { getRunManager } from "../run-manager.js";

// ============================================================================
// Normalize Chunk
// ============================================================================

export interface NormalizeChunkResult {
  success: boolean;
  output_path: string;
  stats: {
    documents_processed: number;
    chunks_created: number;
    chunks_below_min: number;
    chunks_at_max: number;
    avg_chunk_chars: number;
    total_chars: number;
  };
  chunker_config: {
    strategy: string;
    max_chars: number;
    overlap_chars: number;
    config_hash: string;
  };
}

/**
 * Split text using recursive strategy
 */
function recursiveChunk(
  text: string,
  maxChars: number,
  minChars: number,
  overlap: number,
  separators: string[]
): string[] {
  // If text fits, return as single chunk
  if (text.length <= maxChars) {
    return [text];
  }
  
  // Try each separator in order
  for (const sep of separators) {
    const parts = text.split(sep);
    
    // If we got multiple parts, process them
    if (parts.length > 1) {
      const chunks: string[] = [];
      let current = "";
      
      for (const part of parts) {
        const candidate = current ? current + sep + part : part;
        
        if (candidate.length <= maxChars) {
          current = candidate;
        } else {
          // Push current chunk if it exists
          if (current.length >= minChars) {
            chunks.push(current);
          } else if (current && chunks.length > 0) {
            // Append small chunk to previous
            chunks[chunks.length - 1] += sep + current;
          }
          
          // Start new chunk
          if (part.length > maxChars) {
            // Part is too large, recurse with next separator
            const subChunks = recursiveChunk(
              part,
              maxChars,
              minChars,
              overlap,
              separators.slice(separators.indexOf(sep) + 1)
            );
            chunks.push(...subChunks);
            current = "";
          } else {
            current = part;
          }
        }
      }
      
      // Don't forget last chunk
      if (current.length >= minChars) {
        chunks.push(current);
      } else if (current && chunks.length > 0) {
        chunks[chunks.length - 1] += sep + current;
      }
      
      // Apply overlap
      if (overlap > 0 && chunks.length > 1) {
        const overlapped: string[] = [chunks[0]];
        for (let i = 1; i < chunks.length; i++) {
          const prevChunk = chunks[i - 1];
          const overlapText = prevChunk.slice(-overlap);
          overlapped.push(overlapText + chunks[i]);
        }
        return overlapped;
      }
      
      return chunks;
    }
  }
  
  // No separator worked, hard split
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxChars - overlap) {
    chunks.push(text.slice(i, i + maxChars));
  }
  return chunks;
}

/**
 * Internal result type for hierarchical chunking with parent tracking.
 * Used to map temporary IDs to real SHA256-based chunk IDs.
 */
interface HierarchicalChunkResult {
  /** The text content of this chunk */
  text: string;
  /** Hierarchy level: 1-6 for h1-h6, 0 for non-heading content */
  level: number;
  /** Temporary ID of parent chunk (resolved to real SHA256 ID later) */
  parentId?: string;
  /** Truncated context from parent chunk for semantic continuity */
  parentContext?: string;
  /** Temporary chunk ID (replaced with deterministic SHA256 ID later) */
  chunkId?: string;
}

/**
 * Performs hierarchical chunking on markdown content, creating parent-child
 * relationships based on heading structure (h1-h6).
 *
 * This strategy:
 * - Parses ATX-style headings (# through ######)
 * - Creates chunks for each heading + its content
 * - Tracks parent-child relationships between heading levels
 * - Includes configurable parent context in child chunks
 * - Produces deterministic output for the same input
 *
 * @param text - The markdown content to chunk
 * @param _maxChars - Maximum characters per chunk (reserved for future chunking within sections)
 * @param minChars - Minimum characters for a chunk to be emitted
 * @param _overlap - Character overlap between chunks (reserved for future use)
 * @param createParentChunks - Whether to register headings as parents for their level
 * @param parentContextChars - Characters of parent context to include in children (0 to disable)
 * @returns Array of HierarchicalChunkResult with hierarchy metadata
 *
 * @example
 * ```typescript
 * const markdown = "# Title\nContent\n## Section\nMore content";
 * const chunks = hierarchicalChunk(markdown, 1500, 50, 0, true, 100);
 * // Returns:
 * // [
 * //   { text: "# Title\nContent", level: 1, chunkId: "chunk_0" },
 * //   { text: "## Section\nMore content", level: 2,
 * //     parentId: "chunk_0", parentContext: "# Title\nContent", chunkId: "chunk_1" }
 * // ]
 * ```
 */
function hierarchicalChunk(
  text: string,
  _maxChars: number,
  minChars: number,
  _overlap: number,
  createParentChunks: boolean,
  parentContextChars: number
): HierarchicalChunkResult[] {
  const results: HierarchicalChunkResult[] = [];
  const lines = text.split('\n');
  
  // Track parent at each level (index 0 unused, 1-6 for heading levels)
  const parentStack: Array<{ id: string; context: string; level: number } | undefined> =
    new Array(7).fill(undefined);
  
  let currentContent = '';
  let currentLevel = 0;
  let currentHeading = '';
  let chunkIndex = 0;
  
  const generateTempId = () => `chunk_${chunkIndex++}`;
  
  const flushContent = () => {
    if (!currentContent.trim()) return;
    
    const contentText = currentHeading
      ? `${currentHeading}\n${currentContent.trim()}`
      : currentContent.trim();
    
    if (contentText.length >= minChars || results.length === 0) {
      const chunkId = generateTempId();
      
      // Find the closest parent at a higher level
      let parentId: string | undefined;
      let parentContext: string | undefined;
      
      for (let level = currentLevel - 1; level >= 1; level--) {
        if (parentStack[level]) {
          parentId = parentStack[level]!.id;
          if (parentContextChars > 0) {
            parentContext = parentStack[level]!.context.slice(0, parentContextChars);
          }
          break;
        }
      }
      
      results.push({
        text: contentText,
        level: currentLevel,
        parentId,
        parentContext: parentContext || undefined,
        chunkId
      });
      
      // If this is a heading, register as parent for its level
      if (currentLevel > 0 && createParentChunks) {
        parentStack[currentLevel] = {
          id: chunkId,
          context: contentText,
          level: currentLevel
        };
        
        // Clear parents at deeper levels when we encounter a new heading
        for (let i = currentLevel + 1; i <= 6; i++) {
          parentStack[i] = undefined;
        }
      }
    }
  };
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingLevel = parseHeadingLevel(line);
    
    if (headingLevel !== null) {
      // Flush previous content before starting new section
      flushContent();
      
      currentHeading = line;
      currentLevel = headingLevel;
      currentContent = '';
      
      // Look ahead to get content under this heading
      const contentLines: string[] = [];
      let j = i + 1;
      
      while (j < lines.length) {
        const nextLine = lines[j];
        const nextHeadingLevel = parseHeadingLevel(nextLine);
        
        if (nextHeadingLevel !== null) {
          break; // Stop at next heading
        }
        
        contentLines.push(nextLine);
        j++;
      }
      
      currentContent = contentLines.join('\n');
      i = j - 1; // Skip the lines we consumed
    } else {
      // Not a heading, accumulate content
      if (currentLevel === 0) {
        currentContent += (currentContent ? '\n' : '') + line;
      }
    }
  }
  
  // Flush any remaining content
  flushContent();
  
  return results;
}

/**
 * Split text by paragraph (double newlines)
 */
function paragraphChunk(text: string, maxChars: number, minChars: number): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";
  
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    
    if (current.length + trimmed.length + 2 <= maxChars) {
      current = current ? current + "\n\n" + trimmed : trimmed;
    } else {
      if (current) chunks.push(current);
      current = trimmed;
    }
  }
  
  if (current) chunks.push(current);
  
  // Merge small chunks
  return mergeSmallChunks(chunks, minChars, maxChars);
}

/**
 * Split text by headings (markdown)
 */
function headingChunk(text: string, maxChars: number, minChars: number): string[] {
  const sections = text.split(/^(#{1,6}\s.+)$/m);
  const chunks: string[] = [];
  let current = "";
  let currentHeading = "";
  
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i].trim();
    if (!section) continue;
    
    if (section.startsWith("#")) {
      // It's a heading
      if (current) {
        chunks.push(currentHeading + "\n\n" + current);
      }
      currentHeading = section;
      current = "";
    } else {
      // It's content
      if (current.length + section.length + 2 <= maxChars) {
        current = current ? current + "\n\n" + section : section;
      } else {
        if (current) chunks.push(currentHeading + "\n\n" + current);
        current = section;
      }
    }
  }
  
  if (current) {
    chunks.push(currentHeading + "\n\n" + current);
  }
  
  return mergeSmallChunks(chunks, minChars, maxChars);
}

/**
 * Merge chunks that are too small
 */
function mergeSmallChunks(chunks: string[], minChars: number, maxChars: number): string[] {
  const result: string[] = [];
  let buffer = "";
  
  for (const chunk of chunks) {
    if (buffer.length + chunk.length + 2 <= maxChars) {
      buffer = buffer ? buffer + "\n\n" + chunk : chunk;
    } else {
      if (buffer) result.push(buffer);
      buffer = chunk;
    }
  }
  
  if (buffer) result.push(buffer);
  
  return result;
}

export async function normalizeChunk(input: NormalizeChunkInput): Promise<NormalizeChunkResult | ToolError> {
  const manager = getRunManager();
  const runDir = manager.getRunDir(input.run_id);
  
  // Ensure run exists with full infrastructure
  await manager.ensureRun(input.run_id);
  const normalizedDir = manager.getNormalizedDir(input.run_id);
  
  try {
    // Check output path
    const outputPath = path.join(normalizedDir, "chunks.jsonl");
    const configHash = hashConfig({
      strategy: input.strategy,
      max_chars: input.max_chars,
      min_chars: input.min_chars,
      overlap_chars: input.overlap_chars,
      split_hierarchy: input.split_hierarchy,
    });
    
    // Track stats
    let documentsProcessed = 0;
    let chunksCreated = 0;
    let chunksBelowMin = 0;
    let chunksAtMax = 0;
    let totalChars = 0;
    
    const allChunks: DocumentChunk[] = [];
    
    // Process each input file
    for (const inputPath of input.input_paths.sort()) {
      const fullPath = path.join(runDir, inputPath);
      
      if (!await pathExists(fullPath)) {
        continue;
      }
      
      // Read source content
      const content = await fs.readFile(fullPath, "utf-8");
      const normalizedContent = normalizeText(content);
      const docHash = sha256(normalizedContent);
      
      documentsProcessed++;
      
      // Check if using hierarchical strategy
      if (input.strategy === "hierarchical") {
        // Use hierarchical chunking with parent tracking
        const hierarchicalResults = hierarchicalChunk(
          normalizedContent,
          input.max_chars,
          input.min_chars,
          input.overlap_chars,
          input.create_parent_chunks,
          input.parent_context_chars
        );
        
        // Map temp chunk IDs to real chunk IDs
        const tempIdToRealId = new Map<string, string>();
        let byteOffset = 0;
        
        for (let i = 0; i < hierarchicalResults.length; i++) {
          const result = hierarchicalResults[i];
          const chunkText = result.text;
          const textHash = sha256(chunkText);
          const byteEnd = byteOffset + Buffer.byteLength(chunkText, "utf-8");
          const realChunkId = generateChunkId(docHash, byteOffset, byteEnd);
          
          // Map temp ID to real ID
          if (result.chunkId) {
            tempIdToRealId.set(result.chunkId, realChunkId);
          }
          
          // Resolve parent ID from temp ID to real ID
          let resolvedParentId: string | undefined;
          if (result.parentId) {
            resolvedParentId = tempIdToRealId.get(result.parentId);
          }
          
          const chunk: DocumentChunk = {
            doc_id: docHash,
            chunk_id: realChunkId,
            chunk_index: i,
            hierarchy_level: result.level,
            parent_id: resolvedParentId,
            parent_context: result.parentContext,
            
            source: {
              type: detectSourceType(inputPath),
              uri: inputPath,
              retrieved_at: now(),
              content_hash: docHash,
            },
            
            content: {
              text: chunkText,
              text_hash: textHash,
              char_count: chunkText.length,
              token_count_approx: estimateTokens(chunkText),
            },
            
            position: {
              byte_start: byteOffset,
              byte_end: byteEnd,
            },
            
            metadata: {
              content_type: detectContentType(inputPath),
            },
          };
          
          allChunks.push(chunk);
          chunksCreated++;
          totalChars += chunkText.length;
          
          if (chunkText.length < input.min_chars) {
            chunksBelowMin++;
          }
          if (chunkText.length >= input.max_chars - 10) {
            chunksAtMax++;
          }
          
          byteOffset = byteEnd;
        }
      } else {
        // Chunk based on strategy
        let chunks: string[];
        
        switch (input.strategy) {
          case "recursive":
            chunks = recursiveChunk(
              normalizedContent,
              input.max_chars,
              input.min_chars,
              input.overlap_chars,
              input.split_hierarchy
            );
            break;
            
          case "by_paragraph":
            chunks = paragraphChunk(normalizedContent, input.max_chars, input.min_chars);
            break;
            
          case "by_heading":
            chunks = headingChunk(normalizedContent, input.max_chars, input.min_chars);
            break;
            
          case "fixed_chars":
            chunks = [];
            for (let i = 0; i < normalizedContent.length; i += input.max_chars - input.overlap_chars) {
              chunks.push(normalizedContent.slice(i, i + input.max_chars));
            }
            break;
            
          case "by_sentence":
            const sentences = normalizedContent.split(/(?<=[.!?])\s+/);
            chunks = [];
            let current = "";
            for (const sentence of sentences) {
              if (current.length + sentence.length + 1 <= input.max_chars) {
                current = current ? current + " " + sentence : sentence;
              } else {
                if (current) chunks.push(current);
                current = sentence;
              }
            }
            if (current) chunks.push(current);
            break;
            
          case "by_page":
            // For page-based, assume page markers or use fixed splits
            chunks = normalizedContent.split(/\f|\n{4,}/).filter(Boolean);
            break;
            
          default:
            chunks = recursiveChunk(
              normalizedContent,
              input.max_chars,
              input.min_chars,
              input.overlap_chars,
              input.split_hierarchy
            );
        }
        
        // Create DocumentChunk records
        let byteOffset = 0;
        for (let i = 0; i < chunks.length; i++) {
          const chunkText = chunks[i];
          const textHash = sha256(chunkText);
          const byteEnd = byteOffset + Buffer.byteLength(chunkText, "utf-8");
          
          const chunk: DocumentChunk = {
            doc_id: docHash,
            chunk_id: generateChunkId(docHash, byteOffset, byteEnd),
            chunk_index: i,
            hierarchy_level: 0, // Non-hierarchical chunks get level 0
            
            source: {
              type: detectSourceType(inputPath),
              uri: inputPath,
              retrieved_at: now(),
              content_hash: docHash,
            },
            
            content: {
              text: chunkText,
              text_hash: textHash,
              char_count: chunkText.length,
              token_count_approx: estimateTokens(chunkText),
            },
            
            position: {
              byte_start: byteOffset,
              byte_end: byteEnd,
            },
            
            metadata: {
              content_type: detectContentType(inputPath),
            },
          };
          
          allChunks.push(chunk);
          chunksCreated++;
          totalChars += chunkText.length;
          
          if (chunkText.length < input.min_chars) {
            chunksBelowMin++;
          }
          if (chunkText.length >= input.max_chars - 10) {
            chunksAtMax++;
          }
          
          byteOffset = byteEnd;
        }
      }
    }
    
    // Write all chunks (sorted for determinism)
    allChunks.sort((a, b) => {
      const docCompare = a.doc_id.localeCompare(b.doc_id);
      if (docCompare !== 0) return docCompare;
      return a.chunk_index - b.chunk_index;
    });
    
    // Clear existing file and write fresh
    await fs.writeFile(outputPath, "");
    await appendJsonl(outputPath, allChunks);
    
    return {
      success: true,
      output_path: "normalized/chunks.jsonl",
      stats: {
        documents_processed: documentsProcessed,
        chunks_created: chunksCreated,
        chunks_below_min: chunksBelowMin,
        chunks_at_max: chunksAtMax,
        avg_chunk_chars: chunksCreated > 0 ? Math.round(totalChars / chunksCreated) : 0,
        total_chars: totalChars,
      },
      chunker_config: {
        strategy: input.strategy,
        max_chars: input.max_chars,
        overlap_chars: input.overlap_chars,
        config_hash: configHash,
      },
    };
  } catch (err) {
    return createToolError("CHUNK_ERROR", `Failed to chunk documents: ${err}`, {
      recoverable: false,
    });
  }
}

// ============================================================================
// Normalize Enrich
// ============================================================================

export interface NormalizeEnrichResult {
  success: boolean;
  output_path: string;
  stats: {
    chunks_enriched: number;
    languages_detected: Record<string, number>;
    tags_extracted: number;
    sections_identified: number;
  };
}

export async function normalizeEnrich(input: NormalizeEnrichInput): Promise<NormalizeEnrichResult | ToolError> {
  const manager = getRunManager();
  const runDir = manager.getRunDir(input.run_id);
  
  // Ensure run exists with full infrastructure
  await manager.ensureRun(input.run_id);
  const normalizedDir = manager.getNormalizedDir(input.run_id);
  
  try {
    const chunksPath = path.join(runDir, input.chunks_path);
    
    if (!await pathExists(chunksPath)) {
      return createToolError("CHUNK_ERROR", `Chunks file not found: ${input.chunks_path}`, {
        recoverable: false,
      });
    }
    
    // Read chunks
    const chunks = await readJsonl<DocumentChunk>(chunksPath);
    
    const stats = {
      chunks_enriched: 0,
      languages_detected: {} as Record<string, number>,
      tags_extracted: 0,
      sections_identified: 0,
    };
    
    // Import language detection
    let detectLanguage: ((text: string) => string) | null = null;
    if (input.rules.detect_language) {
      try {
        const franc = await import("franc-min");
        detectLanguage = (text: string) => {
          const lang = franc.franc(text);
          return lang === "und" ? "unknown" : lang;
        };
      } catch {
        // Language detection not available
      }
    }
    
    // Process each chunk
    for (const chunk of chunks) {
      let modified = false;
      
      // Language detection
      if (input.rules.detect_language && detectLanguage) {
        const lang = detectLanguage(chunk.content.text);
        chunk.metadata.language = lang;
        stats.languages_detected[lang] = (stats.languages_detected[lang] || 0) + 1;
        modified = true;
      }
      
      // Regex tag extraction
      if (input.rules.regex_tags?.length) {
        const tags: string[] = chunk.metadata.tags || [];
        
        for (const rule of input.rules.regex_tags) {
          const regex = new RegExp(rule.pattern, rule.flags);
          const matches = chunk.content.text.matchAll(regex);
          
          for (const match of matches) {
            const value = match[1] || match[0];
            const tag = `${rule.tag_name}:${value}`;
            if (!tags.includes(tag)) {
              tags.push(tag);
              stats.tags_extracted++;
            }
          }
        }
        
        if (tags.length) {
          chunk.metadata.tags = tags.sort();
          modified = true;
        }
      }
      
      // Section detection
      if (input.rules.section_patterns?.length) {
        for (const pattern of input.rules.section_patterns) {
          const regex = new RegExp(pattern.pattern);
          if (regex.test(chunk.content.text)) {
            chunk.position.section = pattern.section_name;
            stats.sections_identified++;
            modified = true;
            break;
          }
        }
      }
      
      // Taxonomy mapping
      if (input.rules.taxonomy) {
        const tags: string[] = chunk.metadata.tags || [];
        const textLower = chunk.content.text.toLowerCase();
        
        for (const [category, terms] of Object.entries(input.rules.taxonomy)) {
          for (const term of terms) {
            if (textLower.includes(term.toLowerCase())) {
              const tag = `category:${category}`;
              if (!tags.includes(tag)) {
                tags.push(tag);
              }
              break;
            }
          }
        }
        
        if (tags.length) {
          chunk.metadata.tags = tags.sort();
          modified = true;
        }
      }
      
      if (modified) {
        stats.chunks_enriched++;
      }
    }
    
    // Write enriched chunks back
    const outputPath = path.join(normalizedDir, "chunks.enriched.jsonl");
    await fs.writeFile(outputPath, "");
    await appendJsonl(outputPath, chunks);
    
    // Save enrichment report
    await writeJson(path.join(normalizedDir, "metadata_enrichment.json"), stats);
    
    return {
      success: true,
      output_path: "normalized/chunks.enriched.jsonl",
      stats,
    };
  } catch (err) {
    return createToolError("CHUNK_ERROR", `Failed to enrich chunks: ${err}`, {
      recoverable: false,
    });
  }
}

// ============================================================================
// Normalize Dedupe
// ============================================================================

export interface NormalizeDedupeResult {
  success: boolean;
  output_path: string;
  stats: {
    input_chunks: number;
    output_chunks: number;
    duplicates_removed: number;
    duplicate_groups: number;
  };
  dedupe_report_path: string;
}

export async function normalizeDedupe(input: NormalizeDedupeInput): Promise<NormalizeDedupeResult | ToolError> {
  const manager = getRunManager();
  const runDir = manager.getRunDir(input.run_id);
  
  // Ensure run exists with full infrastructure
  await manager.ensureRun(input.run_id);
  const normalizedDir = manager.getNormalizedDir(input.run_id);
  
  try {
    const chunksPath = path.join(runDir, input.chunks_path);
    
    if (!await pathExists(chunksPath)) {
      return createToolError("CHUNK_ERROR", `Chunks file not found: ${input.chunks_path}`, {
        recoverable: false,
      });
    }
    
    // Read chunks
    const chunks = await readJsonl<DocumentChunk>(chunksPath);
    
    const stats = {
      input_chunks: chunks.length,
      output_chunks: 0,
      duplicates_removed: 0,
      duplicate_groups: 0,
    };
    
    const duplicateReport: Array<{
      kept: string;
      removed: string[];
      method: string;
    }> = [];
    
    // Track seen content
    const seen = new Map<string, DocumentChunk>();
    const uniqueChunks: DocumentChunk[] = [];
    
    if (input.method === "exact") {
      // Exact hash deduplication
      for (const chunk of chunks) {
        const key = input.scope === "global" 
          ? chunk.content.text_hash 
          : `${chunk.doc_id}:${chunk.content.text_hash}`;
        
        if (seen.has(key)) {
          stats.duplicates_removed++;
          
          // Find or create duplicate group
          const existing = duplicateReport.find(r => r.kept === seen.get(key)!.chunk_id);
          if (existing) {
            existing.removed.push(chunk.chunk_id);
          } else {
            stats.duplicate_groups++;
            duplicateReport.push({
              kept: seen.get(key)!.chunk_id,
              removed: [chunk.chunk_id],
              method: "exact",
            });
          }
        } else {
          seen.set(key, chunk);
          uniqueChunks.push(chunk);
        }
      }
    } else if (input.method === "simhash") {
      // Simhash-based near-duplicate detection
      // Simplified implementation using text comparison
      const threshold = input.similarity_threshold;
      
      for (const chunk of chunks) {
        let isDuplicate = false;
        
        for (const existing of uniqueChunks) {
          // Simple similarity check (Jaccard-like)
          const similarity = computeTextSimilarity(
            chunk.content.text, 
            existing.content.text
          );
          
          if (similarity >= threshold) {
            isDuplicate = true;
            stats.duplicates_removed++;
            
            const report = duplicateReport.find(r => r.kept === existing.chunk_id);
            if (report) {
              report.removed.push(chunk.chunk_id);
            } else {
              stats.duplicate_groups++;
              duplicateReport.push({
                kept: existing.chunk_id,
                removed: [chunk.chunk_id],
                method: "simhash",
              });
            }
            break;
          }
        }
        
        if (!isDuplicate) {
          uniqueChunks.push(chunk);
        }
      }
    }
    
    stats.output_chunks = uniqueChunks.length;
    
    // Write deduplicated chunks
    const outputPath = path.join(normalizedDir, "chunks.deduped.jsonl");
    await fs.writeFile(outputPath, "");
    await appendJsonl(outputPath, uniqueChunks);
    
    // Write dedupe report
    const reportPath = path.join(normalizedDir, "dedupe_report.json");
    await writeJson(reportPath, {
      method: input.method,
      scope: input.scope,
      threshold: input.similarity_threshold,
      stats,
      groups: duplicateReport,
    });
    
    return {
      success: true,
      output_path: "normalized/chunks.deduped.jsonl",
      stats,
      dedupe_report_path: "normalized/dedupe_report.json",
    };
  } catch (err) {
    return createToolError("CHUNK_ERROR", `Failed to deduplicate chunks: ${err}`, {
      recoverable: false,
    });
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function detectSourceType(filePath: string): DocumentChunk["source"]["type"] {
  const ext = path.extname(filePath).toLowerCase();
  const mapping: Record<string, DocumentChunk["source"]["type"]> = {
    ".pdf": "pdf",
    ".html": "html",
    ".htm": "html",
    ".md": "markdown",
    ".txt": "txt",
    ".csv": "csv",
    ".json": "json",
    ".docx": "docx",
  };
  return mapping[ext] || "txt";
}

function detectContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mapping: Record<string, string> = {
    ".pdf": "application/pdf",
    ".html": "text/html",
    ".htm": "text/html",
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".json": "application/json",
  };
  return mapping[ext] || "text/plain";
}

function computeTextSimilarity(a: string, b: string): number {
  // Simple character-based Jaccard similarity
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}
