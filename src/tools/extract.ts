/**
 * IndexFoundry-MCP: Extract Tools (Phase 2)
 *
 * Parsers for extracting text from various document formats.
 * All extractors produce deterministic outputs with detailed reports.
 *
 * Copyright (c) 2024 vario.automation
 * Proprietary and confidential. All rights reserved.
 */

import * as path from "path";
import * as fs from "fs/promises";
import * as cheerio from "cheerio";
import type { PageExtraction, ExtractionReport, ToolError } from "../types.js";
import type { 
  ExtractPdfInput, 
  ExtractHtmlInput, 
  ExtractDocumentInput 
} from "../schemas.js";
import {
  sha256,
  pathExists,
  ensureDir,
  appendJsonl,
  writeJson,
  readJson,
  normalizeText,
  createToolError,
  now,
} from "../utils.js";
import { getRunManager } from "../run-manager.js";

// ============================================================================
// Constants
// ============================================================================

const PDF_PARSE_VERSION = "1.1.1";
const CHEERIO_VERSION = "1.0.0";

// ============================================================================
// Extract PDF
// ============================================================================

export interface ExtractPdfResult {
  success: boolean;
  artifacts: {
    pages_jsonl: string;
    full_text?: string;
  };
  stats: {
    pages_processed: number;
    pages_empty: number;
    pages_ocr_fallback: number;
    chars_extracted: number;
  };
  extraction_report: ExtractionReport;
}

export async function extractPdf(input: ExtractPdfInput): Promise<ExtractPdfResult | ToolError> {
  const manager = getRunManager();
  const runDir = manager.getRunDir(input.run_id);
  
  // Ensure run exists with full infrastructure
  await manager.ensureRun(input.run_id);
  const extractedDir = manager.getExtractedDir(input.run_id);
  
  try {
    // Resolve input path
    const pdfPath = path.join(runDir, input.pdf_path);
    
    if (!await pathExists(pdfPath)) {
      return createToolError("PARSE_ERROR", `PDF file not found: ${input.pdf_path}`, {
        recoverable: false,
      });
    }
    
    // Get file hash for output naming
    const pdfContent = await fs.readFile(pdfPath);
    const pdfHash = sha256(pdfContent);
    
    // Check if already extracted
    const pagesPath = path.join(extractedDir, `${pdfHash}.pages.jsonl`);
    if (await pathExists(pagesPath) && !input.force) {
      // Return existing extraction
      const report = await readJson<ExtractionReport>(
        path.join(extractedDir, `${pdfHash}.report.json`)
      ).catch(() => ({
        extractor_version: PDF_PARSE_VERSION,
        mode_used: input.mode,
        warnings: [],
        pages_processed: 0,
        pages_empty: 0,
        chars_extracted: 0,
      }));
      
      return {
        success: true,
        artifacts: {
          pages_jsonl: `extracted/${pdfHash}.pages.jsonl`,
          full_text: `extracted/${pdfHash}.txt`,
        },
        stats: {
          pages_processed: report.pages_processed,
          pages_empty: report.pages_empty,
          pages_ocr_fallback: 0,
          chars_extracted: report.chars_extracted,
        },
        extraction_report: report,
      };
    }
    
    // Import pdf-parse dynamically
    const pdfParse = (await import("pdf-parse")).default;
    
    // Parse PDF
    const data = await pdfParse(pdfContent, {
      // Limit page range if specified
      max: input.page_range?.end,
    });
    
    // Process pages - pdf-parse gives us full text, we need to approximate pages
    const fullText = normalizeText(data.text);
    const pageCount = data.numpages;
    
    // Split text into approximate pages (heuristic: look for page markers or split evenly)
    const pages: PageExtraction[] = [];
    const avgCharsPerPage = Math.ceil(fullText.length / pageCount);
    
    let offset = 0;
    for (let i = 1; i <= pageCount; i++) {
      // Skip pages before range
      if (input.page_range && i < input.page_range.start) {
        offset += avgCharsPerPage;
        continue;
      }
      
      // Stop after range
      if (input.page_range && i > input.page_range.end) {
        break;
      }
      
      // Extract page text (approximate)
      const pageText = fullText.slice(offset, offset + avgCharsPerPage);
      offset += avgCharsPerPage;
      
      const page: PageExtraction = {
        page: i,
        text: pageText,
        char_count: pageText.length,
        is_empty: pageText.trim().length === 0,
        ocr_used: false,
      };
      
      pages.push(page);
    }
    
    // Write pages JSONL
    await appendJsonl(pagesPath, pages);
    
    // Write full text
    const fullTextPath = path.join(extractedDir, `${pdfHash}.txt`);
    await fs.writeFile(fullTextPath, fullText, "utf-8");
    
    // Generate report
    const report: ExtractionReport = {
      extractor_version: `pdf-parse@${PDF_PARSE_VERSION}`,
      mode_used: input.mode,
      warnings: [],
      pages_processed: pages.length,
      pages_empty: pages.filter(p => p.is_empty).length,
      chars_extracted: fullText.length,
    };
    
    await writeJson(path.join(extractedDir, `${pdfHash}.report.json`), report);
    
    return {
      success: true,
      artifacts: {
        pages_jsonl: `extracted/${pdfHash}.pages.jsonl`,
        full_text: `extracted/${pdfHash}.txt`,
      },
      stats: {
        pages_processed: pages.length,
        pages_empty: pages.filter(p => p.is_empty).length,
        pages_ocr_fallback: 0,
        chars_extracted: fullText.length,
      },
      extraction_report: report,
    };
  } catch (err) {
    return createToolError("PARSE_ERROR", `Failed to extract PDF: ${err}`, {
      recoverable: false,
    });
  }
}

// ============================================================================
// Extract HTML
// ============================================================================

export interface ExtractHtmlResult {
  success: boolean;
  artifacts: {
    text_file: string;
    markdown_file?: string;
  };
  stats: {
    chars_extracted: number;
    headings_found: number;
    links_found: number;
    tables_found: number;
  };
  extraction_report: ExtractionReport;
}

export async function extractHtml(input: ExtractHtmlInput): Promise<ExtractHtmlResult | ToolError> {
  const manager = getRunManager();
  const runDir = manager.getRunDir(input.run_id);
  
  // Ensure run exists with full infrastructure
  await manager.ensureRun(input.run_id);
  const extractedDir = manager.getExtractedDir(input.run_id);
  
  try {
    // Resolve input path
    const htmlPath = path.join(runDir, input.html_path);
    
    if (!await pathExists(htmlPath)) {
      return createToolError("PARSE_ERROR", `HTML file not found: ${input.html_path}`, {
        recoverable: false,
      });
    }
    
    // Read and hash content
    const htmlContent = await fs.readFile(htmlPath, "utf-8");
    const htmlHash = sha256(htmlContent);
    
    // Check if already extracted
    const textPath = path.join(extractedDir, `${htmlHash}.txt`);
    if (await pathExists(textPath) && !input.force) {
      const report = await readJson<ExtractionReport>(
        path.join(extractedDir, `${htmlHash}.report.json`)
      ).catch(() => ({
        extractor_version: CHEERIO_VERSION,
        mode_used: "text",
        warnings: [],
        pages_processed: 1,
        pages_empty: 0,
        chars_extracted: 0,
      }));
      
      return {
        success: true,
        artifacts: {
          text_file: `extracted/${htmlHash}.txt`,
          markdown_file: input.preserve_headings ? `extracted/${htmlHash}.md` : undefined,
        },
        stats: {
          chars_extracted: report.chars_extracted,
          headings_found: 0,
          links_found: 0,
          tables_found: 0,
        },
        extraction_report: report,
      };
    }
    
    // Parse HTML with Cheerio
    const $ = cheerio.load(htmlContent);
    
    // Remove unwanted elements
    if (input.remove_selectors?.length) {
      for (const selector of input.remove_selectors) {
        $(selector).remove();
      }
    }
    
    // Also remove common boilerplate by default
    $("script, style, noscript, iframe, svg").remove();
    
    let text = "";
    let markdown = "";
    let headingsFound = 0;
    let linksFound = 0;
    let tablesFound = 0;
    
    // Extract headings
    if (input.preserve_headings) {
      $("h1, h2, h3, h4, h5, h6").each((_, el) => {
        const level = parseInt(el.tagName[1]);
        const heading = $(el).text().trim();
        if (heading) {
          markdown += `${"#".repeat(level)} ${heading}\n\n`;
          headingsFound++;
        }
      });
    }
    
    // Extract links
    if (input.preserve_links) {
      $("a").each((_, el) => {
        linksFound++;
      });
    }
    
    // Extract tables
    if (input.preserve_tables) {
      $("table").each((_, table) => {
        tablesFound++;
        const rows: string[][] = [];
        
        $(table).find("tr").each((_, tr) => {
          const row: string[] = [];
          $(tr).find("th, td").each((_, cell) => {
            row.push($(cell).text().trim());
          });
          if (row.length) rows.push(row);
        });
        
        if (rows.length) {
          // Convert to markdown table
          const header = rows[0];
          markdown += "| " + header.join(" | ") + " |\n";
          markdown += "| " + header.map(() => "---").join(" | ") + " |\n";
          
          for (let i = 1; i < rows.length; i++) {
            markdown += "| " + rows[i].join(" | ") + " |\n";
          }
          markdown += "\n";
        }
      });
    }
    
    // Get clean text
    text = normalizeText($("body").text());
    
    // If no markdown content, use plain text
    if (!markdown.trim()) {
      markdown = text;
    }
    
    // Write outputs
    await fs.writeFile(textPath, text, "utf-8");
    
    if (input.preserve_headings || input.preserve_tables) {
      const mdPath = path.join(extractedDir, `${htmlHash}.md`);
      await fs.writeFile(mdPath, markdown, "utf-8");
    }
    
    // Generate report
    const report: ExtractionReport = {
      extractor_version: `cheerio@${CHEERIO_VERSION}`,
      mode_used: input.preserve_headings ? "markdown" : "text",
      warnings: [],
      pages_processed: 1,
      pages_empty: text.trim().length === 0 ? 1 : 0,
      chars_extracted: text.length,
    };
    
    await writeJson(path.join(extractedDir, `${htmlHash}.report.json`), report);
    
    return {
      success: true,
      artifacts: {
        text_file: `extracted/${htmlHash}.txt`,
        markdown_file: input.preserve_headings ? `extracted/${htmlHash}.md` : undefined,
      },
      stats: {
        chars_extracted: text.length,
        headings_found: headingsFound,
        links_found: linksFound,
        tables_found: tablesFound,
      },
      extraction_report: report,
    };
  } catch (err) {
    return createToolError("PARSE_ERROR", `Failed to extract HTML: ${err}`, {
      recoverable: false,
    });
  }
}

// ============================================================================
// Extract Document (Generic)
// ============================================================================

export interface ExtractDocumentResult {
  success: boolean;
  artifacts: {
    text_file: string;
  };
  stats: {
    chars_extracted: number;
    format_detected: string;
    rows_processed?: number;
  };
  extraction_report: ExtractionReport;
}

export async function extractDocument(input: ExtractDocumentInput): Promise<ExtractDocumentResult | ToolError> {
  const manager = getRunManager();
  const runDir = manager.getRunDir(input.run_id);
  
  // Ensure run exists with full infrastructure
  await manager.ensureRun(input.run_id);
  const extractedDir = manager.getExtractedDir(input.run_id);
  
  try {
    // Resolve input path
    const docPath = path.join(runDir, input.doc_path);
    
    if (!await pathExists(docPath)) {
      return createToolError("PARSE_ERROR", `Document not found: ${input.doc_path}`, {
        recoverable: false,
      });
    }
    
    // Read content
    const content = await fs.readFile(docPath);
    const hash = sha256(content);
    
    // Detect format
    let format = input.format_hint;
    if (format === "auto") {
      const ext = path.extname(docPath).toLowerCase();
      const mapping: Record<string, string> = {
        ".md": "markdown",
        ".txt": "txt",
        ".csv": "csv",
        ".json": "json",
        ".docx": "docx",
      } as const;
      format = (mapping[ext as keyof typeof mapping] || "txt") as typeof format;
    }
    
    // Check if already extracted
    const textPath = path.join(extractedDir, `${hash}.txt`);
    if (await pathExists(textPath) && !input.force) {
      const report = await readJson<ExtractionReport>(
        path.join(extractedDir, `${hash}.report.json`)
      ).catch(() => ({
        extractor_version: "1.0.0",
        mode_used: format,
        warnings: [],
        pages_processed: 1,
        pages_empty: 0,
        chars_extracted: 0,
      }));
      
      return {
        success: true,
        artifacts: {
          text_file: `extracted/${hash}.txt`,
        },
        stats: {
          chars_extracted: report.chars_extracted,
          format_detected: format,
        },
        extraction_report: report,
      };
    }
    
    let text = "";
    let rowsProcessed: number | undefined;
    const warnings: string[] = [];
    
    switch (format) {
      case "markdown":
      case "txt":
        text = normalizeText(content.toString("utf-8"));
        break;
        
      case "csv":
        // Parse CSV and convert to readable text
        const csvContent = content.toString("utf-8");
        const lines = csvContent.split("\n");
        const previewLines = lines.slice(0, input.csv_preview_rows + 1);
        
        // Simple CSV parsing (proper parsing would use a library)
        const rows = previewLines.map(line => {
          // Basic CSV splitting (doesn't handle quoted fields properly)
          return line.split(",").map(cell => cell.trim());
        });
        
        if (rows.length > 0) {
          // Format as readable table
          const header = rows[0];
          text = header.join(" | ") + "\n";
          text += header.map(() => "---").join(" | ") + "\n";
          
          for (let i = 1; i < rows.length; i++) {
            text += rows[i].join(" | ") + "\n";
          }
          
          rowsProcessed = rows.length - 1;
          
          if (lines.length > input.csv_preview_rows + 1) {
            warnings.push(`CSV truncated to ${input.csv_preview_rows} rows (total: ${lines.length - 1})`);
          }
        }
        break;
        
      case "json":
        // Pretty-print JSON for readability
        try {
          const json = JSON.parse(content.toString("utf-8"));
          text = JSON.stringify(json, null, 2);
        } catch {
          text = content.toString("utf-8");
          warnings.push("Invalid JSON, returning raw content");
        }
        break;
        
      case "docx":
        // DOCX extraction requires additional library
        // For now, return an error suggesting to use a different extractor
        return createToolError("PARSE_ERROR", "DOCX extraction not yet implemented", {
          recoverable: false,
          suggestion: "Convert DOCX to PDF or use external tool",
        });
        
      default:
        text = normalizeText(content.toString("utf-8"));
    }
    
    // Write output
    await fs.writeFile(textPath, text, "utf-8");
    
    // Generate report
    const report: ExtractionReport = {
      extractor_version: "1.0.0",
      mode_used: format,
      warnings,
      pages_processed: 1,
      pages_empty: text.trim().length === 0 ? 1 : 0,
      chars_extracted: text.length,
    };
    
    await writeJson(path.join(extractedDir, `${hash}.report.json`), report);
    
    return {
      success: true,
      artifacts: {
        text_file: `extracted/${hash}.txt`,
      },
      stats: {
        chars_extracted: text.length,
        format_detected: format,
        rows_processed: rowsProcessed,
      },
      extraction_report: report,
    };
  } catch (err) {
    return createToolError("PARSE_ERROR", `Failed to extract document: ${err}`, {
      recoverable: false,
    });
  }
}
