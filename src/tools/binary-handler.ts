/**
 * Unified Binary Handler
 * 
 * This module provides text extraction from various content types:
 * - PDF documents
 * - HTML pages (with Jina fallback for JS-rendered content)
 * - Plain text
 * 
 * Extracted and unified from src/tools/projects.ts for reuse across the codebase.
 */

import * as cheerio from "cheerio";
import pdfParse from "pdf-parse";

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * PDF parse function signature for dependency injection (testing).
 * Matches the pdf-parse library interface.
 */
export type PdfParseFunction = (buffer: Buffer) => Promise<{ text: string; numpages: number }>;

/**
 * Options for text extraction from HTTP response.
 *
 * @example
 * ```ts
 * const result = await extractTextFromResponse({
 *   url: 'https://example.com/doc.pdf',
 *   response,
 *   maxSizeBytes: 10 * 1024 * 1024,
 * });
 * ```
 */
export interface ExtractTextOptions {
  /** The original URL (used for extension detection and error messages) */
  url: string;
  /** The fetch Response object containing the content to extract */
  response: Response;
  /** Maximum allowed size in bytes (default: 10MB) */
  maxSizeBytes?: number;
  /** @internal Inject a custom PDF parser (for testing) */
  _pdfParser?: PdfParseFunction;
}

/**
 * Result of text extraction, including metadata about the extraction process.
 */
export interface ExtractTextResult {
  /** The extracted text content */
  text: string;
  /** The original Content-Type header from the response */
  contentType: string;
  /** Which extractor was used: 'html', 'pdf', 'plain', or 'jina' (for JS-rendered pages) */
  extractorUsed: 'html' | 'pdf' | 'plain' | 'jina';
}

// ============================================================================
// Configuration Constants
// ============================================================================

/** Default maximum file size (10MB) */
const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024;

/** Minimum text length threshold for HTML extraction before Jina fallback */
const MIN_HTML_TEXT_LENGTH = 50;

/** Default timeout for Jina Reader API requests (30 seconds) */
const JINA_TIMEOUT_MS = 30000;

// ============================================================================
// Content-Type Helpers
// ============================================================================

/**
 * Extract the base content type from a Content-Type header (strips charset, etc.)
 */
function getBaseContentType(contentType: string | null): string | null {
  if (!contentType) return null;
  return contentType.split(';')[0].trim().toLowerCase();
}

/**
 * Get file extension from URL, handling query params and fragments
 */
function getUrlExtension(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const lastDot = pathname.lastIndexOf('.');
    if (lastDot === -1 || lastDot === pathname.length - 1) return null;
    return pathname.slice(lastDot + 1).toLowerCase();
  } catch {
    // If URL parsing fails, try simple extraction
    const pathPart = url.split('?')[0].split('#')[0];
    const lastDot = pathPart.lastIndexOf('.');
    if (lastDot === -1 || lastDot === pathPart.length - 1) return null;
    return pathPart.slice(lastDot + 1).toLowerCase();
  }
}

/**
 * Determine which extractor to use based on content-type and URL
 */
function detectExtractorType(
  contentType: string | null,
  url: string
): 'pdf' | 'html' | 'plain' | 'unknown' {
  const baseType = getBaseContentType(contentType);
  const extension = getUrlExtension(url);
  
  // Content-type based detection
  if (baseType) {
    if (baseType === 'application/pdf') return 'pdf';
    if (baseType.startsWith('text/html')) return 'html';
    if (baseType === 'text/plain' || baseType === 'text/markdown') return 'plain';
    
    // Handle generic binary types - fallback to URL extension
    if (baseType === 'application/octet-stream') {
      if (extension === 'pdf') return 'pdf';
      if (extension === 'txt' || extension === 'md') return 'plain';
      return 'unknown';
    }
    
    // Check if it's any text/* type (treat as plain)
    if (baseType.startsWith('text/')) return 'plain';
    
    // Unknown binary type
    return 'unknown';
  }
  
  // No content-type - use URL extension fallback
  if (extension === 'pdf') return 'pdf';
  if (extension === 'txt' || extension === 'md') return 'plain';
  if (extension === 'html' || extension === 'htm') return 'html';
  
  return 'unknown';
}

// ============================================================================
// HTML Extraction (from projects.ts)
// ============================================================================

/**
 * Strip HTML tags and extract text content using cheerio
 */
function extractTextFromHtml(html: string): string {
  const $ = cheerio.load(html);
  
  // Remove elements that don't contain useful content
  $('script, style, noscript, iframe, nav, footer, header, aside').remove();
  $('[role="navigation"], [role="banner"], [role="contentinfo"]').remove();
  $('.nav, .navbar, .sidebar, .footer, .header, .menu, .breadcrumb').remove();
  $('[class*="cookie"], [class*="popup"], [class*="modal"], [class*="advertisement"]').remove();
  
  // Try to find main content area
  let mainContent = $('main, article, [role="main"], .main-content, #main, #content').first();
  if (mainContent.length === 0) {
    mainContent = $('body');
  }
  
  // Get text with some structure preservation
  let text = '';
  
  // Process headings and paragraphs
  mainContent.find('h1, h2, h3, h4, h5, h6, p, li, td, th, dd, dt, blockquote, pre, code').each((_, el) => {
    const $el = $(el);
    const tagName = el.tagName.toLowerCase();
    const content = $el.text().trim();
    
    if (!content) return;
    
    if (tagName.startsWith('h')) {
      text += '\n\n' + content + '\n';
    } else if (tagName === 'li') {
      text += '\n• ' + content;
    } else if (tagName === 'pre' || tagName === 'code') {
      text += '\n```\n' + content + '\n```\n';
    } else {
      text += '\n' + content;
    }
  });
  
  // If structured extraction yielded little, fall back to full text
  if (text.trim().length < 100) {
    text = mainContent.text();
  }
  
  // Clean up whitespace
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.trim();
  
  return text;
}

/**
 * Detect if extracted text is likely from a JS-rendered shell page
 */
function detectShellHtml(text: string, originalHtml: string): boolean {
  // Check for repeated "Loading..." patterns
  const loadingCount = (text.match(/Loading/gi) || []).length;
  if (loadingCount >= 3) {
    return true;
  }
  
  // Check for "Not Found" at the beginning (common SPA fallback)
  if (text.startsWith('Not Found') || text.startsWith('404')) {
    return true;
  }
  
  // Check if text is mostly navigation (short fragments with many newlines)
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  const avgLineLength = lines.reduce((a, b) => a + b.length, 0) / (lines.length || 1);
  if (avgLineLength < 30 && lines.length > 20) {
    // Lots of short lines = likely navigation menu
    return true;
  }
  
  // Check ratio of text to HTML size - shell pages have high HTML with little content
  const textToHtmlRatio = text.length / originalHtml.length;
  if (textToHtmlRatio < 0.05 && originalHtml.length > 5000) {
    // Very low text extraction ratio from large HTML = likely JS-rendered
    return true;
  }
  
  // Check for common SPA framework indicators in HTML
  const spaIndicators = ['__NEXT_DATA__', '__NUXT__', 'window.__INITIAL_STATE__', 'id="root"', 'id="app"'];
  const hasSpIndicator = spaIndicators.some(indicator => originalHtml.includes(indicator));
  if (hasSpIndicator && text.length < 1000) {
    return true;
  }
  
  return false;
}

// ============================================================================
// Jina Reader API
// ============================================================================

/**
 * Fetch via Jina Reader API for JS-rendered pages
 */
async function fetchViaJinaReader(url: string, timeoutMs: number = JINA_TIMEOUT_MS): Promise<string> {
  const jinaUrl = `https://r.jina.ai/${url}`;
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(jinaUrl, {
      headers: { 'Accept': 'text/plain' },
      signal: controller.signal,
    });
    
    if (!response.ok) {
      throw new Error(`Jina Reader failed: HTTP ${response.status}`);
    }
    
    const text = await response.text();
    // Jina returns markdown, clean it up slightly
    return text.replace(/^#+\s*/gm, '').trim();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Jina Reader timed out after ${timeoutMs / 1000}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// Main Extraction Function
// ============================================================================

/**
 * Extract text content from a Response object.
 * 
 * Automatically detects content type from headers or URL extension,
 * applies the appropriate extractor, and returns normalized text.
 * 
 * @param options - Extraction options including URL and Response
 * @returns Promise resolving to extracted text with metadata
 * @throws Error for unsupported content types or extraction failures
 */
export async function extractTextFromResponse(
  options: ExtractTextOptions
): Promise<ExtractTextResult> {
  const { url, response, maxSizeBytes = DEFAULT_MAX_SIZE_BYTES, _pdfParser } = options;
  
  // Get content-type from headers
  const contentTypeHeader = response.headers.get('content-type');
  const baseContentType = getBaseContentType(contentTypeHeader);
  
  // Determine which extractor to use
  const extractorType = detectExtractorType(contentTypeHeader, url);
  
  // Handle unknown/unsupported content types
  if (extractorType === 'unknown') {
    throw new Error(
      `Unsupported content type: cannot extract text from ` +
      `URL: ${url} with content-type: ${contentTypeHeader || 'missing'}`
    );
  }
  
  // Get response body
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  
  // Validate size limit
  if (buffer.length > maxSizeBytes) {
    throw new Error(
      `Content exceeds size limit: ${(buffer.length / 1024 / 1024).toFixed(1)}MB ` +
      `exceeds ${(maxSizeBytes / 1024 / 1024).toFixed(1)}MB limit for URL: ${url}`
    );
  }
  
  // Route to appropriate extractor
  switch (extractorType) {
    case 'pdf':
      return extractPdf(buffer, contentTypeHeader || 'application/pdf', url, _pdfParser);
    
    case 'html':
      return extractHtml(buffer, contentTypeHeader || 'text/html', url);
    
    case 'plain':
      return extractPlainText(buffer, contentTypeHeader || 'text/plain');
    
    default:
      throw new Error(
        `Unsupported content type: cannot extract text from ` +
        `URL: ${url} with content-type: ${contentTypeHeader || 'missing'}`
      );
  }
}

// ============================================================================
// Individual Extractors
// ============================================================================

/**
 * Extract text from PDF buffer
 */
async function extractPdf(
  buffer: Buffer,
  contentType: string,
  url: string,
  customParser?: PdfParseFunction
): Promise<ExtractTextResult> {
  try {
    // Use injected parser if provided (for testing), otherwise use pdf-parse
    const parser = customParser || pdfParse;
    const pdfData = await parser(buffer);
    const text = pdfData.text.trim();
    
    if (text.length < 50) {
      throw new Error(
        `PDF has insufficient extractable text (may require OCR). ` +
        `URL: ${url}, extracted ${text.length} characters`
      );
    }
    
    return {
      text,
      contentType,
      extractorUsed: 'pdf',
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes('insufficient')) {
      throw error; // Re-throw our own errors
    }
    throw new Error(
      `PDF extraction failed: ${error instanceof Error ? error.message : String(error)}. ` +
      `URL: ${url}, content-type: ${contentType}`
    );
  }
}

/**
 * Extract text from HTML buffer, with Jina fallback for JS-rendered content
 */
async function extractHtml(
  buffer: Buffer,
  contentType: string,
  url: string
): Promise<ExtractTextResult> {
  const html = buffer.toString('utf-8');
  let text = extractTextFromHtml(html);
  
  // Detect shell/skeleton HTML from JS-rendered SPAs
  const isShellHtml = detectShellHtml(text, html);
  
  // If insufficient content or shell HTML detected, try Jina Reader
  if (text.length < MIN_HTML_TEXT_LENGTH || isShellHtml) {
    try {
      text = await fetchViaJinaReader(url);
      return {
        text,
        contentType,
        extractorUsed: 'jina',
      };
    } catch {
      // Keep original text if we have any
      if (text.length < 50) {
        throw new Error(
          `Page has insufficient text content and Jina Reader fallback failed. ` +
          `URL: ${url}`
        );
      }
    }
  }
  
  return {
    text,
    contentType,
    extractorUsed: 'html',
  };
}

/**
 * Extract plain text (return as-is)
 */
async function extractPlainText(
  buffer: Buffer,
  contentType: string
): Promise<ExtractTextResult> {
  const text = buffer.toString('utf-8');
  
  return {
    text,
    contentType,
    extractorUsed: 'plain',
  };
}
