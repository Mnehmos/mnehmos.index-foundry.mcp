# TDD Task Map: Unified Binary Handler (Option C)

## Overview

**Bug**: URL sources pointing to PDF files store raw binary data instead of extracted text.

**Root Cause**: In [`fetchSource()`](../src/tools/projects.ts:963), the URL handler:
1. Calls `response.text()` for ALL URLs (line 973)
2. Only handles `text/html` content-type (line 981)
3. Falls through to push raw binary content for non-HTML (lines 1008-1009)

**Fix**: Create a unified `extractTextFromResponse()` helper that routes to the correct extractor based on content-type and URL extension.

---

## Interface Design

### `extractTextFromResponse()` Signature

```typescript
interface ExtractTextOptions {
  url: string;
  response: Response;
  maxSizeBytes?: number;
}

interface ExtractTextResult {
  text: string;
  contentType: string;
  extractorUsed: 'html' | 'pdf' | 'plain' | 'jina';
}

async function extractTextFromResponse(
  options: ExtractTextOptions
): Promise<ExtractTextResult>
```

### Content-Type Detection Logic

| Content-Type Header | URL Extension | Action |
|---------------------|---------------|--------|
| `application/pdf` | any | PDF extractor |
| `text/html` | any | HTML extractor (with Jina fallback) |
| `text/plain` | any | Return as-is |
| missing/unknown | `.pdf` | PDF extractor |
| missing/unknown | `.txt` | Return as-is |
| missing/unknown | other | Attempt HTML, fallback to error |
| `application/octet-stream` | `.pdf` | PDF extractor |
| other binary | any | Throw meaningful error |

---

## Task Map

### Phase 0: Setup & Scaffolding

| Task ID | Objective | Mode | Dependencies | Acceptance Criteria |
|---------|-----------|------|--------------|---------------------|
| `UBH-000` | Create test file `tests/binary-handler.test.ts` with imports and describe blocks | code | none | File exists with vitest imports, describe blocks for each extractor type |
| `UBH-001` | Add mock Response factory for tests | code | UBH-000 | Helper function `createMockResponse()` can create Response objects with configurable content-type, body, and status |

---

### Phase 1: Red Phase - Write Failing Tests

All tests MUST fail initially with clear, meaningful error messages.

#### 1.1 Content-Type Detection Tests

| Task ID | Objective | Mode | Dependencies | Acceptance Criteria |
|---------|-----------|------|--------------|---------------------|
| `UBH-100` | Test: PDF content-type returns extracted text | red-phase | UBH-001 | Test fails because `extractTextFromResponse` doesn't exist; test expects `extractorUsed: 'pdf'` |
| `UBH-101` | Test: HTML content-type returns extracted text | red-phase | UBH-001 | Test fails; expects `extractorUsed: 'html'` |
| `UBH-102` | Test: Plain text content-type returns text as-is | red-phase | UBH-001 | Test fails; expects `extractorUsed: 'plain'` |
| `UBH-103` | Test: Unknown binary content-type throws descriptive error | red-phase | UBH-001 | Test fails; expects error with message containing content-type and URL |

#### 1.2 URL Extension Fallback Tests

| Task ID | Objective | Mode | Dependencies | Acceptance Criteria |
|---------|-----------|------|--------------|---------------------|
| `UBH-110` | Test: Missing content-type with `.pdf` extension → PDF extractor | red-phase | UBH-001 | Test fails; expects PDF extraction when URL ends in `.pdf` |
| `UBH-111` | Test: Missing content-type with `.txt` extension → plain text | red-phase | UBH-001 | Test fails; expects plain text pass-through |
| `UBH-112` | Test: `application/octet-stream` with `.pdf` extension → PDF extractor | red-phase | UBH-001 | Test fails; expects PDF extraction to be attempted |

#### 1.3 PDF Extraction Tests

| Task ID | Objective | Mode | Dependencies | Acceptance Criteria |
|---------|-----------|------|--------------|---------------------|
| `UBH-120` | Test: Valid PDF buffer extracts text correctly | red-phase | UBH-001 | Test fails; expects extracted text to contain known PDF content |
| `UBH-121` | Test: Corrupted PDF throws meaningful error | red-phase | UBH-001 | Test fails; expects error message mentioning PDF extraction failure |
| `UBH-122` | Test: Scanned/image-only PDF throws "insufficient text" error | red-phase | UBH-001 | Test fails; expects error about insufficient extractable text |

#### 1.4 HTML Extraction Tests

| Task ID | Objective | Mode | Dependencies | Acceptance Criteria |
|---------|-----------|------|--------------|---------------------|
| `UBH-130` | Test: HTML with rich content extracts text | red-phase | UBH-001 | Test fails; expects extracted text without HTML tags |
| `UBH-131` | Test: JS-rendered shell HTML triggers Jina fallback | red-phase | UBH-001 | Test fails; expects `extractorUsed: 'jina'` when shell detected |
| `UBH-132` | Test: HTML with insufficient content uses Jina fallback | red-phase | UBH-001 | Test fails; expects Jina fallback for < 200 chars extracted |

#### 1.5 Error Handling Tests

| Task ID | Objective | Mode | Dependencies | Acceptance Criteria |
|---------|-----------|------|--------------|---------------------|
| `UBH-140` | Test: Content exceeding size limit throws error | red-phase | UBH-001 | Test fails; expects error about size limit |
| `UBH-141` | Test: Error messages include URL and content-type | red-phase | UBH-001 | Test fails; expects descriptive errors with context |

---

### Phase 2: Green Phase - Implementation

Write minimal code to make each test pass. No premature optimization.

#### 2.1 Core Function Structure

| Task ID | Objective | Mode | Dependencies | Acceptance Criteria |
|---------|-----------|------|--------------|---------------------|
| `UBH-200` | Implement `extractTextFromResponse()` function skeleton | green-phase | UBH-100..UBH-103 | Function exists, throws "not implemented" for all cases |
| `UBH-201` | Implement content-type detection and routing | green-phase | UBH-200 | Content-type parsing works; routes to correct extractor stub |
| `UBH-202` | Implement URL extension fallback detection | green-phase | UBH-201, UBH-110..UBH-112 | Falls back to extension when content-type missing/ambiguous |

#### 2.2 Extractors

| Task ID | Objective | Mode | Dependencies | Acceptance Criteria |
|---------|-----------|------|--------------|---------------------|
| `UBH-210` | Implement PDF extractor (reuse existing `pdfParse` logic) | green-phase | UBH-120..UBH-122 | PDF tests pass; extracts text from valid PDFs |
| `UBH-211` | Implement HTML extractor (reuse existing `extractTextFromHtml`) | green-phase | UBH-130 | HTML tests pass; strips tags, preserves structure |
| `UBH-212` | Implement plain text extractor | green-phase | UBH-102, UBH-111 | Plain text tests pass; returns content as-is |
| `UBH-213` | Implement Jina fallback integration | green-phase | UBH-131, UBH-132 | Jina fallback tests pass; shell detection works |

#### 2.3 Error Handling

| Task ID | Objective | Mode | Dependencies | Acceptance Criteria |
|---------|-----------|------|--------------|---------------------|
| `UBH-220` | Implement size limit validation | green-phase | UBH-140 | Size limit test passes; early rejection of large content |
| `UBH-221` | Implement descriptive error messages | green-phase | UBH-141, UBH-103 | Error tests pass; messages include URL and content-type |

---

### Phase 3: Blue Phase - Refactor & Integration

Improve code quality while maintaining passing tests.

#### 3.1 Code Quality

| Task ID | Objective | Mode | Dependencies | Acceptance Criteria |
|---------|-----------|------|--------------|---------------------|
| `UBH-300` | Extract extractor functions to separate helpers | blue-phase | UBH-210..UBH-213 | Clean separation of concerns; all tests still pass |
| `UBH-301` | Add JSDoc documentation to public functions | blue-phase | UBH-300 | All exported functions have JSDoc with examples |
| `UBH-302` | Add TypeScript types for all parameters/returns | blue-phase | UBH-300 | No `any` types; full type safety |

#### 3.2 Integration with `fetchSource()`

| Task ID | Objective | Mode | Dependencies | Acceptance Criteria |
|---------|-----------|------|--------------|---------------------|
| `UBH-310` | Replace URL case in `fetchSource()` with `extractTextFromResponse()` | blue-phase | UBH-300 | URL handling uses new helper; existing tests pass |
| `UBH-311` | Remove duplicated PDF/HTML logic from `fetchSource()` | blue-phase | UBH-310 | No duplicate extraction logic; DRY principle |
| `UBH-312` | Update sitemap handler to use `extractTextFromResponse()` | blue-phase | UBH-310 | Sitemap URL fetching uses unified handler |

#### 3.3 Performance & Polish

| Task ID | Objective | Mode | Dependencies | Acceptance Criteria |
|---------|-----------|------|--------------|---------------------|
| `UBH-320` | Add logging for extractor selection | blue-phase | UBH-310 | Debug logs show which extractor was used |
| `UBH-321` | Ensure streaming-friendly for large responses | blue-phase | UBH-320 | Memory efficient; no full buffer for content-type check |

---

### Phase 4: Data Cleanup & Validation

| Task ID | Objective | Mode | Dependencies | Acceptance Criteria |
|---------|-----------|------|--------------|---------------------|
| `UBH-400` | Create script to identify corrupted PDF chunks | code | UBH-310 | Script lists source_ids with binary content markers |
| `UBH-401` | Create data migration tool to purge bad chunks | code | UBH-400 | Tool removes chunks/vectors for specified sources |
| `UBH-402` | Document rebuild procedure for affected projects | architect | UBH-401 | README updated with recovery instructions |
| `UBH-403` | Rebuild affected project data (dnd-reference) | orchestrator | UBH-401, UBH-402 | Project rebuilt with correct PDF extraction |

---

## Dependency Graph

```
Phase 0 (Setup)
    │
    ├── UBH-000 ──► UBH-001
    │                  │
    │                  ▼
Phase 1 (Red)          │
    │   ┌──────────────┴───────────────┐
    │   │                              │
    │   ▼                              ▼
    │ Content-Type Tests          Extension Fallback Tests
    │ UBH-100..103                 UBH-110..112
    │   │                              │
    │   │   ┌──────────────────────────┤
    │   │   │                          │
    │   ▼   ▼                          ▼
    │ PDF Tests                    HTML Tests
    │ UBH-120..122                 UBH-130..132
    │   │                              │
    │   └──────────────┬───────────────┘
    │                  │
    │                  ▼
    │          Error Tests UBH-140..141
    │                  │
    │                  ▼
Phase 2 (Green)        │
    │   ┌──────────────┴───────────────┐
    │   │                              │
    │   ▼                              │
    │ UBH-200 (skeleton)               │
    │   │                              │
    │   ▼                              │
    │ UBH-201 (content-type routing)   │
    │   │                              │
    │   ▼                              │
    │ UBH-202 (extension fallback)     │
    │   │                              │
    │   ├──────────────┬───────────────┤
    │   │              │               │
    │   ▼              ▼               ▼
    │ UBH-210        UBH-211        UBH-212
    │ (PDF)          (HTML)         (plain)
    │   │              │               │
    │   │              ▼               │
    │   │           UBH-213            │
    │   │           (Jina)             │
    │   │              │               │
    │   └──────────────┼───────────────┘
    │                  │
    │                  ▼
    │          UBH-220, UBH-221
    │          (error handling)
    │                  │
    │                  ▼
Phase 3 (Blue)         │
    │   ┌──────────────┴───────────────┐
    │   │                              │
    │   ▼                              ▼
    │ UBH-300 (extract helpers)    UBH-301 (docs)
    │   │                              │
    │   ▼                              ▼
    │ UBH-302 (types)                  │
    │   │                              │
    │   ▼                              │
    │ UBH-310 (integrate URL)          │
    │   │                              │
    │   ├───────────────►──────────────┘
    │   │
    │   ▼
    │ UBH-311 (remove duplication)
    │   │
    │   ▼
    │ UBH-312 (sitemap integration)
    │   │
    │   ▼
    │ UBH-320, UBH-321 (polish)
    │   │
    │   ▼
Phase 4 (Cleanup)      │
    │   ┌──────────────┴───────────────┐
    │   │                              │
    │   ▼                              ▼
    │ UBH-400 (identify bad data)  UBH-402 (docs)
    │   │                              │
    │   ▼                              │
    │ UBH-401 (purge tool)             │
    │   │                              │
    │   └──────────────┬───────────────┘
    │                  │
    │                  ▼
    │             UBH-403
    │         (rebuild project)
```

---

## Effort Estimates

| Phase | Tasks | Estimated Effort |
|-------|-------|------------------|
| Phase 0: Setup | 2 | 30 minutes |
| Phase 1: Red | 14 | 2 hours |
| Phase 2: Green | 10 | 3 hours |
| Phase 3: Blue | 8 | 2 hours |
| Phase 4: Cleanup | 4 | 1 hour |
| **Total** | **38** | **~8.5 hours** |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Jina Reader API rate limits | Add exponential backoff; cache results |
| Large PDFs causing OOM | Implement streaming; enforce size limits |
| Edge cases in content-type parsing | Add charset handling; normalize variations |
| Existing data format changes | Run migration script in dry-run first |

---

## Success Criteria

1. **All 14+ tests pass** after Green Phase
2. **No regressions** in existing `fetchSource()` behavior
3. **PDF URLs correctly extract text** (verified with real URL)
4. **Error messages are actionable** for debugging
5. **Corrupted project data is cleaned** and rebuilt

---

## Files Affected

| File | Changes |
|------|---------|
| `tests/binary-handler.test.ts` | New test file |
| `src/tools/projects.ts` | Refactored `fetchSource()`, new helpers |
| `src/utils.ts` | Possible helper additions |
| `projects/dnd-reference/data/*` | Rebuilt after cleanup |

---

*Generated by Planner Mode • IndexFoundry TDD Workflow*
