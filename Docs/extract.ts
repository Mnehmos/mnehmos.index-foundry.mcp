/**
 * IndexFoundry-MCP Extract Phase Tools
 * 
 * Phase 2: Converting raw content to text.
 * All extractors produce artifacts in runs/<run_id>/extracted/
 */

import type { 
  ExtractPdfInput, 
  ExtractHtmlInput, 
  ExtractDocumentInput 
} from "../schemas/index.js";

// Stub implementations - to be filled in

export async function handleExtractPdf(
  params: ExtractPdfInput
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown }> {
  // TODO: Implement PDF text extraction with pdfminer.six or pdf-parse
  return {
    content: [{ type: "text", text: `[STUB] Would extract PDF: ${params.pdf_path}` }],
    structuredContent: {
      success: false,
      error: { code: "NOT_IMPLEMENTED", message: "PDF extraction not yet implemented" }
    }
  };
}

export async function handleExtractHtml(
  params: ExtractHtmlInput
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown }> {
  // TODO: Implement HTML text extraction with cheerio
  return {
    content: [{ type: "text", text: `[STUB] Would extract HTML: ${params.html_path}` }],
    structuredContent: {
      success: false,
      error: { code: "NOT_IMPLEMENTED", message: "HTML extraction not yet implemented" }
    }
  };
}

export async function handleExtractDocument(
  params: ExtractDocumentInput
): Promise<{ content: Array<{ type: "text"; text: string }>; structuredContent?: unknown }> {
  // TODO: Implement generic document extraction
  return {
    content: [{ type: "text", text: `[STUB] Would extract document: ${params.doc_path}` }],
    structuredContent: {
      success: false,
      error: { code: "NOT_IMPLEMENTED", message: "Document extraction not yet implemented" }
    }
  };
}
