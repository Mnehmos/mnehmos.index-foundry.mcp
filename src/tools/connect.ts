/**
 * IndexFoundry-MCP: Connect Tools (Phase 1)
 *
 * Fetchers for various content sources: URLs, sitemaps, folders, PDFs.
 * All tools are idempotent and produce deterministic outputs.
 *
 * Copyright (c) 2024 vario.automation
 * Proprietary and confidential. All rights reserved.
 */

import * as path from "path";
import * as fs from "fs/promises";
import { XMLParser } from "fast-xml-parser";
import { glob } from "glob";
import type { RawArtifact, ToolError } from "../types.js";
import type { 
  ConnectUrlInput, 
  ConnectSitemapInput, 
  ConnectFolderInput,
  ConnectPdfInput 
} from "../schemas.js";
import { 
  sha256, 
  pathExists, 
  ensureDir,
  extensionFromContentType,
  contentTypeFromExtension,
  appendJsonl,
  writeJson,
  createToolError,
  now,
} from "../utils.js";
import { getRunManager } from "../run-manager.js";

// ============================================================================
// Connect URL
// ============================================================================

export interface ConnectUrlResult {
  success: boolean;
  artifact: {
    path: string;
    sha256: string;
    size_bytes: number;
    content_type: string;
    fetched_at: string;
  };
  skipped?: boolean;
  error?: string;
}

export async function connectUrl(input: ConnectUrlInput): Promise<ConnectUrlResult | ToolError> {
  const manager = getRunManager();
  const config = manager.getConfig();
  
  // Ensure run exists with full infrastructure
  await manager.ensureRun(input.run_id);
  const rawDir = manager.getRawDir(input.run_id);
  
  try {
    // Check domain allowlist
    const url = new URL(input.url);
    const blockedDomains = config.security.blocked_domains;
    
    if (blockedDomains.includes(url.hostname)) {
      return createToolError("DOMAIN_BLOCKED", `Domain ${url.hostname} is blocked`, {
        recoverable: false,
        suggestion: "Remove domain from blocked_domains in config",
      });
    }
    
    if (input.allowed_domains?.length && !input.allowed_domains.includes(url.hostname)) {
      return createToolError("DOMAIN_BLOCKED", `Domain ${url.hostname} not in allowlist`, {
        recoverable: false,
        suggestion: "Add domain to allowed_domains parameter",
      });
    }
    
    // Fetch the URL
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeout_ms);
    
    const headers: Record<string, string> = {
      "User-Agent": config.defaults.connect.user_agent,
      ...input.headers,
    };
    
    let response: Response;
    try {
      response = await fetch(input.url, {
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    
    if (!response.ok) {
      return createToolError("FETCH_FAILED", `HTTP ${response.status}: ${response.statusText}`, {
        details: { url: input.url, status: response.status },
        recoverable: response.status >= 500,
        suggestion: response.status >= 500 ? "Retry later" : "Check URL validity",
      });
    }
    
    // Get content
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const hash = sha256(buffer);
    const ext = extensionFromContentType(contentType);
    const filename = `${hash}${ext}`;
    const outputPath = path.join(rawDir, filename);
    
    // Check if already exists (idempotency)
    if (await pathExists(outputPath) && !input.force) {
      const stats = await fs.stat(outputPath);
      return {
        success: true,
        skipped: true,
        artifact: {
          path: `raw/${filename}`,
          sha256: hash,
          size_bytes: stats.size,
          content_type: contentType.split(";")[0].trim(),
          fetched_at: now(),
        },
      };
    }
    
    // Check file size
    if (buffer.length > config.defaults.connect.max_file_size_mb * 1024 * 1024) {
      return createToolError("FILE_TOO_LARGE", 
        `File exceeds max size of ${config.defaults.connect.max_file_size_mb}MB`, {
        details: { size_mb: buffer.length / (1024 * 1024) },
        recoverable: false,
        suggestion: "Increase max_file_size_mb in config",
      });
    }
    
    // Write to disk
    await fs.writeFile(outputPath, buffer);
    
    // Record in raw manifest
    const artifact: RawArtifact = {
      uri: input.url,
      sha256: hash,
      fetched_at: now(),
      size_bytes: buffer.length,
      content_type: contentType.split(";")[0].trim(),
      local_path: `raw/${filename}`,
    };
    
    await appendJsonl(path.join(rawDir, "raw_manifest.jsonl"), [artifact]);
    
    return {
      success: true,
      artifact: {
        path: `raw/${filename}`,
        sha256: hash,
        size_bytes: buffer.length,
        content_type: contentType.split(";")[0].trim(),
        fetched_at: artifact.fetched_at,
      },
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return createToolError("FETCH_TIMEOUT", `Request timed out after ${input.timeout_ms}ms`, {
        details: { url: input.url },
        recoverable: true,
        suggestion: "Increase timeout_ms or check network",
      });
    }
    
    return createToolError("FETCH_FAILED", `Failed to fetch URL: ${err}`, {
      details: { url: input.url, error: String(err) },
      recoverable: true,
      suggestion: "Check URL and network connectivity",
    });
  }
}

// ============================================================================
// Connect Sitemap
// ============================================================================

export interface ConnectSitemapResult {
  success: boolean;
  urls_discovered: number;
  urls_fetched: number;
  urls_skipped: number;
  urls_failed: number;
  artifacts: Array<{
    url: string;
    path: string;
    sha256: string;
  }>;
  errors: Array<{ url: string; error: string }>;
}

export async function connectSitemap(input: ConnectSitemapInput): Promise<ConnectSitemapResult | ToolError> {
  const manager = getRunManager();
  const config = manager.getConfig();
  
  try {
    // Fetch sitemap XML
    const response = await fetch(input.sitemap_url, {
      headers: { "User-Agent": config.defaults.connect.user_agent },
    });
    
    if (!response.ok) {
      return createToolError("FETCH_FAILED", `Failed to fetch sitemap: HTTP ${response.status}`, {
        recoverable: response.status >= 500,
      });
    }
    
    const xml = await response.text();
    const parser = new XMLParser({ ignoreAttributes: false });
    const parsed = parser.parse(xml);
    
    // Extract URLs from sitemap
    let urls: string[] = [];
    
    // Handle both regular sitemaps and sitemap indexes
    if (parsed.sitemapindex?.sitemap) {
      // Sitemap index - for now just get URLs from first level
      const sitemaps = Array.isArray(parsed.sitemapindex.sitemap) 
        ? parsed.sitemapindex.sitemap 
        : [parsed.sitemapindex.sitemap];
      urls = sitemaps.map((s: { loc: string }) => s.loc);
    } else if (parsed.urlset?.url) {
      const urlEntries = Array.isArray(parsed.urlset.url) 
        ? parsed.urlset.url 
        : [parsed.urlset.url];
      urls = urlEntries.map((u: { loc: string }) => u.loc);
    }
    
    // Apply include/exclude patterns
    if (input.include_patterns?.length) {
      const regexes = input.include_patterns.map(p => new RegExp(p));
      urls = urls.filter(url => regexes.some(r => r.test(url)));
    }
    
    if (input.exclude_patterns?.length) {
      const regexes = input.exclude_patterns.map(p => new RegExp(p));
      urls = urls.filter(url => !regexes.some(r => r.test(url)));
    }
    
    // Sort for determinism
    urls.sort();
    
    // Limit URLs
    urls = urls.slice(0, input.max_pages);
    
    const result: ConnectSitemapResult = {
      success: true,
      urls_discovered: urls.length,
      urls_fetched: 0,
      urls_skipped: 0,
      urls_failed: 0,
      artifacts: [],
      errors: [],
    };
    
    // Fetch URLs with concurrency control
    const queue = [...urls];
    const inFlight: Promise<void>[] = [];
    
    const fetchOne = async (url: string): Promise<void> => {
      const urlResult = await connectUrl({
        run_id: input.run_id,
        url,
        allowed_domains: input.allowed_domains,
        timeout_ms: 30000,
        force: input.force,
      });
      
      if ("isError" in urlResult) {
        result.urls_failed++;
        result.errors.push({ url, error: urlResult.message });
      } else if (urlResult.skipped) {
        result.urls_skipped++;
        result.artifacts.push({
          url,
          path: urlResult.artifact.path,
          sha256: urlResult.artifact.sha256,
        });
      } else {
        result.urls_fetched++;
        result.artifacts.push({
          url,
          path: urlResult.artifact.path,
          sha256: urlResult.artifact.sha256,
        });
      }
    };
    
    while (queue.length > 0 || inFlight.length > 0) {
      // Fill up to concurrency limit
      while (queue.length > 0 && inFlight.length < input.concurrency) {
        const url = queue.shift()!;
        const promise = fetchOne(url).then(() => {
          const idx = inFlight.indexOf(promise);
          if (idx >= 0) inFlight.splice(idx, 1);
        });
        inFlight.push(promise);
      }
      
      // Wait for at least one to complete
      if (inFlight.length > 0) {
        await Promise.race(inFlight);
      }
    }
    
    return result;
  } catch (err) {
    return createToolError("FETCH_FAILED", `Failed to process sitemap: ${err}`, {
      recoverable: true,
    });
  }
}

// ============================================================================
// Connect Folder
// ============================================================================

export interface ConnectFolderResult {
  success: boolean;
  files_discovered: number;
  files_copied: number;
  files_skipped: number;
  files_failed: number;
  artifacts: Array<{
    source_path: string;
    path: string;
    sha256: string;
    size_bytes: number;
  }>;
  errors: Array<{ path: string; error: string }>;
}

export async function connectFolder(input: ConnectFolderInput): Promise<ConnectFolderResult | ToolError> {
  const manager = getRunManager();
  const config = manager.getConfig();
  
  // Ensure run exists with full infrastructure
  await manager.ensureRun(input.run_id);
  const rawDir = manager.getRawDir(input.run_id);
  
  try {
    // Verify source path exists
    if (!await pathExists(input.path)) {
      return createToolError("FETCH_FAILED", `Folder not found: ${input.path}`, {
        recoverable: false,
      });
    }
    
    // Find matching files
    const pattern = path.join(input.path, input.glob).replace(/\\/g, "/");
    let files = await glob(pattern, { nodir: true });
    
    // Apply exclude patterns
    if (input.exclude_patterns?.length) {
      const regexes = input.exclude_patterns.map(p => new RegExp(p));
      files = files.filter(f => !regexes.some(r => r.test(f)));
    }
    
    // Sort for determinism
    files.sort();
    
    const result: ConnectFolderResult = {
      success: true,
      files_discovered: files.length,
      files_copied: 0,
      files_skipped: 0,
      files_failed: 0,
      artifacts: [],
      errors: [],
    };
    
    const maxBytes = config.defaults.connect.max_file_size_mb * 1024 * 1024;
    
    for (const filePath of files) {
      try {
        const stats = await fs.stat(filePath);
        
        // Skip large files
        if (stats.size > maxBytes) {
          result.files_skipped++;
          result.errors.push({ 
            path: filePath, 
            error: `File exceeds max size of ${config.defaults.connect.max_file_size_mb}MB` 
          });
          continue;
        }
        
        // Read file and hash
        const content = await fs.readFile(filePath);
        const hash = sha256(content);
        const ext = path.extname(filePath);
        const contentType = contentTypeFromExtension(ext);
        const filename = `${hash}${ext}`;
        const outputPath = path.join(rawDir, filename);
        
        // Check if exists
        if (await pathExists(outputPath) && !input.force) {
          result.files_skipped++;
          result.artifacts.push({
            source_path: filePath,
            path: `raw/${filename}`,
            sha256: hash,
            size_bytes: stats.size,
          });
          continue;
        }
        
        // Copy to raw directory
        await fs.copyFile(filePath, outputPath);
        
        // Record in manifest
        const artifact: RawArtifact = {
          uri: `file://${filePath}`,
          sha256: hash,
          fetched_at: now(),
          size_bytes: stats.size,
          content_type: contentType,
          local_path: `raw/${filename}`,
        };
        
        await appendJsonl(path.join(rawDir, "raw_manifest.jsonl"), [artifact]);
        
        result.files_copied++;
        result.artifacts.push({
          source_path: filePath,
          path: `raw/${filename}`,
          sha256: hash,
          size_bytes: stats.size,
        });
      } catch (err) {
        result.files_failed++;
        result.errors.push({ path: filePath, error: String(err) });
      }
    }
    
    return result;
  } catch (err) {
    return createToolError("FETCH_FAILED", `Failed to process folder: ${err}`, {
      recoverable: false,
    });
  }
}

// ============================================================================
// Connect PDF
// ============================================================================

export interface ConnectPdfResult {
  success: boolean;
  artifact: {
    path: string;
    sha256: string;
    size_bytes: number;
    page_count?: number;
    pdf_version?: string;
    has_ocr_layer?: boolean;
    metadata?: {
      title?: string;
      author?: string;
      created?: string;
      modified?: string;
    };
  };
  skipped?: boolean;
}

export async function connectPdf(input: ConnectPdfInput): Promise<ConnectPdfResult | ToolError> {
  const manager = getRunManager();
  
  // Ensure run exists with full infrastructure
  await manager.ensureRun(input.run_id);
  const rawDir = manager.getRawDir(input.run_id);
  
  // Determine if source is URL or local path
  const isUrl = input.source.startsWith("http://") || input.source.startsWith("https://");
  
  let content: Buffer;
  let originalUri: string;
  
  try {
    if (isUrl) {
      // Fetch from URL
      const result = await connectUrl({
        run_id: input.run_id,
        url: input.source,
        timeout_ms: 60000, // Longer timeout for PDFs
        force: input.force,
      });
      
      if ("isError" in result) {
        return result;
      }
      
      // Read the fetched file
      const fullPath = path.join(manager.getRunDir(input.run_id), result.artifact.path);
      content = await fs.readFile(fullPath);
      originalUri = input.source;
      
      // Basic PDF validation
      if (!content.toString("utf8", 0, 5).includes("%PDF")) {
        return createToolError("PARSE_ERROR", "File does not appear to be a valid PDF", {
          recoverable: false,
        });
      }
      
      return {
        success: true,
        skipped: result.skipped,
        artifact: {
          path: result.artifact.path,
          sha256: result.artifact.sha256,
          size_bytes: result.artifact.size_bytes,
        },
      };
    } else {
      // Read from local path
      if (!await pathExists(input.source)) {
        return createToolError("FETCH_FAILED", `PDF file not found: ${input.source}`, {
          recoverable: false,
        });
      }
      
      content = await fs.readFile(input.source);
      originalUri = `file://${input.source}`;
      
      // Basic PDF validation
      if (!content.toString("utf8", 0, 5).includes("%PDF")) {
        return createToolError("PARSE_ERROR", "File does not appear to be a valid PDF", {
          recoverable: false,
        });
      }
      
      const hash = sha256(content);
      const filename = `${hash}.pdf`;
      const outputPath = path.join(rawDir, filename);
      
      // Check if exists
      if (await pathExists(outputPath) && !input.force) {
        return {
          success: true,
          skipped: true,
          artifact: {
            path: `raw/${filename}`,
            sha256: hash,
            size_bytes: content.length,
          },
        };
      }
      
      // Copy to raw directory
      await fs.writeFile(outputPath, content);
      
      // Record in manifest
      const artifact: RawArtifact = {
        uri: originalUri,
        sha256: hash,
        fetched_at: now(),
        size_bytes: content.length,
        content_type: "application/pdf",
        local_path: `raw/${filename}`,
      };
      
      await appendJsonl(path.join(rawDir, "raw_manifest.jsonl"), [artifact]);
      
      return {
        success: true,
        artifact: {
          path: `raw/${filename}`,
          sha256: hash,
          size_bytes: content.length,
        },
      };
    }
  } catch (err) {
    return createToolError("FETCH_FAILED", `Failed to fetch PDF: ${err}`, {
      recoverable: true,
    });
  }
}
