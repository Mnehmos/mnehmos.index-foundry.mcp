/**
 * Unified Binary Handler Tests
 *
 * These tests define the contract for extractTextFromResponse().
 * The function handles content-type detection, PDF extraction, HTML parsing,
 * and plain text handling with fallback strategies.
 *
 * Feature Requirements:
 * - Detect content type from Response headers
 * - Fallback to URL extension when content-type is missing/generic
 * - Extract text from PDF buffers
 * - Extract text from HTML with Jina fallback for JS-rendered content
 * - Handle plain text directly
 * - Provide meaningful errors with URL and content-type context
 *
 * Integration Points:
 * - src/tools/binary-handler.ts - Main extraction logic
 */

import { describe, it, expect } from 'vitest';

// Import the function and types
import {
  extractTextFromResponse,
  type PdfParseFunction
} from '../src/tools/binary-handler.js';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a mock Response object for testing
 * UBH-001: Mock Response factory helper
 */
function createMockResponse(options: {
  contentType?: string;
  body: string | Buffer;
  status?: number;
  url?: string;
}): Response {
  const { contentType, body, status = 200, url = 'https://example.com/test' } = options;
  
  const headers = new Headers();
  if (contentType) {
    headers.set('Content-Type', contentType);
  }
  
  // Convert body to appropriate format for Response constructor
  // Buffer needs to be converted to Uint8Array for Web API compatibility
  const bodyContent: BodyInit = Buffer.isBuffer(body)
    ? new Uint8Array(body)
    : body;
  
  // Create a mock Response
  const response = new Response(bodyContent, {
    status,
    headers
  });
  
  // Override URL property (Response.url is read-only, so we need to mock it)
  Object.defineProperty(response, 'url', {
    value: url,
    writable: false
  });
  
  return response;
}

/**
 * Create a mock PDF parser that returns valid text
 */
function createMockPdfParser(text: string = 'Hello World - This is test content from a valid PDF document.'): PdfParseFunction {
  return async (_buffer: Buffer) => ({
    text,
    numpages: 1
  });
}

/**
 * Create a mock PDF parser that throws an error (corrupted PDF)
 */
function createCorruptedPdfParser(): PdfParseFunction {
  return async (_buffer: Buffer) => {
    throw new Error('Invalid PDF structure');
  };
}

/**
 * Create a mock PDF parser that returns empty text (image-only PDF)
 */
function createImageOnlyPdfParser(): PdfParseFunction {
  return async (_buffer: Buffer) => ({
    text: '',
    numpages: 1
  });
}

/**
 * Create a minimal valid PDF buffer for testing
 * This is a mock PDF - the actual parsing is handled by injected mock parser
 */
function createValidPdfBuffer(): Buffer {
  // Simple PDF header to identify as PDF - actual parsing uses injected mock
  return Buffer.from('%PDF-1.4\n%Test PDF for mocking\n%%EOF\n', 'utf-8');
}

/**
 * Create a corrupted PDF buffer (invalid structure)
 */
function createCorruptedPdfBuffer(): Buffer {
  return Buffer.from('%PDF-1.4\n\nCORRUPTED DATA - NOT A VALID PDF STRUCTURE\n%%EOF', 'utf-8');
}

/**
 * Create an image-only PDF buffer (no extractable text)
 * This simulates a scanned document with only images
 */
function createImageOnlyPdfBuffer(): Buffer {
  return Buffer.from('%PDF-1.4\n%Image-only PDF\n%%EOF\n', 'utf-8');
}

// ============================================================================
// Content-Type Detection Tests (UBH-100 to UBH-103)
// ============================================================================

describe('Content-Type Detection', () => {
  it('UBH-100: should use PDF extractor when content-type is application/pdf', async () => {
    const pdfBuffer = createValidPdfBuffer();
    const response = createMockResponse({
      contentType: 'application/pdf',
      body: pdfBuffer,
      url: 'https://example.com/document.pdf'
    });

    const result = await extractTextFromResponse({
      url: 'https://example.com/document.pdf',
      response,
      _pdfParser: createMockPdfParser()
    });

    expect(result.extractorUsed).toBe('pdf');
    expect(result.contentType).toBe('application/pdf');
    expect(result.text).toBeDefined();
  });

  it('UBH-101: should use HTML extractor when content-type is text/html', async () => {
    const htmlContent = `<!DOCTYPE html>
<html>
<head><title>Test Page</title></head>
<body>
<h1>Hello World</h1>
<p>This is a test paragraph with meaningful content that should be extracted properly.</p>
</body>
</html>`;
    
    const response = createMockResponse({
      contentType: 'text/html; charset=utf-8',
      body: htmlContent,
      url: 'https://example.com/page.html'
    });

    const result = await extractTextFromResponse({
      url: 'https://example.com/page.html',
      response
    });

    expect(result.extractorUsed).toBe('html');
    expect(result.contentType).toContain('text/html');
    expect(result.text).toContain('Hello World');
    expect(result.text).not.toContain('<h1>');
  });

  it('UBH-102: should use plain text extractor when content-type is text/plain', async () => {
    const plainText = 'This is plain text content that should be returned as-is.';
    
    const response = createMockResponse({
      contentType: 'text/plain',
      body: plainText,
      url: 'https://example.com/readme.txt'
    });

    const result = await extractTextFromResponse({
      url: 'https://example.com/readme.txt',
      response
    });

    expect(result.extractorUsed).toBe('plain');
    expect(result.contentType).toBe('text/plain');
    expect(result.text).toBe(plainText);
  });

  it('UBH-103: should throw descriptive error for unknown binary content-type', async () => {
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD]);
    
    const response = createMockResponse({
      contentType: 'application/x-unknown-binary',
      body: binaryData,
      url: 'https://example.com/file.bin'
    });

    await expect(extractTextFromResponse({
      url: 'https://example.com/file.bin',
      response
    })).rejects.toThrow(/unsupported|unknown|cannot extract/i);
  });
});

// ============================================================================
// URL Extension Fallback Tests (UBH-110 to UBH-112)
// ============================================================================

describe('URL Extension Fallback', () => {
  it('UBH-110: should use PDF extractor when content-type is missing but URL ends with .pdf', async () => {
    const pdfBuffer = createValidPdfBuffer();
    
    const response = createMockResponse({
      contentType: undefined, // No content-type header
      body: pdfBuffer,
      url: 'https://example.com/document.pdf'
    });

    const result = await extractTextFromResponse({
      url: 'https://example.com/document.pdf',
      response,
      _pdfParser: createMockPdfParser()
    });

    expect(result.extractorUsed).toBe('pdf');
    expect(result.text).toBeDefined();
  });

  it('UBH-111: should use plain text extractor when content-type is missing but URL ends with .txt', async () => {
    const textContent = 'Plain text file content.';
    
    const response = createMockResponse({
      contentType: undefined, // No content-type header
      body: textContent,
      url: 'https://example.com/notes.txt'
    });

    const result = await extractTextFromResponse({
      url: 'https://example.com/notes.txt',
      response
    });

    expect(result.extractorUsed).toBe('plain');
    expect(result.text).toBe(textContent);
  });

  it('UBH-112: should use PDF extractor when content-type is application/octet-stream but URL ends with .pdf', async () => {
    const pdfBuffer = createValidPdfBuffer();
    
    const response = createMockResponse({
      contentType: 'application/octet-stream', // Generic binary
      body: pdfBuffer,
      url: 'https://example.com/document.pdf'
    });

    const result = await extractTextFromResponse({
      url: 'https://example.com/document.pdf',
      response,
      _pdfParser: createMockPdfParser()
    });

    expect(result.extractorUsed).toBe('pdf');
    expect(result.text).toBeDefined();
  });
});

// ============================================================================
// PDF Extraction Tests (UBH-120 to UBH-122)
// ============================================================================

describe('PDF Extraction', () => {
  it('UBH-120: should extract text from valid PDF buffer', async () => {
    const pdfBuffer = createValidPdfBuffer();
    
    const response = createMockResponse({
      contentType: 'application/pdf',
      body: pdfBuffer,
      url: 'https://example.com/document.pdf'
    });

    const result = await extractTextFromResponse({
      url: 'https://example.com/document.pdf',
      response,
      _pdfParser: createMockPdfParser('Hello World - This is test content from a valid PDF document.')
    });

    expect(result.extractorUsed).toBe('pdf');
    expect(result.text.length).toBeGreaterThan(0);
    // The mock PDF returns "Hello World"
    expect(result.text).toContain('Hello');
  });

  it('UBH-121: should throw meaningful error for corrupted PDF', async () => {
    const corruptedPdf = createCorruptedPdfBuffer();
    
    const response = createMockResponse({
      contentType: 'application/pdf',
      body: corruptedPdf,
      url: 'https://example.com/corrupted.pdf'
    });

    await expect(extractTextFromResponse({
      url: 'https://example.com/corrupted.pdf',
      response,
      _pdfParser: createCorruptedPdfParser()
    })).rejects.toThrow(/corrupt|invalid|parse|failed/i);
  });

  it('UBH-122: should throw insufficient text error for image-only PDF', async () => {
    const imageOnlyPdf = createImageOnlyPdfBuffer();
    
    const response = createMockResponse({
      contentType: 'application/pdf',
      body: imageOnlyPdf,
      url: 'https://example.com/scanned.pdf'
    });

    await expect(extractTextFromResponse({
      url: 'https://example.com/scanned.pdf',
      response,
      _pdfParser: createImageOnlyPdfParser()
    })).rejects.toThrow(/insufficient|no text|empty|ocr/i);
  });
});

// ============================================================================
// HTML Extraction Tests (UBH-130 to UBH-132)
// ============================================================================

describe('HTML Extraction', () => {
  it('UBH-130: should extract text without HTML tags from valid HTML', async () => {
    const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <title>Test Document</title>
  <script>console.log("ignored");</script>
  <style>body { color: red; }</style>
</head>
<body>
  <nav>Navigation Menu</nav>
  <main>
    <h1>Main Heading</h1>
    <p>This is a paragraph with <strong>bold text</strong> and <em>italic text</em>.</p>
    <p>Another paragraph with sufficient content to pass extraction thresholds and provide meaningful text.</p>
  </main>
  <footer>Footer content</footer>
</body>
</html>`;
    
    const response = createMockResponse({
      contentType: 'text/html',
      body: htmlContent,
      url: 'https://example.com/article.html'
    });

    const result = await extractTextFromResponse({
      url: 'https://example.com/article.html',
      response
    });

    expect(result.extractorUsed).toBe('html');
    expect(result.text).toContain('Main Heading');
    expect(result.text).toContain('paragraph');
    // Should not contain HTML tags
    expect(result.text).not.toMatch(/<[^>]+>/);
    // Should not contain script content
    expect(result.text).not.toContain('console.log');
  });

  it('UBH-131: should trigger Jina fallback for JavaScript-rendered shell HTML', async () => {
    // This represents a React/Vue/Angular app shell that has minimal content
    const jsShellHtml = `<!DOCTYPE html>
<html>
<head>
  <title>App</title>
</head>
<body>
  <div id="root"></div>
  <noscript>You need to enable JavaScript to run this app.</noscript>
  <script src="/static/js/main.chunk.js"></script>
</body>
</html>`;
    
    const response = createMockResponse({
      contentType: 'text/html',
      body: jsShellHtml,
      url: 'https://example.com/app'
    });

    const result = await extractTextFromResponse({
      url: 'https://example.com/app',
      response
    });

    // When HTML has minimal content, should fall back to Jina
    expect(result.extractorUsed).toBe('jina');
  });

  it('UBH-132: should trigger Jina fallback when extracted HTML text is less than 200 characters', async () => {
    const minimalHtml = `<!DOCTYPE html>
<html>
<head><title>Page</title></head>
<body><p>Short.</p></body>
</html>`;
    
    const response = createMockResponse({
      contentType: 'text/html',
      body: minimalHtml,
      url: 'https://example.com/short-page.html'
    });

    const result = await extractTextFromResponse({
      url: 'https://example.com/short-page.html',
      response
    });

    // When extracted text is too short, should fall back to Jina
    expect(result.extractorUsed).toBe('jina');
  });
});

// ============================================================================
// Error Handling Tests (UBH-140 to UBH-141)
// ============================================================================

describe('Error Handling', () => {
  it('UBH-140: should throw error when content exceeds size limit', async () => {
    // Create a large buffer that exceeds the default size limit
    const largeBuffer = Buffer.alloc(50 * 1024 * 1024, 'x'); // 50MB
    
    const response = createMockResponse({
      contentType: 'text/plain',
      body: largeBuffer,
      url: 'https://example.com/huge-file.txt'
    });

    await expect(extractTextFromResponse({
      url: 'https://example.com/huge-file.txt',
      response,
      maxSizeBytes: 10 * 1024 * 1024 // 10MB limit
    })).rejects.toThrow(/size|limit|too large|exceeds/i);
  });

  it('UBH-141: should include URL and content-type in error messages', async () => {
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xFF]);
    const testUrl = 'https://example.com/mystery-file.xyz';
    const testContentType = 'application/x-mystery';
    
    const response = createMockResponse({
      contentType: testContentType,
      body: binaryData,
      url: testUrl
    });

    try {
      await extractTextFromResponse({
        url: testUrl,
        response
      });
      // Should not reach here
      expect(true).toBe(false);
    } catch (error) {
      const errorMessage = (error as Error).message;
      // Error should include both URL and content-type for debugging
      expect(errorMessage).toContain(testUrl);
      expect(errorMessage).toContain(testContentType);
    }
  });
});

// ============================================================================
// Additional Edge Case Tests
// ============================================================================

describe('Edge Cases', () => {
  it('should handle Response with empty body', async () => {
    const response = createMockResponse({
      contentType: 'text/plain',
      body: '',
      url: 'https://example.com/empty.txt'
    });

    const result = await extractTextFromResponse({
      url: 'https://example.com/empty.txt',
      response
    });

    expect(result.text).toBe('');
    expect(result.extractorUsed).toBe('plain');
  });

  it('should handle content-type with additional parameters', async () => {
    const response = createMockResponse({
      contentType: 'text/html; charset=utf-8; boundary=something',
      body: '<html><body><main><p>Test content that is long enough to pass threshold requirements. More text here to ensure it passes.</p></main></body></html>',
      url: 'https://example.com/page.html'
    });

    const result = await extractTextFromResponse({
      url: 'https://example.com/page.html',
      response
    });

    expect(result.extractorUsed).toBe('html');
  });

  it('should handle URL with query parameters when detecting extension', async () => {
    const pdfBuffer = createValidPdfBuffer();
    
    const response = createMockResponse({
      contentType: undefined,
      body: pdfBuffer,
      url: 'https://example.com/download.pdf?token=abc123&expires=12345'
    });

    const result = await extractTextFromResponse({
      url: 'https://example.com/download.pdf?token=abc123&expires=12345',
      response,
      _pdfParser: createMockPdfParser()
    });

    expect(result.extractorUsed).toBe('pdf');
  });

  it('should handle URL with fragment when detecting extension', async () => {
    const textContent = 'Text file content.';
    
    const response = createMockResponse({
      contentType: undefined,
      body: textContent,
      url: 'https://example.com/readme.txt#section-1'
    });

    const result = await extractTextFromResponse({
      url: 'https://example.com/readme.txt#section-1',
      response
    });

    expect(result.extractorUsed).toBe('plain');
  });

  it('should handle markdown content-type', async () => {
    const markdownContent = `# Heading

This is **bold** and *italic* text.

- List item 1
- List item 2`;
    
    const response = createMockResponse({
      contentType: 'text/markdown',
      body: markdownContent,
      url: 'https://example.com/readme.md'
    });

    const result = await extractTextFromResponse({
      url: 'https://example.com/readme.md',
      response
    });

    // Markdown should be treated as plain text
    expect(result.extractorUsed).toBe('plain');
    expect(result.text).toBe(markdownContent);
  });
});
