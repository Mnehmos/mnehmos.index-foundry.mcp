/**
 * Table-Aware Processing Tests
 * 
 * These tests define the contract for table-aware processing in IndexFoundry.
 * The feature extracts and processes tables as structured data for improved RAG retrieval.
 * 
 * Feature Requirements:
 * - Detect tables in markdown, HTML, and CSV content
 * - Extract structured data (rows, columns, headers)
 * - Generate semantic representations (linearized text)
 * - Create specialized chunks for tables
 * - Preserve table context (caption, surrounding text)
 * 
 * The implementation will live in: src/tools/tables.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs/promises';
import * as path from 'path';

// Import the table processing tool (does not exist yet - tests will fail)
import { 
  extractTables, 
  ExtractTableInputSchema,
  type ExtractedTable,
  type TableChunk,
  type LinearizationStrategy
} from '../src/tools/tables.js';
import { initRunManager } from '../src/run-manager.js';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Helper to create valid extract table input
 */
function createExtractInput(
  run_id: string,
  input_path: string,
  overrides: {
    source_type?: 'markdown' | 'html' | 'csv';
    options?: {
      include_caption?: boolean;
      include_context?: boolean;
      context_chars?: number;
      generate_summary?: boolean;
      max_rows_for_chunk?: number;
      linearization_strategy?: LinearizationStrategy;
    };
  } = {}
) {
  return {
    run_id,
    input_path,
    source_type: overrides.source_type ?? 'markdown',
    ...overrides
  };
}

/**
 * Read JSONL file and parse each line as JSON
 */
async function readJsonl<T>(filePath: string): Promise<T[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  return content
    .trim()
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as T);
}

// ============================================================================
// Test Data
// ============================================================================

describe('Table-Aware Processing', () => {
  const testRunId = uuidv4();
  const runsDir = path.join(process.cwd(), '.indexfoundry', 'runs', testRunId);
  const extractedDir = path.join(runsDir, 'extracted');
  const normalizedDir = path.join(runsDir, 'normalized');
  const tablesOutputPath = path.join(normalizedDir, 'tables.jsonl');

  // Sample markdown with a table
  const sampleMarkdownWithTable = `# Sales Report

The following table shows Q4 sales figures:

| Product  | Q4 2023  | Q4 2024  | Change   |
|----------|----------|----------|----------|
| Widget A | $10,000  | $15,000  | +50%     |
| Widget B | $25,000  | $22,000  | -12%     |
| Widget C | $8,000   | $12,000  | +50%     |

Total revenue increased by 15% year-over-year.
`;

  // Markdown with multiple tables
  const multipleTablesMarkdown = `# Quarterly Report

## Q1 Results

| Metric    | Value   |
|-----------|---------|
| Revenue   | $50,000 |
| Expenses  | $30,000 |
| Profit    | $20,000 |

## Q2 Results

| Metric    | Value   |
|-----------|---------|
| Revenue   | $60,000 |
| Expenses  | $35,000 |
| Profit    | $25,000 |

Summary of both quarters above.
`;

  // Markdown table without header divider
  const noHeaderDividerMarkdown = `| Col1 | Col2 | Col3 |
| A    | B    | C    |
| D    | E    | F    |
`;

  // Markdown table with empty cells
  const emptyCellsMarkdown = `| Name  | Age | City    |
|-------|-----|---------|
| John  | 30  |         |
| Jane  |     | Seattle |
|       | 25  | Boston  |
`;

  // HTML table content
  const htmlTableContent = `<!DOCTYPE html>
<html>
<body>
<h1>Employee Directory</h1>
<table>
  <thead>
    <tr>
      <th>Name</th>
      <th>Department</th>
      <th>Email</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>John Doe</td>
      <td>Engineering</td>
      <td>john@example.com</td>
    </tr>
    <tr>
      <td>Jane Smith</td>
      <td>Marketing</td>
      <td>jane@example.com</td>
    </tr>
  </tbody>
</table>
</body>
</html>
`;

  // HTML with nested tables
  const nestedHtmlTable = `<table>
  <tr>
    <td>Outer Cell 1</td>
    <td>
      <table>
        <tr><td>Inner 1</td><td>Inner 2</td></tr>
      </table>
    </td>
  </tr>
</table>
`;

  // HTML with colspan/rowspan
  const complexHtmlTable = `<table>
  <tr>
    <th colspan="2">Header Spanning Two Columns</th>
  </tr>
  <tr>
    <td rowspan="2">Merged Rows</td>
    <td>Cell 1</td>
  </tr>
  <tr>
    <td>Cell 2</td>
  </tr>
</table>
`;

  // CSV content
  const csvContent = `Name,Age,City,Country
John,30,New York,USA
Jane,25,London,UK
Bob,35,Paris,France
`;

  // CSV with quoted values
  const csvWithQuotes = `Product,Description,Price
"Widget A","A great, amazing widget",19.99
"Widget B","Simple ""basic"" widget",9.99
`;

  // Tab-separated values
  const tsvContent = `Name\tAge\tCity
John\t30\tNew York
Jane\t25\tLondon
`;

  // Markdown with single cell table
  const singleCellTable = `| Only Cell |
|-----------|
| Value     |
`;

  // Empty table (headers only)
  const emptyTableMarkdown = `| Col1 | Col2 | Col3 |
|------|------|------|
`;

  // Wide table with many columns
  const wideTableMarkdown = `| A | B | C | D | E | F | G | H | I | J | K | L | M | N | O | P |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10| 11| 12| 13| 14| 15| 16|
`;

  // Table with Unicode content
  const unicodeTableMarkdown = `| 名前 | 年齢 | 都市 |
|------|------|------|
| 田中 | 30   | 東京 |
| 鈴木 | 25   | 大阪 |
`;

  // Large table for chunking tests
  const largeTableMarkdown = `| ID | Name | Value |
|----|------|-------|
${Array.from({ length: 50 }, (_, i) => `| ${i + 1} | Item${i + 1} | ${(i + 1) * 100} |`).join('\n')}
`;

  // Table with caption pattern
  const tableWithCaption = `Table 1: Monthly Revenue Summary

| Month | Revenue |
|-------|---------|
| Jan   | $10,000 |
| Feb   | $12,000 |
`;

  // Malformed markdown table
  const malformedTable = `| Header1 | Header2
|---------|
| Cell1   | Cell2 | Extra |
| Cell3
`;

  beforeAll(async () => {
    // Initialize the RunManager with the .indexfoundry directory
    initRunManager(path.join(process.cwd(), '.indexfoundry'));
    
    // Setup test run directory structure
    await fs.mkdir(extractedDir, { recursive: true });
    await fs.mkdir(normalizedDir, { recursive: true });
    
    // Write sample files
    await fs.writeFile(path.join(extractedDir, 'sample.md'), sampleMarkdownWithTable, 'utf-8');
    await fs.writeFile(path.join(extractedDir, 'multiple-tables.md'), multipleTablesMarkdown, 'utf-8');
    await fs.writeFile(path.join(extractedDir, 'no-header.md'), noHeaderDividerMarkdown, 'utf-8');
    await fs.writeFile(path.join(extractedDir, 'empty-cells.md'), emptyCellsMarkdown, 'utf-8');
    await fs.writeFile(path.join(extractedDir, 'table.html'), htmlTableContent, 'utf-8');
    await fs.writeFile(path.join(extractedDir, 'nested.html'), nestedHtmlTable, 'utf-8');
    await fs.writeFile(path.join(extractedDir, 'complex.html'), complexHtmlTable, 'utf-8');
    await fs.writeFile(path.join(extractedDir, 'data.csv'), csvContent, 'utf-8');
    await fs.writeFile(path.join(extractedDir, 'quoted.csv'), csvWithQuotes, 'utf-8');
    await fs.writeFile(path.join(extractedDir, 'data.tsv'), tsvContent, 'utf-8');
    await fs.writeFile(path.join(extractedDir, 'single-cell.md'), singleCellTable, 'utf-8');
    await fs.writeFile(path.join(extractedDir, 'empty.md'), emptyTableMarkdown, 'utf-8');
    await fs.writeFile(path.join(extractedDir, 'wide.md'), wideTableMarkdown, 'utf-8');
    await fs.writeFile(path.join(extractedDir, 'unicode.md'), unicodeTableMarkdown, 'utf-8');
    await fs.writeFile(path.join(extractedDir, 'large.md'), largeTableMarkdown, 'utf-8');
    await fs.writeFile(path.join(extractedDir, 'captioned.md'), tableWithCaption, 'utf-8');
    await fs.writeFile(path.join(extractedDir, 'malformed.md'), malformedTable, 'utf-8');
  });

  afterAll(async () => {
    // Cleanup test run directory
    try {
      await fs.rm(runsDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // ============================================================================
  // Schema Validation Tests
  // ============================================================================

  describe('Schema Validation', () => {
    it('should accept valid input with run_id and input_path', () => {
      const input = {
        run_id: testRunId,
        input_path: 'extracted/sample.md'
      };
      
      const result = ExtractTableInputSchema.safeParse(input);
      
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.run_id).toBe(testRunId);
        expect(result.data.input_path).toBe('extracted/sample.md');
      }
    });

    it('should reject invalid run_id format', () => {
      const input = {
        run_id: 'not-a-uuid',
        input_path: 'extracted/sample.md'
      };
      
      const result = ExtractTableInputSchema.safeParse(input);
      
      expect(result.success).toBe(false);
    });

    it('should accept valid source_type enum values', () => {
      const sourceTypes = ['markdown', 'html', 'csv'] as const;
      
      for (const source_type of sourceTypes) {
        const input = {
          run_id: testRunId,
          input_path: 'extracted/sample.md',
          source_type
        };
        
        const result = ExtractTableInputSchema.safeParse(input);
        expect(result.success).toBe(true);
      }
    });

    it('should reject invalid source_type', () => {
      const input = {
        run_id: testRunId,
        input_path: 'extracted/sample.md',
        source_type: 'xml'
      };
      
      const result = ExtractTableInputSchema.safeParse(input);
      
      expect(result.success).toBe(false);
    });

    it('should accept all linearization strategies', () => {
      const strategies = ['row_by_row', 'column_by_column', 'natural_language'] as const;
      
      for (const linearization_strategy of strategies) {
        const input = {
          run_id: testRunId,
          input_path: 'extracted/sample.md',
          options: { linearization_strategy }
        };
        
        const result = ExtractTableInputSchema.safeParse(input);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.options?.linearization_strategy).toBe(linearization_strategy);
        }
      }
    });

    it('should validate context_chars range (0-500)', () => {
      // Valid: within range
      const validInput = {
        run_id: testRunId,
        input_path: 'extracted/sample.md',
        options: { context_chars: 250 }
      };
      
      expect(ExtractTableInputSchema.safeParse(validInput).success).toBe(true);
      
      // Invalid: negative
      const negativeInput = {
        run_id: testRunId,
        input_path: 'extracted/sample.md',
        options: { context_chars: -10 }
      };
      
      expect(ExtractTableInputSchema.safeParse(negativeInput).success).toBe(false);
      
      // Invalid: too large
      const tooLargeInput = {
        run_id: testRunId,
        input_path: 'extracted/sample.md',
        options: { context_chars: 1000 }
      };
      
      expect(ExtractTableInputSchema.safeParse(tooLargeInput).success).toBe(false);
    });

    it('should validate max_rows_for_chunk range (1-100)', () => {
      // Valid: within range
      const validInput = {
        run_id: testRunId,
        input_path: 'extracted/sample.md',
        options: { max_rows_for_chunk: 20 }
      };
      
      expect(ExtractTableInputSchema.safeParse(validInput).success).toBe(true);
      
      // Invalid: zero
      const zeroInput = {
        run_id: testRunId,
        input_path: 'extracted/sample.md',
        options: { max_rows_for_chunk: 0 }
      };
      
      expect(ExtractTableInputSchema.safeParse(zeroInput).success).toBe(false);
      
      // Invalid: too large
      const tooLargeInput = {
        run_id: testRunId,
        input_path: 'extracted/sample.md',
        options: { max_rows_for_chunk: 200 }
      };
      
      expect(ExtractTableInputSchema.safeParse(tooLargeInput).success).toBe(false);
    });

    it('should default source_type to markdown', () => {
      const input = {
        run_id: testRunId,
        input_path: 'extracted/sample.md'
      };
      
      const result = ExtractTableInputSchema.safeParse(input);
      
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.source_type).toBe('markdown');
      }
    });

    it('should default options correctly', () => {
      const input = {
        run_id: testRunId,
        input_path: 'extracted/sample.md',
        options: {}
      };
      
      const result = ExtractTableInputSchema.safeParse(input);
      
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.options?.include_caption).toBe(true);
        expect(result.data.options?.include_context).toBe(true);
        expect(result.data.options?.context_chars).toBe(100);
        expect(result.data.options?.generate_summary).toBe(true);
        expect(result.data.options?.max_rows_for_chunk).toBe(20);
        expect(result.data.options?.linearization_strategy).toBe('row_by_row');
      }
    });
  });

  // ============================================================================
  // Markdown Table Detection Tests
  // ============================================================================

  describe('Markdown Table Detection', () => {
    it('should detect simple markdown table', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md',
        { source_type: 'markdown' }
      ));
      
      expect(result.tables).toBeDefined();
      expect(result.tables.length).toBe(1);
    });

    it('should find all tables in document with multiple tables', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/multiple-tables.md',
        { source_type: 'markdown' }
      ));
      
      expect(result.tables).toBeDefined();
      expect(result.tables.length).toBe(2);
    });

    it('should extract table position (byte offsets)', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md',
        { source_type: 'markdown' }
      ));
      
      expect(result.tables[0].source.position.byte_start).toBeDefined();
      expect(result.tables[0].source.position.byte_end).toBeDefined();
      expect(result.tables[0].source.position.byte_start).toBeLessThan(result.tables[0].source.position.byte_end);
    });

    it('should extract table line numbers', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md',
        { source_type: 'markdown' }
      ));
      
      expect(result.tables[0].source.position.line_start).toBeDefined();
      expect(result.tables[0].source.position.line_end).toBeDefined();
      expect(result.tables[0].source.position.line_start).toBeLessThan(result.tables[0].source.position.line_end!);
    });

    it('should handle table without header divider', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/no-header.md',
        { source_type: 'markdown' }
      ));
      
      expect(result.tables).toBeDefined();
      expect(result.tables.length).toBeGreaterThanOrEqual(1);
      // Should still extract the data even without standard divider
      expect(result.tables[0].structure.rows.length).toBeGreaterThan(0);
    });

    it('should handle cells with no content', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/empty-cells.md',
        { source_type: 'markdown' }
      ));
      
      expect(result.tables).toBeDefined();
      expect(result.tables.length).toBe(1);
      
      // Verify empty cells are preserved
      const rows = result.tables[0].structure.rows;
      const hasEmptyCell = rows.some(row => row.some(cell => cell === '' || cell.trim() === ''));
      expect(hasEmptyCell).toBe(true);
    });

    it('should generate unique table_id for each table', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/multiple-tables.md',
        { source_type: 'markdown' }
      ));
      
      const tableIds = result.tables.map(t => t.table_id);
      const uniqueIds = new Set(tableIds);
      
      expect(uniqueIds.size).toBe(tableIds.length);
    });
  });

  // ============================================================================
  // HTML Table Detection Tests
  // ============================================================================

  describe('HTML Table Detection', () => {
    it('should detect basic HTML table structure', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/table.html',
        { source_type: 'html' }
      ));
      
      expect(result.tables).toBeDefined();
      expect(result.tables.length).toBe(1);
    });

    it('should extract th elements as headers', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/table.html',
        { source_type: 'html' }
      ));
      
      expect(result.tables[0].structure.headers).toEqual(['Name', 'Department', 'Email']);
      expect(result.tables[0].metadata.has_header).toBe(true);
    });

    it('should handle nested tables', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/nested.html',
        { source_type: 'html' }
      ));
      
      // Should detect both outer and inner tables, or flatten appropriately
      expect(result.tables).toBeDefined();
      expect(result.tables.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle colspan and rowspan (flatten or mark unsupported)', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/complex.html',
        { source_type: 'html' }
      ));
      
      expect(result.tables).toBeDefined();
      // Should either flatten the structure or include a warning/flag
      expect(result.tables[0]).toBeDefined();
    });
  });

  // ============================================================================
  // CSV Processing Tests
  // ============================================================================

  describe('CSV Processing', () => {
    it('should parse standard CSV with comma delimiter', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/data.csv',
        { source_type: 'csv' }
      ));
      
      expect(result.tables).toBeDefined();
      expect(result.tables.length).toBe(1);
      expect(result.tables[0].structure.headers).toEqual(['Name', 'Age', 'City', 'Country']);
    });

    it('should handle quoted values with commas', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/quoted.csv',
        { source_type: 'csv' }
      ));
      
      expect(result.tables).toBeDefined();
      expect(result.tables[0].structure.rows[0][1]).toContain('great, amazing');
    });

    it('should handle escaped quotes in CSV', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/quoted.csv',
        { source_type: 'csv' }
      ));
      
      // Should properly unescape double quotes
      expect(result.tables[0].structure.rows[1][1]).toContain('basic');
    });

    it('should detect first row as header', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/data.csv',
        { source_type: 'csv' }
      ));
      
      expect(result.tables[0].metadata.has_header).toBe(true);
      expect(result.tables[0].structure.headers.length).toBeGreaterThan(0);
      expect(result.tables[0].structure.rows.length).toBe(3); // Data rows, not including header
    });
  });

  // ============================================================================
  // Table Structure Extraction Tests
  // ============================================================================

  describe('Table Structure Extraction', () => {
    it('should extract headers correctly', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md',
        { source_type: 'markdown' }
      ));
      
      expect(result.tables[0].structure.headers).toEqual(['Product', 'Q4 2023', 'Q4 2024', 'Change']);
    });

    it('should extract all data rows', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md',
        { source_type: 'markdown' }
      ));
      
      expect(result.tables[0].structure.rows.length).toBe(3);
      expect(result.tables[0].structure.rows[0]).toEqual(['Widget A', '$10,000', '$15,000', '+50%']);
    });

    it('should preserve cell content exactly', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md',
        { source_type: 'markdown' }
      ));
      
      expect(result.tables[0].structure.rows[1][1]).toBe('$25,000');
      expect(result.tables[0].structure.rows[2][3]).toBe('+50%');
    });

    it('should calculate row_count correctly', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md',
        { source_type: 'markdown' }
      ));
      
      expect(result.tables[0].metadata.row_count).toBe(3);
    });

    it('should calculate column_count correctly', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md',
        { source_type: 'markdown' }
      ));
      
      expect(result.tables[0].metadata.column_count).toBe(4);
    });

    it('should infer column_types correctly', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md',
        { source_type: 'markdown' }
      ));
      
      expect(result.tables[0].structure.column_types).toBeDefined();
      expect(result.tables[0].structure.column_types![0]).toBe('string'); // Product
      // Money values might be 'currency' or 'string'
      expect(['string', 'currency', 'number']).toContain(result.tables[0].structure.column_types![1]);
    });

    it('should set has_header flag correctly', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md',
        { source_type: 'markdown' }
      ));
      
      expect(result.tables[0].metadata.has_header).toBe(true);
    });
  });

  // ============================================================================
  // Linearization Strategy Tests
  // ============================================================================

  describe('Linearization Strategies', () => {
    it('should linearize row-by-row correctly', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md',
        { options: { linearization_strategy: 'row_by_row' } }
      ));
      
      expect(result.tables[0].linearized.strategy).toBe('row_by_row');
      expect(result.tables[0].linearized.text).toContain('Product=Widget A');
      expect(result.tables[0].linearized.text).toContain('Q4 2023=$10,000');
    });

    it('should include row separators in row-by-row linearization', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md',
        { options: { linearization_strategy: 'row_by_row' } }
      ));
      
      // Should have separators between rows (e.g., semicolons, periods, or newlines)
      expect(result.tables[0].linearized.text).toMatch(/Row \d:|;|\n/);
    });

    it('should linearize column-by-column correctly', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md',
        { options: { linearization_strategy: 'column_by_column' } }
      ));
      
      expect(result.tables[0].linearized.strategy).toBe('column_by_column');
      expect(result.tables[0].linearized.text).toContain("Column 'Product':");
      expect(result.tables[0].linearized.text).toContain('Widget A');
      expect(result.tables[0].linearized.text).toContain('Widget B');
      expect(result.tables[0].linearized.text).toContain('Widget C');
    });

    it('should linearize with natural language strategy', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md',
        { options: { linearization_strategy: 'natural_language' } }
      ));
      
      expect(result.tables[0].linearized.strategy).toBe('natural_language');
      // Should produce readable prose describing the table
      expect(result.tables[0].linearized.text.length).toBeGreaterThan(50);
    });

    it('should default to row_by_row linearization', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md'
      ));
      
      expect(result.tables[0].linearized.strategy).toBe('row_by_row');
    });

    it('should produce non-empty linearized text', async () => {
      const strategies = ['row_by_row', 'column_by_column', 'natural_language'] as const;
      
      for (const strategy of strategies) {
        const result = await extractTables(createExtractInput(
          testRunId,
          'extracted/sample.md',
          { options: { linearization_strategy: strategy } }
        ));
        
        expect(result.tables[0].linearized.text.length).toBeGreaterThan(0);
      }
    });
  });

  // ============================================================================
  // Context Extraction Tests
  // ============================================================================

  describe('Context Extraction', () => {
    it('should include context before table when include_context is true', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md',
        { options: { include_context: true, context_chars: 100 } }
      ));
      
      expect(result.tables[0].metadata.context_before).toBeDefined();
      expect(result.tables[0].metadata.context_before).toContain('Q4 sales figures');
    });

    it('should include context after table', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md',
        { options: { include_context: true, context_chars: 100 } }
      ));
      
      expect(result.tables[0].metadata.context_after).toBeDefined();
      expect(result.tables[0].metadata.context_after).toContain('revenue increased');
    });

    it('should respect context_chars limit', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md',
        { options: { include_context: true, context_chars: 50 } }
      ));
      
      if (result.tables[0].metadata.context_before) {
        expect(result.tables[0].metadata.context_before.length).toBeLessThanOrEqual(50);
      }
      if (result.tables[0].metadata.context_after) {
        expect(result.tables[0].metadata.context_after.length).toBeLessThanOrEqual(50);
      }
    });

    it('should not include context when include_context is false', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md',
        { options: { include_context: false } }
      ));
      
      expect(result.tables[0].metadata.context_before).toBeUndefined();
      expect(result.tables[0].metadata.context_after).toBeUndefined();
    });

    it('should detect table caption patterns', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/captioned.md',
        { options: { include_caption: true } }
      ));
      
      expect(result.tables[0].metadata.caption).toBeDefined();
      expect(result.tables[0].metadata.caption).toContain('Table 1');
      expect(result.tables[0].metadata.caption).toContain('Monthly Revenue');
    });

    it('should not extract caption when include_caption is false', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/captioned.md',
        { options: { include_caption: false } }
      ));
      
      expect(result.tables[0].metadata.caption).toBeUndefined();
    });
  });

  // ============================================================================
  // Chunking Tests
  // ============================================================================

  describe('Table Chunking', () => {
    it('should create single chunk for small table', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md',
        { options: { max_rows_for_chunk: 20 } }
      ));
      
      expect(result.chunks).toBeDefined();
      expect(result.chunks!.length).toBe(1);
    });

    it('should split large table by max_rows_for_chunk', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/large.md',
        { options: { max_rows_for_chunk: 10 } }
      ));
      
      expect(result.chunks).toBeDefined();
      // 50 rows / 10 per chunk = 5 chunks
      expect(result.chunks!.length).toBeGreaterThanOrEqual(5);
    });

    it('should include headers in each chunk', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/large.md',
        { options: { max_rows_for_chunk: 10 } }
      ));
      
      for (const chunk of result.chunks!) {
        // Each chunk should reference the table and contain linearized content with headers
        expect(chunk.table_data?.linearized_content).toBeDefined();
      }
    });

    it('should set table_data.table_id in chunks', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md'
      ));
      
      expect(result.chunks![0].table_data?.table_id).toBe(result.tables[0].table_id);
    });

    it('should set row_range in chunked tables', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/large.md',
        { options: { max_rows_for_chunk: 10 } }
      ));
      
      expect(result.chunks![0].table_data?.row_range).toBeDefined();
      expect(result.chunks![0].table_data?.row_range?.start).toBe(0);
      expect(result.chunks![0].table_data?.row_range?.end).toBe(9);
      
      expect(result.chunks![1].table_data?.row_range?.start).toBe(10);
    });

    it('should set is_header_chunk flag appropriately', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md'
      ));
      
      // First/only chunk for a table should be header chunk
      expect(result.chunks![0].table_data?.is_header_chunk).toBe(true);
    });

    it('should include linearized_content in each chunk', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/large.md',
        { options: { max_rows_for_chunk: 10 } }
      ));
      
      for (const chunk of result.chunks!) {
        expect(chunk.table_data?.linearized_content).toBeDefined();
        expect(chunk.table_data?.linearized_content.length).toBeGreaterThan(0);
      }
    });
  });

  // ============================================================================
  // Summary Generation Tests
  // ============================================================================

  describe('Summary Generation', () => {
    it('should generate summary when generate_summary is true', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md',
        { options: { generate_summary: true } }
      ));
      
      expect(result.tables[0].summary).toBeDefined();
      expect(typeof result.tables[0].summary).toBe('string');
      expect(result.tables[0].summary!.length).toBeGreaterThan(0);
    });

    it('should not generate summary when generate_summary is false', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md',
        { options: { generate_summary: false } }
      ));
      
      expect(result.tables[0].summary).toBeUndefined();
    });

    it('should include table dimensions in summary', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md',
        { options: { generate_summary: true } }
      ));
      
      // Summary should mention rows and columns or similar dimensional info
      expect(result.tables[0].summary).toMatch(/row|column|3|4/i);
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('Edge Cases', () => {
    it('should handle empty table (no data rows)', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/empty.md',
        { source_type: 'markdown' }
      ));
      
      expect(result.tables).toBeDefined();
      expect(result.tables[0].metadata.row_count).toBe(0);
      expect(result.tables[0].structure.rows.length).toBe(0);
    });

    it('should handle single cell table (1x1)', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/single-cell.md',
        { source_type: 'markdown' }
      ));
      
      expect(result.tables).toBeDefined();
      expect(result.tables[0].metadata.row_count).toBe(1);
      expect(result.tables[0].metadata.column_count).toBe(1);
    });

    it('should handle very wide table (many columns)', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/wide.md',
        { source_type: 'markdown' }
      ));
      
      expect(result.tables).toBeDefined();
      expect(result.tables[0].metadata.column_count).toBe(16);
    });

    it('should handle Unicode content in cells', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/unicode.md',
        { source_type: 'markdown' }
      ));
      
      expect(result.tables).toBeDefined();
      expect(result.tables[0].structure.headers[0]).toBe('名前');
      expect(result.tables[0].structure.rows[0][0]).toBe('田中');
    });

    it('should handle malformed markdown table gracefully', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/malformed.md',
        { source_type: 'markdown' }
      ));
      
      // Should not throw, may return empty or partial results
      expect(result).toBeDefined();
    });

    it('should handle file not found with error', async () => {
      await expect(extractTables(createExtractInput(
        testRunId,
        'extracted/nonexistent.md',
        { source_type: 'markdown' }
      ))).rejects.toThrow();
    });

    it('should generate deterministic table_id (SHA256)', async () => {
      // Run extraction twice on the same file
      const result1 = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md'
      ));
      
      const result2 = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md'
      ));
      
      // Same content should produce same table_id
      expect(result1.tables[0].table_id).toBe(result2.tables[0].table_id);
    });
  });

  // ============================================================================
  // Output Structure Tests
  // ============================================================================

  describe('Output Structure', () => {
    it('should return tables array in result', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md'
      ));
      
      expect(Array.isArray(result.tables)).toBe(true);
    });

    it('should return chunks array when chunking enabled', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md'
      ));
      
      expect(Array.isArray(result.chunks)).toBe(true);
    });

    it('should include source file_path in table metadata', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md'
      ));
      
      expect(result.tables[0].source.file_path).toContain('sample.md');
    });

    it('should include stats in result', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/multiple-tables.md'
      ));
      
      expect(result.stats).toBeDefined();
      expect(result.stats.tables_found).toBe(2);
      expect(result.stats.total_rows).toBeDefined();
      expect(result.stats.total_cells).toBeDefined();
    });

    it('should conform to ExtractedTable interface', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md'
      ));
      
      const table: ExtractedTable = result.tables[0];
      
      // Verify all required fields
      expect(typeof table.table_id).toBe('string');
      expect(table.source).toBeDefined();
      expect(table.source.file_path).toBeDefined();
      expect(table.source.position).toBeDefined();
      expect(table.metadata).toBeDefined();
      expect(typeof table.metadata.row_count).toBe('number');
      expect(typeof table.metadata.column_count).toBe('number');
      expect(typeof table.metadata.has_header).toBe('boolean');
      expect(table.structure).toBeDefined();
      expect(Array.isArray(table.structure.headers)).toBe(true);
      expect(Array.isArray(table.structure.rows)).toBe(true);
      expect(table.linearized).toBeDefined();
      expect(typeof table.linearized.strategy).toBe('string');
      expect(typeof table.linearized.text).toBe('string');
    });
  });

  // ============================================================================
  // Integration Tests
  // ============================================================================

  describe('Full Pipeline Integration', () => {
    it('should produce valid JSONL output', async () => {
      const result = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md'
      ));
      
      expect(result.output_path).toBeDefined();
      
      // Verify file exists and is valid JSONL
      const tables = await readJsonl<ExtractedTable>(result.output_path);
      expect(tables.length).toBeGreaterThan(0);
    });

    it('should process all source types consistently', async () => {
      const mdResult = await extractTables(createExtractInput(
        testRunId,
        'extracted/sample.md',
        { source_type: 'markdown' }
      ));
      
      const htmlResult = await extractTables(createExtractInput(
        testRunId,
        'extracted/table.html',
        { source_type: 'html' }
      ));
      
      const csvResult = await extractTables(createExtractInput(
        testRunId,
        'extracted/data.csv',
        { source_type: 'csv' }
      ));
      
      // All should return same structure
      expect(mdResult.tables[0].structure.headers).toBeDefined();
      expect(htmlResult.tables[0].structure.headers).toBeDefined();
      expect(csvResult.tables[0].structure.headers).toBeDefined();
    });
  });
});
