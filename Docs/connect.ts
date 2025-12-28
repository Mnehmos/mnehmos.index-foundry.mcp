/**
 * IndexFoundry-MCP Connect Phase Tools
 * 
 * Phase 1: Fetching raw content from various sources.
 * All connectors produce artifacts in runs/<run_id>/raw/
 */

import type { 
  ConnectUrlInput, 
  ConnectSitemapInput, 
  ConnectFolderInput,
  ConnectPdfInput 
} from "../schemas/index.js";
import type { RawArtifact, PdfArtifact } from "../types.js";
import { 
  getRunDirectory, 
  hashBuffer, 
  getExtension, 
  appendJsonl,
  fileExists,
  copyFileWithHash,
  getSortedFiles,
  Timer,
  formatError,
  RunLogger,
} from "../utils.js";
import { promises as fs } from "fs";
import { join, basename } from "path";
import { lookup } from "mime-types";

// Configuration
const RUNS_DIR = process.env.INDEXFOUNDRY_RUNS_DIR ?? "./runs";
const USER_AGENT = "IndexFoundry/0.1.0";

// =============================================================================
// Connect URL
// =============================================================================

export async function handleConnectUrl(
  params: ConnectUrlInput
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown }> {
  const timer = new Timer();
  
  // Get run directory
  const runDir = await getRunDirectory(RUNS_DIR, params.run_id);
  if (!runDir) {
    return {
      content: [{ type: "text", text: `Error: Run ${params.run_id} not found` }],
      structuredContent: {
        success: false,
        error: formatError("RUN_NOT_FOUND", `Run directory ${params.run_id} does not exist`, {
          recoverable: false,
          suggestion: "Create a run first or check the run_id"
        })
      }
    };
  }
  
  const logger = new RunLogger(runDir.paths.logs);
  logger.setContext("connect", "connect_url");
  
  try {
    // Domain check
    if (params.allowed_domains && params.allowed_domains.length > 0) {
      const url = new URL(params.url);
      if (!params.allowed_domains.includes(url.hostname)) {
        await logger.warn(`Domain ${url.hostname} not in allowlist`);
        return {
          content: [{ type: "text", text: `Error: Domain ${url.hostname} not allowed` }],
          structuredContent: {
            success: false,
            error: formatError("DOMAIN_BLOCKED", `Domain ${url.hostname} is not in the allowed domains list`, {
              recoverable: false,
              suggestion: `Add ${url.hostname} to allowed_domains or remove the restriction`
            })
          }
        };
      }
    }
    
    await logger.info(`Fetching ${params.url}`);
    
    // Fetch with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), params.timeout_ms);
    
    const response = await fetch(params.url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        ...params.headers,
      },
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      await logger.error(`HTTP ${response.status}: ${response.statusText}`);
      return {
        content: [{ type: "text", text: `Error: HTTP ${response.status} ${response.statusText}` }],
        structuredContent: {
          success: false,
          error: formatError("FETCH_FAILED", `HTTP ${response.status}: ${response.statusText}`, {
            details: { status: response.status, url: params.url },
            recoverable: response.status >= 500,
            suggestion: response.status === 404 ? "Check if the URL is correct" : "Retry later"
          })
        }
      };
    }
    
    // Get content
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const hash = hashBuffer(buffer);
    const ext = getExtension(contentType);
    
    // Check if already exists
    const artifactPath = join(runDir.paths.raw, `${hash}${ext}`);
    if (!params.force && await fileExists(artifactPath)) {
      await logger.info(`Skipped (already exists): ${hash}${ext}`);
      
      const artifact: RawArtifact = {
        path: artifactPath,
        sha256: hash,
        size_bytes: buffer.length,
        content_type: contentType,
        fetched_at: new Date().toISOString(),
        source_uri: params.url,
      };
      
      return {
        content: [{ type: "text", text: `Skipped (already exists): ${hash}${ext}` }],
        structuredContent: {
          success: true,
          artifact,
          skipped: true,
          duration_ms: timer.elapsedMs()
        }
      };
    }
    
    // Write file
    await fs.writeFile(artifactPath, buffer);
    
    // Append to raw manifest
    const manifestEntry = {
      uri: params.url,
      sha256: hash,
      fetched_at: new Date().toISOString(),
      size_bytes: buffer.length,
      content_type: contentType,
    };
    await appendJsonl(join(runDir.paths.raw, "raw_manifest.jsonl"), manifestEntry);
    
    await logger.info(`Fetched ${hash}${ext} (${buffer.length} bytes)`);
    
    const artifact: RawArtifact = {
      path: artifactPath,
      sha256: hash,
      size_bytes: buffer.length,
      content_type: contentType,
      fetched_at: new Date().toISOString(),
      source_uri: params.url,
    };
    
    return {
      content: [{ type: "text", text: `Fetched: ${hash}${ext} (${buffer.length} bytes)` }],
      structuredContent: {
        success: true,
        artifact,
        skipped: false,
        duration_ms: timer.elapsedMs()
      }
    };
    
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logger.error(`Fetch failed: ${message}`);
    
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      structuredContent: {
        success: false,
        error: formatError("FETCH_FAILED", message, {
          details: { url: params.url },
          recoverable: message.includes("timeout") || message.includes("network"),
          suggestion: "Check network connectivity and try again"
        })
      }
    };
  }
}

// =============================================================================
// Connect Sitemap
// =============================================================================

export async function handleConnectSitemap(
  params: ConnectSitemapInput
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown }> {
  const timer = new Timer();
  
  const runDir = await getRunDirectory(RUNS_DIR, params.run_id);
  if (!runDir) {
    return {
      content: [{ type: "text", text: `Error: Run ${params.run_id} not found` }],
      structuredContent: {
        success: false,
        error: formatError("RUN_NOT_FOUND", `Run directory ${params.run_id} does not exist`)
      }
    };
  }
  
  const logger = new RunLogger(runDir.paths.logs);
  logger.setContext("connect", "connect_sitemap");
  
  try {
    await logger.info(`Fetching sitemap: ${params.sitemap_url}`);
    
    // Fetch sitemap
    const response = await fetch(params.sitemap_url, {
      headers: { "User-Agent": USER_AGENT },
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const sitemapXml = await response.text();
    
    // Parse URLs from sitemap (simple regex extraction for now)
    // TODO: Proper XML parsing with xml2js
    const urlMatches = sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g);
    let urls = Array.from(urlMatches, m => m[1]);
    
    await logger.info(`Found ${urls.length} URLs in sitemap`);
    
    // Apply include patterns
    if (params.include_patterns && params.include_patterns.length > 0) {
      const includeRegexes = params.include_patterns.map(p => new RegExp(p));
      urls = urls.filter(url => includeRegexes.some(r => r.test(url)));
    }
    
    // Apply exclude patterns
    if (params.exclude_patterns && params.exclude_patterns.length > 0) {
      const excludeRegexes = params.exclude_patterns.map(p => new RegExp(p));
      urls = urls.filter(url => !excludeRegexes.some(r => r.test(url)));
    }
    
    // Sort for determinism
    urls.sort();
    
    // Limit
    urls = urls.slice(0, params.max_pages);
    
    await logger.info(`Processing ${urls.length} URLs after filtering`);
    
    // Fetch URLs with concurrency control
    const results: Array<{ url: string; path?: string; sha256?: string; error?: string }> = [];
    let urlsFetched = 0;
    let urlsSkipped = 0;
    let urlsFailed = 0;
    
    // Simple sequential processing for now
    // TODO: Add proper concurrency with p-limit or similar
    for (const url of urls) {
      try {
        const result = await handleConnectUrl({
          run_id: params.run_id,
          url,
          timeout_ms: 30000,
          force: params.force,
        });
        
        const structured = result.structuredContent as { success: boolean; artifact?: RawArtifact; skipped?: boolean };
        
        if (structured.success && structured.artifact) {
          results.push({
            url,
            path: structured.artifact.path,
            sha256: structured.artifact.sha256,
          });
          if (structured.skipped) {
            urlsSkipped++;
          } else {
            urlsFetched++;
          }
        } else {
          urlsFailed++;
          results.push({ url, error: "Fetch failed" });
        }
      } catch (error) {
        urlsFailed++;
        results.push({ url, error: error instanceof Error ? error.message : String(error) });
      }
    }
    
    await logger.info(`Completed: ${urlsFetched} fetched, ${urlsSkipped} skipped, ${urlsFailed} failed`);
    
    return {
      content: [{ 
        type: "text", 
        text: `Sitemap crawl complete: ${urlsFetched} fetched, ${urlsSkipped} skipped, ${urlsFailed} failed` 
      }],
      structuredContent: {
        success: true,
        urls_discovered: urls.length,
        urls_fetched: urlsFetched,
        urls_skipped: urlsSkipped,
        urls_failed: urlsFailed,
        artifacts: results.filter(r => r.path).map(r => ({ url: r.url, path: r.path, sha256: r.sha256 })),
        errors: results.filter(r => r.error).map(r => ({ url: r.url, error: r.error })),
        duration_ms: timer.elapsedMs()
      }
    };
    
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logger.error(`Sitemap crawl failed: ${message}`);
    
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      structuredContent: {
        success: false,
        error: formatError("FETCH_FAILED", message, { recoverable: true })
      }
    };
  }
}

// =============================================================================
// Connect Folder
// =============================================================================

export async function handleConnectFolder(
  params: ConnectFolderInput
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown }> {
  const timer = new Timer();
  
  const runDir = await getRunDirectory(RUNS_DIR, params.run_id);
  if (!runDir) {
    return {
      content: [{ type: "text", text: `Error: Run ${params.run_id} not found` }],
      structuredContent: {
        success: false,
        error: formatError("RUN_NOT_FOUND", `Run directory ${params.run_id} does not exist`)
      }
    };
  }
  
  const logger = new RunLogger(runDir.paths.logs);
  logger.setContext("connect", "connect_folder");
  
  try {
    await logger.info(`Loading folder: ${params.path}`);
    
    // Get sorted file list
    const files = await getSortedFiles(params.path, params.glob);
    
    await logger.info(`Found ${files.length} files matching pattern`);
    
    const maxBytes = params.max_file_size_mb * 1024 * 1024;
    const artifacts: RawArtifact[] = [];
    let filesCopied = 0;
    let filesSkipped = 0;
    let filesTooLarge = 0;
    
    for (const file of files) {
      const stat = await fs.stat(file);
      
      // Skip directories
      if (stat.isDirectory()) continue;
      
      // Check size
      if (stat.size > maxBytes) {
        filesTooLarge++;
        await logger.warn(`Skipped (too large): ${basename(file)} (${stat.size} bytes)`);
        continue;
      }
      
      // Copy file
      const contentType = lookup(file) || "application/octet-stream";
      const ext = getExtension(file);
      
      const { hash, size } = await copyFileWithHash(
        file,
        join(runDir.paths.raw, `placeholder${ext}`) // Temp path
      );
      
      const artifactPath = join(runDir.paths.raw, `${hash}${ext}`);
      
      // Check if already exists
      if (!params.force && await fileExists(artifactPath)) {
        filesSkipped++;
        // Remove the temp copy
        await fs.unlink(join(runDir.paths.raw, `placeholder${ext}`)).catch(() => {});
        continue;
      }
      
      // Rename to hash-based name
      await fs.rename(join(runDir.paths.raw, `placeholder${ext}`), artifactPath);
      
      const artifact: RawArtifact = {
        path: artifactPath,
        sha256: hash,
        size_bytes: size,
        content_type: contentType,
        fetched_at: new Date().toISOString(),
        source_uri: `file://${file}`,
      };
      
      artifacts.push(artifact);
      
      // Append to manifest
      await appendJsonl(join(runDir.paths.raw, "raw_manifest.jsonl"), {
        uri: artifact.source_uri,
        sha256: hash,
        fetched_at: artifact.fetched_at,
        size_bytes: size,
        content_type: contentType,
      });
      
      filesCopied++;
    }
    
    await logger.info(`Completed: ${filesCopied} copied, ${filesSkipped} skipped, ${filesTooLarge} too large`);
    
    return {
      content: [{ 
        type: "text", 
        text: `Folder load complete: ${filesCopied} copied, ${filesSkipped} skipped, ${filesTooLarge} too large` 
      }],
      structuredContent: {
        success: true,
        files_found: files.length,
        files_copied: filesCopied,
        files_skipped: filesSkipped,
        files_too_large: filesTooLarge,
        artifacts,
        duration_ms: timer.elapsedMs()
      }
    };
    
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logger.error(`Folder load failed: ${message}`);
    
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      structuredContent: {
        success: false,
        error: formatError("FILE_ERROR", message, { recoverable: false })
      }
    };
  }
}

// =============================================================================
// Connect PDF
// =============================================================================

export async function handleConnectPdf(
  params: ConnectPdfInput
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown }> {
  const timer = new Timer();
  
  const runDir = await getRunDirectory(RUNS_DIR, params.run_id);
  if (!runDir) {
    return {
      content: [{ type: "text", text: `Error: Run ${params.run_id} not found` }],
      structuredContent: {
        success: false,
        error: formatError("RUN_NOT_FOUND", `Run directory ${params.run_id} does not exist`)
      }
    };
  }
  
  const logger = new RunLogger(runDir.paths.logs);
  logger.setContext("connect", "connect_pdf");
  
  try {
    let buffer: Buffer;
    let sourceUri: string;
    
    // Check if URL or local path
    if (params.source.startsWith("http://") || params.source.startsWith("https://")) {
      await logger.info(`Fetching PDF from URL: ${params.source}`);
      
      const response = await fetch(params.source, {
        headers: { "User-Agent": USER_AGENT },
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      buffer = Buffer.from(await response.arrayBuffer());
      sourceUri = params.source;
    } else {
      await logger.info(`Loading PDF from file: ${params.source}`);
      buffer = await fs.readFile(params.source);
      sourceUri = `file://${params.source}`;
    }
    
    const hash = hashBuffer(buffer);
    const artifactPath = join(runDir.paths.raw, `${hash}.pdf`);
    
    // Check if already exists
    if (!params.force && await fileExists(artifactPath)) {
      await logger.info(`Skipped (already exists): ${hash}.pdf`);
      
      // Still need to extract metadata for response
      // TODO: Read from cached metadata or extract again
      
      return {
        content: [{ type: "text", text: `Skipped (already exists): ${hash}.pdf` }],
        structuredContent: {
          success: true,
          skipped: true,
          artifact: {
            path: artifactPath,
            sha256: hash,
            size_bytes: buffer.length,
            content_type: "application/pdf",
            fetched_at: new Date().toISOString(),
            source_uri: sourceUri,
            // PDF metadata would go here
            page_count: 0, // TODO: Extract
            pdf_version: "unknown",
            has_ocr_layer: false,
            pdf_metadata: {}
          },
          duration_ms: timer.elapsedMs()
        }
      };
    }
    
    // Write file
    await fs.writeFile(artifactPath, buffer);
    
    // Extract PDF metadata
    // TODO: Use pdf-parse or similar for metadata extraction
    const pageCount = 0; // Placeholder
    const pdfVersion = "unknown";
    const hasOcrLayer = false;
    
    const artifact: PdfArtifact = {
      path: artifactPath,
      sha256: hash,
      size_bytes: buffer.length,
      content_type: "application/pdf",
      fetched_at: new Date().toISOString(),
      source_uri: sourceUri,
      page_count: pageCount,
      pdf_version: pdfVersion,
      has_ocr_layer: hasOcrLayer,
      pdf_metadata: {
        // TODO: Extract from PDF
      },
    };
    
    // Append to manifest
    await appendJsonl(join(runDir.paths.raw, "raw_manifest.jsonl"), {
      uri: sourceUri,
      sha256: hash,
      fetched_at: artifact.fetched_at,
      size_bytes: buffer.length,
      content_type: "application/pdf",
      page_count: pageCount,
    });
    
    await logger.info(`Fetched PDF: ${hash}.pdf (${buffer.length} bytes, ${pageCount} pages)`);
    
    return {
      content: [{ type: "text", text: `Fetched PDF: ${hash}.pdf (${buffer.length} bytes)` }],
      structuredContent: {
        success: true,
        artifact,
        skipped: false,
        duration_ms: timer.elapsedMs()
      }
    };
    
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logger.error(`PDF fetch failed: ${message}`);
    
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      structuredContent: {
        success: false,
        error: formatError("FETCH_FAILED", message, { recoverable: true })
      }
    };
  }
}
