/**
 * Ingestion pipeline helpers: fetch a source, chunk its text, embed the chunks.
 *
 * These are the stages projectBuild drives. Split out of projects.ts so the
 * build orchestration reads as orchestration.
 *
 * Copyright (c) 2024 vario.automation
 * Proprietary and confidential. All rights reserved.
 */

import pdfParse from "pdf-parse";

import { extractTextFromResponse } from "../binary-handler.js";
import {
  SourceRecord,
  ChunkRecord,
  VectorRecord,
  EmbeddingModel,
} from "../../schemas-projects.js";
import { sha256, now } from "../../utils.js";
import {
  MAX_FILE_SIZE_BYTES,
  MAX_FOLDER_FILE_SIZE_BYTES,
  DEFAULT_TIMEOUT_MS,
  EMBEDDING_TIMEOUT_MS,
  MAX_SITEMAP_URLS,
  MAX_FOLDER_FILES,
  RATE_LIMIT_DELAY_MS,
  EMBEDDING_COST_PER_1M_TOKENS,
  logMetric,
} from "./config.js";

// Fetch with timeout helper and size validation
export async function fetchWithTimeout(
  url: string,
  options: {
    timeoutMs?: number;
    maxSizeBytes?: number;
    headers?: Record<string, string>;
  } = {}
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, maxSizeBytes = MAX_FILE_SIZE_BYTES, headers } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'IndexFoundry/1.0 (RAG indexing bot; +https://github.com/vario-automation)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...headers,
      },
    });

    // Check Content-Length if available
    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      const size = parseInt(contentLength, 10);
      if (size > maxSizeBytes) {
        throw new Error(`Response too large: ${(size / 1024 / 1024).toFixed(1)}MB exceeds ${(maxSizeBytes / 1024 / 1024).toFixed(1)}MB limit`);
      }
    }

    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchSource(source: SourceRecord, _runsDir: string): Promise<string[]> {
  const contents: string[] = [];

  switch (source.type) {
    case "url": {
      console.error(`[fetch] Fetching URL: ${source.uri}`);
      const response = await fetchWithTimeout(source.uri);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

      // Use unified binary handler for all URL content types (HTML, PDF, plain text)
      const result = await extractTextFromResponse({
        url: source.uri,
        response,
        maxSizeBytes: MAX_FILE_SIZE_BYTES,
      });
      
      console.error(`  OK: Extracted ${result.text.length} chars using ${result.extractorUsed} extractor`);
      contents.push(result.text);
      break;
    }

    case "pdf": {
      console.error(`[pdf] Fetching PDF: ${source.uri}`);

      if (source.uri.startsWith("http")) {
        // Use unified binary handler for HTTP PDFs
        const response = await fetchWithTimeout(source.uri);
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        
        const result = await extractTextFromResponse({
          url: source.uri,
          response,
          maxSizeBytes: MAX_FILE_SIZE_BYTES,
        });
        
        console.error(`  OK: Extracted ${result.text.length} chars using ${result.extractorUsed} extractor`);
        contents.push(result.text);
      } else {
        // Local PDF files - use pdf-parse directly
        const { readFile, stat } = await import("fs/promises");
        const stats = await stat(source.uri);
        if (stats.size > MAX_FILE_SIZE_BYTES) {
          throw new Error(`PDF too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB exceeds limit`);
        }
        const pdfBuffer = await readFile(source.uri);

        try {
          const pdfData = await pdfParse(pdfBuffer);
          const text = pdfData.text.trim();

          if (text.length > 50) {
            console.error(`  OK: Extracted ${text.length} chars from ${pdfData.numpages} pages (local pdf)`);
            contents.push(text);
          } else {
            throw new Error('PDF has insufficient extractable text (may be scanned/image-based)');
          }
        } catch (pdfErr) {
          throw new Error(`PDF extraction failed: ${pdfErr}`);
        }
      }
      break;
    }

    case "folder": {
      console.error(`Reading folder: ${source.uri}`);
      const { readFile, stat } = await import("fs/promises");
      const { glob } = await import("glob");

      const files = await glob("**/*", {
        cwd: source.uri,
        nodir: true,
        absolute: true,
        ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
      });

      console.error(`Found ${files.length} files (processing max ${MAX_FOLDER_FILES})`);
      let processedCount = 0;
      let skippedCount = 0;

      for (const file of files.slice(0, MAX_FOLDER_FILES)) {
        try {
          // Check file size before reading
          const stats = await stat(file);
          if (stats.size > MAX_FOLDER_FILE_SIZE_BYTES) {
            skippedCount++;
            continue;
          }

          const content = await readFile(file, "utf-8");
          contents.push(content);
          processedCount++;
        } catch {
          // Skip binary files or unreadable files
          skippedCount++;
        }
      }

      console.error(`  Processed ${processedCount} files, skipped ${skippedCount}`);
      break;
    }

    case "sitemap": {
      console.error(`ðŸ—ºï¸ Fetching sitemap: ${source.uri}`);
      const response = await fetchWithTimeout(source.uri);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const xml = await response.text();

      // Simple URL extraction with configurable limit
      const urlMatches = xml.match(/<loc>([^<]+)<\/loc>/g) || [];
      const urls = urlMatches.map(m => m.replace(/<\/?loc>/g, "")).slice(0, MAX_SITEMAP_URLS);

      console.error(`  Found ${urlMatches.length} URLs in sitemap, processing ${urls.length}`);
      let successCount = 0;
      let failCount = 0;

      for (const url of urls) {
        try {
          console.error(`  [fetch] Fetching: ${url}`);
          const pageResponse = await fetchWithTimeout(url);
          if (pageResponse.ok) {
            // Use unified binary handler for all page content
            const result = await extractTextFromResponse({
              url,
              response: pageResponse,
              maxSizeBytes: MAX_FILE_SIZE_BYTES,
            });

            if (result.text.length > 100) {
              console.error(`    OK: ${result.text.length} chars using ${result.extractorUsed}`);
              contents.push(result.text);
              successCount++;
            }
          }

          // Rate limiting between requests
          if (RATE_LIMIT_DELAY_MS > 0) {
            await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
          }
        } catch (err) {
          console.error(`    FAIL: Failed: ${err}`);
          failCount++;
          // Continue with other URLs
        }
      }

      console.error(`  OK: Sitemap complete: ${successCount} success, ${failCount} failed`);
      break;
    }
  }

  console.error(`Fetched ${contents.length} content items`);
  return contents;
}

export function chunkContent(
  contents: string[],
  sourceId: string,
  config: { strategy: string; max_chars: number; overlap_chars: number },
  startIndex: number,
  existingHashes?: Set<string>
): ChunkRecord[] {
  const chunks: ChunkRecord[] = [];
  const seenHashes = existingHashes || new Set<string>();
  let index = startIndex;
  let duplicatesSkipped = 0;
  const maxChars = Number.isFinite(config.max_chars)
    ? Math.max(1, Math.floor(config.max_chars))
    : 1;
  const overlapChars = Number.isFinite(config.overlap_chars)
    ? Math.max(0, Math.min(Math.floor(config.overlap_chars), maxChars - 1))
    : 0;
  const stride = maxChars - overlapChars;
  
  for (const content of contents) {
    // Simple recursive chunking
    const text = content.trim();
    if (!text) continue;
    
    let pos = 0;
    while (pos < text.length) {
      const end = Math.min(pos + maxChars, text.length);
      const chunkText = text.slice(pos, end);
      
      // Generate content hash for deduplication
      const contentHash = sha256(Buffer.from(chunkText)).slice(0, 16);
      
      // Skip duplicate content
      if (seenHashes.has(contentHash)) {
        duplicatesSkipped++;
        if (end >= text.length) break;
        pos += stride;
        continue;
      }
      
      seenHashes.add(contentHash);
      
      chunks.push({
        chunk_id: sha256(Buffer.from(`${sourceId}:${index}`)).slice(0, 32),
        source_id: sourceId,
        text: chunkText,
        position: {
          index,
          start_char: pos,
          end_char: end,
        },
        metadata: {
          content_hash: contentHash,
        },
        created_at: now(),
      });
      
      index++;
      
      // If we've reached the end, break
      if (end >= text.length) break;
      
      // Advance with overlap; `stride` is always at least one.
      pos += stride;
    }
  }
  
  if (duplicatesSkipped > 0) {
    console.error(`  Skipped ${duplicatesSkipped} duplicate chunks`);
  }
  
  return chunks;
}

export async function embedText(text: string, model: EmbeddingModel): Promise<number[]> {
  const apiKey = process.env[model.api_key_env];
  if (!apiKey) {
    throw new Error(`API key not found in env: ${model.api_key_env}. Set this environment variable to your API key.`);
  }

  if (model.provider === "openai") {
    console.error(`Embedding text (${text.length} chars) with ${model.model_name}`);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);

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

  throw new Error(`Unsupported embedding provider: ${model.provider}`);
}

interface EmbedResult {
  vectors: VectorRecord[];
  tokensUsed: number;
  estimatedCostUsd: number;
}

export async function embedChunks(chunks: ChunkRecord[], model: EmbeddingModel): Promise<EmbedResult> {
  const vectors: VectorRecord[] = [];
  let totalTokens = 0;

  if (chunks.length === 0) {
    return { vectors, tokensUsed: 0, estimatedCostUsd: 0 };
  }

  const apiKey = process.env[model.api_key_env];
  if (!apiKey) {
    throw new Error(`API key not found in env: ${model.api_key_env}. Set this environment variable to your API key.`);
  }

  // Batch embed for efficiency
  const batchSize = 50; // Smaller batches for reliability
  const totalBatches = Math.ceil(chunks.length / batchSize);
  logMetric("embed", `Starting embedding`, { chunks: chunks.length, batches: totalBatches, model: model.model_name });

  const maxRateLimitRetries = 3;
  const rateLimitRetries = new Map<number, number>();

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const texts = batch.map(c => c.text);
    const batchNum = Math.floor(i / batchSize) + 1;

    logMetric("embed", `Processing batch`, { batch: batchNum, total: totalBatches, chunks: batch.length });

    if (model.provider === "openai") {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);

      try {
        const response = await fetch("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: model.model_name,
            input: texts,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          // Check for rate limiting
          if (response.status === 429) {
            const attempts = (rateLimitRetries.get(i) ?? 0) + 1;
            if (attempts > maxRateLimitRetries) {
              throw new Error(
                `OpenAI API rate limit persisted after ${maxRateLimitRetries} retries for batch ${batchNum}: ${errorText}`
              );
            }
            rateLimitRetries.set(i, attempts);
            logMetric("embed", `Rate limited, waiting 60s`, {
              batch: batchNum,
              attempt: attempts,
            });
            await new Promise(resolve => setTimeout(resolve, 60000));
            i -= batchSize;
            continue;
          }
          throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
        }

        const data = await response.json() as {
          data: Array<{ embedding: number[]; index: number }>;
          usage?: { total_tokens: number };
        };

        // Track token usage
        if (data.usage?.total_tokens) {
          totalTokens += data.usage.total_tokens;
        }

        for (const item of data.data) {
          vectors.push({
            chunk_id: batch[item.index].chunk_id,
            embedding: item.embedding,
            model: `${model.provider}/${model.model_name}`,
            created_at: now(),
          });
        }

        // Rate limiting between batches
        if (i + batchSize < chunks.length && RATE_LIMIT_DELAY_MS > 0) {
          await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(`Embedding request timed out after ${EMBEDDING_TIMEOUT_MS / 1000}s for batch ${batchNum}`);
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
    } else {
      throw new Error(`Unsupported embedding provider: ${model.provider}`);
    }
  }

  const estimatedCostUsd = (totalTokens / 1_000_000) * EMBEDDING_COST_PER_1M_TOKENS;
  logMetric("embed", `Embedding complete`, {
    vectors: vectors.length,
    tokens: totalTokens,
    estimatedCostUsd: estimatedCostUsd.toFixed(4),
  });

  return { vectors, tokensUsed: totalTokens, estimatedCostUsd };
}

