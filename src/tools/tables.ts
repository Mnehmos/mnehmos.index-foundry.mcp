/**
 * 📊 Table-Aware Processing Tool - IndexFoundry-MCP
 *
 * Extracts, parses, and linearizes tables from markdown, HTML, and CSV content.
 * Produces structured data and text representations optimized for RAG retrieval.
 *
 * Features:
 * - Table detection in markdown, HTML, and CSV formats
 * - Structured extraction (headers, rows, column types)
 * - Multiple linearization strategies (row-by-row, column-by-column, natural language)
 * - Automatic chunking for large tables
 * - Context and caption extraction
 * - Deterministic table IDs (SHA256)
 *
 * @module tools/tables
 * @see tests/table-processing.test.ts for the test contract
 *
 * Copyright (c) 2024 vario.automation
 * Proprietary and confidential. All rights reserved.
 */

import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import * as cheerio from 'cheerio';
import { getRunManager } from '../run-manager.js';
import { createToolError } from '../utils.js';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Linearization strategy for converting tables to searchable text
 * - row_by_row: "Row 1: Col1=Val1, Col2=Val2; Row 2: ..."
 * - column_by_column: "Column 'Name': Val1, Val2; Column 'Age': ..."
 * - natural_language: Prose description of table structure and content
 */
export type LinearizationStrategy = 'row_by_row' | 'column_by_column' | 'natural_language';

/**
 * Position information for a table within the source document
 */
export interface TablePosition {
  /** Byte offset where table starts */
  byte_start: number;
  /** Byte offset where table ends */
  byte_end: number;
  /** Line number where table starts (1-indexed) */
  line_start?: number;
  /** Line number where table ends (1-indexed) */
  line_end?: number;
}

/**
 * Source information for an extracted table
 */
export interface TableSource {
  /** Path to the source file (relative to run directory) */
  file_path: string;
  /** Position within the source file */
  position: TablePosition;
}

/**
 * Metadata about an extracted table
 */
export interface TableMetadata {
  /** Detected caption (e.g., "Table 1: Revenue Summary") */
  caption?: string;
  /** Text content before the table */
  context_before?: string;
  /** Text content after the table */
  context_after?: string;
  /** Number of data rows (excluding header) */
  row_count: number;
  /** Number of columns */
  column_count: number;
  /** Whether a header row was detected */
  has_header: boolean;
}

/**
 * Structural representation of a table
 */
export interface TableStructure {
  /** Column header labels */
  headers: string[];
  /** Data rows (array of arrays) */
  rows: string[][];
  /** Inferred column types (string, number, currency, percentage, date) */
  column_types?: string[];
}

/**
 * Linearized representation of table content
 */
export interface LinearizedTable {
  /** Strategy used for linearization */
  strategy: string;
  /** Linearized text content */
  text: string;
}

/**
 * Complete extracted table data
 */
export interface ExtractedTable {
  /** Deterministic table ID (SHA256 hash of content) */
  table_id: string;
  /** Source file and position information */
  source: TableSource;
  /** Table metadata (dimensions, caption, context) */
  metadata: TableMetadata;
  /** Structured table data */
  structure: TableStructure;
  /** Linearized text representation */
  linearized: LinearizedTable;
  /** Auto-generated summary of table content */
  summary?: string;
}

/**
 * Table-specific chunk data for RAG retrieval
 */
export interface TableChunkData {
  /** Reference to parent table */
  table_id: string;
  /** Row range covered by this chunk */
  row_range?: { start: number; end: number };
  /** Whether this chunk includes the header row */
  is_header_chunk: boolean;
  /** Linearized content for this chunk */
  linearized_content: string;
}

/**
 * Extended document chunk for tables
 */
export interface TableChunk {
  /** Unique chunk identifier */
  chunk_id: string;
  /** Chunk content */
  content: {
    text: string;
  };
  /** Table-specific metadata */
  table_data?: TableChunkData;
}

/**
 * Statistics from table extraction
 */
export interface ExtractTableStats {
  /** Number of tables detected */
  tables_found: number;
  /** Total data rows across all tables */
  total_rows: number;
  /** Total cells across all tables */
  total_cells: number;
}

/**
 * Result from extractTables function
 */
export interface ExtractTablesResult {
  /** Array of extracted tables */
  tables: ExtractedTable[];
  /** Generated chunks for RAG retrieval */
  chunks?: TableChunk[];
  /** Path to output JSONL file */
  output_path: string;
  /** Extraction statistics */
  stats: ExtractTableStats;
}

// ============================================================================
// Input Schema
// ============================================================================

/**
 * Zod schema for extractTables tool input
 * Validates and types all input parameters
 */
export const ExtractTableInputSchema = z.object({
  run_id: z.string().uuid()
    .describe("🔑 Run directory identifier (UUID v7)"),
  input_path: z.string()
    .describe("📄 Path to extracted content file (relative to run directory)"),
  source_type: z.enum(["markdown", "html", "csv"]).default("markdown")
    .describe("📋 Source content format for table detection"),
  options: z.object({
    include_caption: z.boolean().default(true)
      .describe("📝 Extract table captions from surrounding text"),
    include_context: z.boolean().default(true)
      .describe("📖 Include text before/after table for context"),
    context_chars: z.number().int().min(0).max(500).default(100)
      .describe("📏 Maximum characters of context to extract (0-500)"),
    generate_summary: z.boolean().default(true)
      .describe("📊 Generate human-readable summary of table"),
    max_rows_for_chunk: z.number().int().min(1).max(100).default(20)
      .describe("✂️ Maximum rows per chunk for large tables (1-100)"),
    linearization_strategy: z.enum([
      "row_by_row",
      "column_by_column",
      "natural_language"
    ]).default("row_by_row")
      .describe("🔄 Strategy for converting table to searchable text")
  }).optional()
    .describe("⚙️ Table extraction and processing options")
});

export type ExtractTableInput = z.infer<typeof ExtractTableInputSchema>;

// ============================================================================
// Internal Types
// ============================================================================

/**
 * Internal representation of a parsed table before processing
 */
interface RawTableMatch {
  text: string;
  byteStart: number;
  byteEnd: number;
  headers: string[];
  rows: string[][];
  hasHeader: boolean;
}

// ============================================================================
// Hash & ID Generation Utilities
// ============================================================================

/**
 * Generate deterministic table ID from content.
 * Uses SHA256 hash truncated to 16 characters.
 *
 * @param content - Table content to hash
 * @returns 16-character hex string
 *
 * @example
 * generateTableId("| A | B |\\n| 1 | 2 |")
 * // returns "a1b2c3d4e5f6g7h8"
 */
function generateTableId(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Generate unique chunk ID from table ID and chunk index.
 *
 * @param tableId - Parent table ID
 * @param chunkIndex - Zero-based chunk index
 * @returns 16-character hex string
 */
function generateChunkId(tableId: string, chunkIndex: number): string {
  return createHash('sha256').update(`${tableId}-chunk-${chunkIndex}`).digest('hex').slice(0, 16);
}

// ============================================================================
// Text Parsing Utilities
// ============================================================================

/**
 * Count lines before a given byte position in content.
 *
 * @param content - Full document content
 * @param bytePos - Byte position to count lines before
 * @returns Line number (1-indexed)
 */
function countLinesBefore(content: string, bytePos: number): number {
  const textBefore = content.slice(0, bytePos);
  return textBefore.split('\n').length;
}

/**
 * Extract context before and after a table.
 *
 * @param fullContent - Full document content
 * @param tableStart - Byte offset where table starts
 * @param tableEnd - Byte offset where table ends
 * @param contextChars - Maximum characters to extract
 * @returns Object with before/after context strings
 */
function extractContext(
  fullContent: string,
  tableStart: number,
  tableEnd: number,
  contextChars: number
): { before: string; after: string } {
  const beforeStart = Math.max(0, tableStart - contextChars);
  const before = fullContent.slice(beforeStart, tableStart).trim();
  const after = fullContent.slice(tableEnd, tableEnd + contextChars).trim();
  return { before, after };
}

/**
 * Detect caption from context before table.
 * Matches patterns like "Table 1: Description" or "Figure 2. Description"
 *
 * @param contextBefore - Text content before the table
 * @returns Detected caption or undefined
 *
 * @example
 * detectCaption("Table 1: Revenue Summary\\n\\n")
 * // returns "Table 1: Revenue Summary"
 */
function detectCaption(contextBefore: string): string | undefined {
  const lines = contextBefore.split('\n').filter(l => l.trim());
  if (lines.length === 0) return undefined;

  // Check last few lines for caption patterns
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
    const line = lines[i].trim();

    // Match "Table 1: Description" or "Figure 2. Description"
    const match = line.match(/^(Table|Figure)\s*(\d+)\s*[:.]\s*(.+)/i);
    if (match) {
      return `${match[1]} ${match[2]}: ${match[3]}`.trim();
    }

    // Match "Table N Description" without colon/period
    const simpleMatch = line.match(/^(Table|Figure)\s+(\d+)\s+(.+)/i);
    if (simpleMatch) {
      return `${simpleMatch[1]} ${simpleMatch[2]}: ${simpleMatch[3]}`.trim();
    }

    // Match "Table N" alone
    const bareMatch = line.match(/^(Table|Figure)\s+(\d+)\s*$/i);
    if (bareMatch) {
      return `${bareMatch[1]} ${bareMatch[2]}`;
    }
  }

  return undefined;
}

// ============================================================================
// Column Type Inference
// ============================================================================

/**
 * Infer column types from data values.
 * Detects: string, number, currency, percentage, date
 *
 * @param rows - Data rows (array of arrays)
 * @param headers - Column headers
 * @returns Array of inferred type strings
 *
 * @example
 * inferColumnTypes([["$100", "50%"]], ["Price", "Change"])
 * // returns ["currency", "percentage"]
 */
function inferColumnTypes(rows: string[][], headers: string[]): string[] {
  return headers.map((_, colIndex) => {
    const values = rows.map(r => r[colIndex]).filter(v => v && v.trim().length > 0);

    if (values.length === 0) return 'string';

    // Check for currency/money values
    if (values.every(v => /^\$[\d,]+(\.\d{2})?$/.test(v.trim()))) return 'currency';

    // Check for percentages
    if (values.every(v => /^[+-]?\d+(\.\d+)?%$/.test(v.trim()))) return 'percentage';

    // Check if all values are numbers
    if (values.every(v => !isNaN(Number(v.replace(/[$,%]/g, '').replace(/,/g, ''))))) return 'number';

    // Check for dates (simple heuristic)
    if (values.every(v => !isNaN(Date.parse(v)))) return 'date';

    return 'string';
  });
}

// ============================================================================
// Linearization Strategies
// ============================================================================

/**
 * Linearize table content based on selected strategy.
 *
 * Strategies:
 * - row_by_row: "Row 1: Product=Widget, Price=$100; Row 2: ..."
 * - column_by_column: "Column 'Product': Widget, Gadget; Column 'Price': ..."
 * - natural_language: Prose description of table
 *
 * @param headers - Column header labels
 * @param rows - Data rows
 * @param strategy - Linearization strategy
 * @returns Linearized text representation
 *
 * @example
 * linearizeTable(["Name", "Age"], [["John", "30"]], "row_by_row")
 * // returns "Row 1: Name=John, Age=30"
 */
function linearizeTable(
  headers: string[],
  rows: string[][],
  strategy: LinearizationStrategy
): string {
  switch (strategy) {
    case 'row_by_row':
      return rows.map((row, i) =>
        `Row ${i + 1}: ${headers.map((h, j) => `${h}=${row[j] || ''}`).join(', ')}`
      ).join('; ');

    case 'column_by_column':
      return headers.map((h, j) =>
        `Column '${h}': ${rows.map(r => r[j] || '').join(', ')}`
      ).join('; ');

    case 'natural_language':
      const rowCount = rows.length;
      const colCount = headers.length;
      let description = `This table has ${rowCount} rows and ${colCount} columns. `;
      description += `The columns are: ${headers.join(', ')}. `;
      if (rows.length > 0) {
        const sampleParts = headers.map((h, j) => {
          const sampleValues = rows.slice(0, 3).map(r => r[j] || '').filter(v => v).join(', ');
          return `${h} values include ${sampleValues}`;
        });
        description += `Sample data: ${sampleParts.join('. ')}.`;
      }
      return description;
  }
}

/**
 * Generate a human-readable summary for a table.
 *
 * @param table - Object containing headers, rows, and metadata
 * @returns Summary string
 *
 * @example
 * generateTableSummary({ headers: ["A", "B"], rows: [["1", "2"]], metadata: { row_count: 1, column_count: 2 }})
 * // returns "Table with 1 row and 2 columns. Columns: A, B."
 */
function generateTableSummary(table: { headers: string[]; rows: string[][]; metadata: TableMetadata }): string {
  const { headers, metadata } = table;
  const rowCount = metadata.row_count;
  const colCount = metadata.column_count;

  let summary = `Table with ${rowCount} row${rowCount !== 1 ? 's' : ''} and ${colCount} column${colCount !== 1 ? 's' : ''}`;

  if (headers.length > 0) {
    summary += `. Columns: ${headers.slice(0, 5).join(', ')}`;
    if (headers.length > 5) {
      summary += ` and ${headers.length - 5} more`;
    }
  }

  if (metadata.caption) {
    summary += `. Caption: ${metadata.caption}`;
  }

  return summary + '.';
}

// ============================================================================
// Markdown Table Parsing
// ============================================================================

/**
 * Detect and parse markdown tables from content.
 *
 * Supports:
 * - Standard markdown tables with header separator (|---|---|)
 * - Simple pipe-delimited tables without separator
 *
 * @param content - Markdown content to parse
 * @returns Array of parsed table matches
 */
function parseMarkdownTables(content: string): RawTableMatch[] {
  const tables: RawTableMatch[] = [];

  // Regex to match markdown tables with header separator
  // Matches: | Header | ... |\n|----|----|...\n (with optional data rows)
  const tableRegex = /\|[^\n]+\|\n\|[-:| ]+\|(\n\|[^\n]+\|)*/g;

  let match;
  while ((match = tableRegex.exec(content)) !== null) {
    const tableText = match[0];
    const byteStart = match.index;
    const byteEnd = match.index + tableText.length;

    const lines = tableText.trim().split('\n');
    if (lines.length < 2) continue;

    // Parse headers (first line)
    const headerLine = lines[0];
    const headers = headerLine
      .split('|')
      .slice(1, -1) // Remove empty first and last elements
      .map(h => h.trim());

    // Skip separator line (line 1) and parse data rows
    const rows: string[][] = [];
    for (let i = 2; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('|')) continue;
      const cells = line
        .split('|')
        .slice(1, -1)
        .map(c => c.trim());
      rows.push(cells);
    }

    tables.push({
      text: tableText,
      byteStart,
      byteEnd,
      headers,
      rows,
      hasHeader: true
    });
  }

  // Also try to match tables without proper header separator
  const simpleTableRegex = /(\|[^\n]+\|\n)+/g;
  let simpleMatch;
  while ((simpleMatch = simpleTableRegex.exec(content)) !== null) {
    const tableText = simpleMatch[0];
    const byteStart = simpleMatch.index;
    const byteEnd = simpleMatch.index + tableText.length;

    // Skip if this overlaps with an already found table
    const overlaps = tables.some(t =>
      (byteStart >= t.byteStart && byteStart < t.byteEnd) ||
      (byteEnd > t.byteStart && byteEnd <= t.byteEnd) ||
      (byteStart <= t.byteStart && byteEnd >= t.byteEnd)
    );
    if (overlaps) continue;

    const lines = tableText.trim().split('\n');
    if (lines.length < 1) continue;

    // Check if second line is a separator
    if (lines.length >= 2 && /^\|[-:| ]+\|$/.test(lines[1])) {
      // Already handled by the first regex
      continue;
    }

    // Parse all lines as rows, first line as headers
    const allRows: string[][] = [];
    for (const line of lines) {
      if (!line.includes('|')) continue;
      const cells = line
        .split('|')
        .slice(1, -1)
        .map(c => c.trim());
      if (cells.length > 0) {
        allRows.push(cells);
      }
    }

    if (allRows.length === 0) continue;

    // Use first row as headers, rest as data
    const headers = allRows[0];
    const rows = allRows.slice(1);

    tables.push({
      text: tableText,
      byteStart,
      byteEnd,
      headers,
      rows,
      hasHeader: true // Treat first row as header
    });
  }

  return tables;
}

// ============================================================================
// HTML Table Parsing
// ============================================================================

/**
 * Parse HTML tables using cheerio.
 *
 * Handles:
 * - <th> elements as headers
 * - <td> elements as data cells
 * - Falls back to first row as headers if no <th> found
 *
 * @param content - HTML content to parse
 * @returns Array of parsed table matches
 */
function parseHtmlTables(content: string): RawTableMatch[] {
  const $ = cheerio.load(content);
  const tables: RawTableMatch[] = [];

  $('table').each((_, table) => {
    const $table = $(table);
    const tableHtml = $.html(table);
    const byteStart = content.indexOf(tableHtml);
    const byteEnd = byteStart >= 0 ? byteStart + tableHtml.length : 0;

    const headers: string[] = [];
    const rows: string[][] = [];

    // Try to get headers from <th> elements
    $table.find('th').each((_, th) => {
      headers.push($(th).text().trim());
    });

    // Get rows from <tr> elements
    $table.find('tr').each((_, tr) => {
      const row: string[] = [];
      $(tr).find('td').each((_, td) => {
        row.push($(td).text().trim());
      });
      if (row.length > 0) {
        rows.push(row);
      }
    });

    // If no <th> headers, use first row as headers
    let hasHeader = headers.length > 0;
    if (headers.length === 0 && rows.length > 0) {
      headers.push(...rows.shift()!);
      hasHeader = true; // We're treating first row as header
    }

    tables.push({
      text: tableHtml,
      byteStart: byteStart >= 0 ? byteStart : 0,
      byteEnd: byteEnd,
      headers,
      rows,
      hasHeader
    });
  });

  return tables;
}

// ============================================================================
// CSV Parsing
// ============================================================================

/**
 * Parse a single CSV line, handling quoted values.
 *
 * @param line - CSV line to parse
 * @param delimiter - Field delimiter (default: ',')
 * @returns Array of field values
 *
 * @example
 * parseCsvLine('"Hello, World",123')
 * // returns ["Hello, World", "123"]
 */
function parseCsvLine(line: string, delimiter: string = ','): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  let prevChar = '';

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"' && prevChar !== '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote
        current += '"';
        i++; // Skip next quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
    prevChar = char;
  }
  result.push(current.trim());

  return result;
}

/**
 * Parse CSV content into a table structure.
 *
 * @param content - CSV content to parse
 * @param delimiter - Field delimiter (default: ',')
 * @returns Parsed table match
 */
function parseCsvContent(content: string, delimiter: string = ','): RawTableMatch {
  const lines = content.trim().split('\n').filter(l => l.trim());

  if (lines.length === 0) {
    return {
      text: content,
      byteStart: 0,
      byteEnd: content.length,
      headers: [],
      rows: [],
      hasHeader: false
    };
  }

  const headers = parseCsvLine(lines[0], delimiter);
  const rows = lines.slice(1).map(line => parseCsvLine(line, delimiter));

  return {
    text: content,
    byteStart: 0,
    byteEnd: content.length,
    headers,
    rows,
    hasHeader: true
  };
}

// ============================================================================
// Chunking Logic
// ============================================================================

/**
 * Create chunks from extracted tables for RAG retrieval.
 * Splits large tables into multiple chunks based on max_rows_for_chunk.
 *
 * @param tables - Array of extracted tables
 * @param maxRowsPerChunk - Maximum rows per chunk
 * @param strategy - Linearization strategy to use
 * @returns Array of table chunks
 */
function createChunks(
  tables: ExtractedTable[],
  maxRowsPerChunk: number,
  strategy: LinearizationStrategy
): TableChunk[] {
  const chunks: TableChunk[] = [];

  for (const table of tables) {
    const totalRows = table.structure.rows.length;

    if (totalRows <= maxRowsPerChunk) {
      // Single chunk for small table
      const chunkId = generateChunkId(table.table_id, 0);
      chunks.push({
        chunk_id: chunkId,
        content: {
          text: table.linearized.text
        },
        table_data: {
          table_id: table.table_id,
          row_range: totalRows > 0 ? { start: 0, end: totalRows - 1 } : undefined,
          is_header_chunk: true,
          linearized_content: table.linearized.text
        }
      });
    } else {
      // Split into multiple chunks
      let chunkIndex = 0;
      for (let startRow = 0; startRow < totalRows; startRow += maxRowsPerChunk) {
        const endRow = Math.min(startRow + maxRowsPerChunk - 1, totalRows - 1);
        const chunkRows = table.structure.rows.slice(startRow, endRow + 1);

        const linearizedContent = linearizeTable(
          table.structure.headers,
          chunkRows,
          strategy
        );

        const chunkId = generateChunkId(table.table_id, chunkIndex);
        chunks.push({
          chunk_id: chunkId,
          content: {
            text: linearizedContent
          },
          table_data: {
            table_id: table.table_id,
            row_range: { start: startRow, end: endRow },
            is_header_chunk: chunkIndex === 0,
            linearized_content: linearizedContent
          }
        });

        chunkIndex++;
      }
    }
  }

  return chunks;
}

// ============================================================================
// Main Implementation
// ============================================================================

/**
 * Extract tables from a document and produce structured data with linearized text.
 *
 * This tool detects, parses, and processes tables from markdown, HTML, or CSV content.
 * It produces:
 * - Structured table data (headers, rows, column types)
 * - Linearized text representations for vector embedding
 * - Chunks for large tables
 * - Context and caption extraction
 *
 * @param input - Extraction input containing run_id, input_path, and options
 * @returns Promise resolving to extraction result with tables, chunks, and stats
 * @throws {ToolError} FILE_NOT_FOUND - If input file does not exist
 * @throws {ToolError} READ_ERROR - If file cannot be read
 *
 * @example Basic usage
 * ```typescript
 * const result = await extractTables({
 *   run_id: 'abc-123',
 *   input_path: 'extracted/doc.md',
 *   source_type: 'markdown'
 * });
 * // result.tables contains ExtractedTable[]
 * // result.chunks contains TableChunk[]
 * ```
 *
 * @example With custom options
 * ```typescript
 * const result = await extractTables({
 *   run_id: 'abc-123',
 *   input_path: 'extracted/data.csv',
 *   source_type: 'csv',
 *   options: {
 *     linearization_strategy: 'column_by_column',
 *     max_rows_for_chunk: 10,
 *     include_context: false
 *   }
 * });
 * ```
 *
 * @example Processing HTML tables
 * ```typescript
 * const result = await extractTables({
 *   run_id: 'abc-123',
 *   input_path: 'extracted/page.html',
 *   source_type: 'html',
 *   options: {
 *     generate_summary: true,
 *     include_caption: true
 *   }
 * });
 * ```
 */
export async function extractTables(input: ExtractTableInput): Promise<ExtractTablesResult> {
  // Parse and apply defaults
  const parsed = ExtractTableInputSchema.parse(input);
  const options = {
    include_caption: parsed.options?.include_caption ?? true,
    include_context: parsed.options?.include_context ?? true,
    context_chars: parsed.options?.context_chars ?? 100,
    generate_summary: parsed.options?.generate_summary ?? true,
    max_rows_for_chunk: parsed.options?.max_rows_for_chunk ?? 20,
    linearization_strategy: parsed.options?.linearization_strategy ?? 'row_by_row' as LinearizationStrategy
  };

  // Get run directory
  const runManager = getRunManager();
  const runDir = runManager.getRunDir(parsed.run_id);

  // Read input file
  const inputFilePath = path.join(runDir, parsed.input_path);
  let content: string;
  try {
    content = await fs.readFile(inputFilePath, 'utf-8');
  } catch (error) {
    throw createToolError('READ_FAILED', `Failed to read input file: ${inputFilePath}`, {
      details: { path: inputFilePath, error: String(error) },
      recoverable: false,
      suggestion: 'Verify the input_path is correct and the file exists in the run directory'
    });
  }

  // Detect and parse tables based on source type
  let rawTables: RawTableMatch[];

  switch (parsed.source_type) {
    case 'markdown':
      rawTables = parseMarkdownTables(content);
      break;
    case 'html':
      rawTables = parseHtmlTables(content);
      break;
    case 'csv':
      rawTables = [parseCsvContent(content)];
      break;
    default:
      rawTables = [];
  }

  // Process raw tables into ExtractedTable format
  const tables: ExtractedTable[] = [];
  let totalRows = 0;
  let totalCells = 0;

  for (const raw of rawTables) {
    // Skip empty tables for markdown/html (but keep for CSV which might have headers-only)
    if (raw.headers.length === 0 && raw.rows.length === 0) {
      continue;
    }

    const tableId = generateTableId(raw.text);

    // Calculate line numbers
    const lineStart = countLinesBefore(content, raw.byteStart);
    const lineEnd = countLinesBefore(content, raw.byteEnd);

    // Extract context if requested
    let contextBefore: string | undefined;
    let contextAfter: string | undefined;
    let caption: string | undefined;

    if (options.include_context) {
      const ctx = extractContext(content, raw.byteStart, raw.byteEnd, options.context_chars);
      contextBefore = ctx.before;
      contextAfter = ctx.after;
    }

    if (options.include_caption && options.include_context && contextBefore) {
      caption = detectCaption(contextBefore);
    } else if (options.include_caption) {
      // Get context just for caption detection
      const ctx = extractContext(content, raw.byteStart, raw.byteEnd, 200);
      caption = detectCaption(ctx.before);
    }

    // Infer column types
    const columnTypes = inferColumnTypes(raw.rows, raw.headers);

    // Create linearized representation
    const linearized = linearizeTable(
      raw.headers,
      raw.rows,
      options.linearization_strategy
    );

    const rowCount = raw.rows.length;
    const columnCount = raw.headers.length || (raw.rows[0]?.length ?? 0);

    const table: ExtractedTable = {
      table_id: tableId,
      source: {
        file_path: parsed.input_path,
        position: {
          byte_start: raw.byteStart,
          byte_end: raw.byteEnd,
          line_start: lineStart,
          line_end: lineEnd
        }
      },
      metadata: {
        caption: options.include_caption ? caption : undefined,
        context_before: options.include_context ? contextBefore : undefined,
        context_after: options.include_context ? contextAfter : undefined,
        row_count: rowCount,
        column_count: columnCount,
        has_header: raw.hasHeader
      },
      structure: {
        headers: raw.headers,
        rows: raw.rows,
        column_types: columnTypes
      },
      linearized: {
        strategy: options.linearization_strategy,
        text: linearized
      }
    };

    // Generate summary if requested
    if (options.generate_summary) {
      table.summary = generateTableSummary({
        headers: raw.headers,
        rows: raw.rows,
        metadata: table.metadata
      });
    }

    tables.push(table);
    totalRows += rowCount;
    totalCells += rowCount * columnCount;
  }

  // Create chunks
  const chunks = createChunks(tables, options.max_rows_for_chunk, options.linearization_strategy);

  // Write output to JSONL
  const normalizedDir = runManager.getNormalizedDir(parsed.run_id);
  await fs.mkdir(normalizedDir, { recursive: true });
  const outputPath = path.join(normalizedDir, 'tables.jsonl');

  const jsonlContent = tables.map(t => JSON.stringify(t)).join('\n');
  await fs.writeFile(outputPath, jsonlContent, 'utf-8');

  return {
    tables,
    chunks,
    output_path: outputPath,
    stats: {
      tables_found: tables.length,
      total_rows: totalRows,
      total_cells: totalCells
    }
  };
}
