# Modes Decision Summary: The Librarian Protocol

**Date:** 2025-01-07  
**Status:** ✅ DECISION MADE  
**Outcome:** Librarian Protocol added to IndexFoundry (not a separate mode)

---

## Executive Summary

**The Librarian** is not a new mode. It is an **operational workflow protocol** that sits on top of IndexFoundry's existing tools.

### Decision Matrix

| Aspect | Outcome | Rationale |
|--------|---------|-----------|
| **Is it a new mode?** | ❌ NO | Uses 95%+ existing IndexFoundry tools |
| **Does it need new tools?** | ❌ NO | All necessary tools already exist |
| **Does it need new code?** | ✅ YES (optional) | Utility functions for orchestrators |
| **Is it documented?** | ✅ YES (complete) | 3 comprehensive documents created |
| **Is it compatible?** | ✅ YES (100%) | Works with all IndexFoundry projects |
| **Will it replace Index Foundry?** | ❌ NO | Augments, never replaces |

---

## What We Created

### 1. MODE-COMPARISON-ANALYSIS.md

**Purpose:** Decision rationale document

**Content:**
- Comparison of IndexFoundry vs. Librarian
- Why Librarian is not a separate mode
- Integration path (Phase 1-3)
- Contract between Librarian and IndexFoundry tools
- Consequences matrix (positive/negative/risks)

**Key Finding:** Librarian is a **workflow orchestration pattern**, not a tool library.

---

### 2. ADR-007-LIBRARIAN-PROTOCOL.md

**Purpose:** Full technical specification

**Sections:**
- **Context:** Why Librarian is needed (IndexFoundry gaps)
- **Decision:** Protocol design with "Reason Over State" principle
- **Architecture:** Detailed state-check loop with ASCII diagrams
- **Protocols:** Query handling, deployment workflow, error handling
- **Thresholds:** Score cutoffs, retry strategies, timeouts
- **Implementation Guidance:** For orchestrators and MCP clients
- **Consequences:** Positive (reliability, safety), Negative (latency, overhead)

**Key Innovation:** The "Reason Over State" loop that validates index state before every query/deployment.

---

### 3. LIBRARIAN-EXAMPLES.md

**Purpose:** Practical implementation examples

**Examples:**
1. **Query with Full Audit Trail** - Step-by-step workflow with state checking, classification, retrieval, validation
2. **Retrieval Debugging & Re-Chunking** - Auto-recovery from poor retrieval scores
3. **Deployment Pre-Flight Check** - Complete validation before exporting/serving
4. **Batch Source Management with Repair** - Bulk operations with error handling
5. **Query Classification to Skip RAG** - Optimize by avoiding unnecessary retrieval

**Code Level:** Includes working TypeScript implementations with sample outputs.

---

### 4. Updated PROJECT_KNOWLEDGE.md

**Addition:** New "Operational Protocols" section

**Content:**
- Librarian overview (not a new mode)
- Key principles and workflow diagram
- Core protocols table
- Example query code
- When to use Librarian patterns
- Links to detailed docs

---

## How Librarian Works

### The "Reason Over State" Loop

```
┌─────────────────────────────────────┐
│  Step 1: MANIFEST AUDIT             │ ← Check project.json, sources, chunks, vectors
├─────────────────────────────────────┤
│  Step 2: QUERY CLASSIFICATION       │ ← Determine if RAG is needed
├─────────────────────────────────────┤
│  Step 3: RETRIEVE                   │ ← Execute search (if needed)
├─────────────────────────────────────┤
│  Step 4: VALIDATE QUALITY           │ ← Check similarity scores
├─────────────────────────────────────┤
│  Step 5: REPAIR (if needed)         │ ← Re-chunk, rebuild, retry
├─────────────────────────────────────┤
│  Step 6: RETURN ANSWER              │ ← With audit trail & metadata
└─────────────────────────────────────┘
```

### Tools Used (All Existing)

| Tool | Phase | Usage |
|------|-------|-------|
| `indexfoundry_project_get` | 1 | Load project manifest |
| `indexfoundry_classify_query` | 2 | Intent detection |
| `indexfoundry_project_query` | 3 | Semantic/keyword/hybrid search |
| `indexfoundry_debug_query` | 4 | Analyze poor scores |
| `indexfoundry_project_remove_source` | 5 | Clean up sources |
| `indexfoundry_project_build` | 5 | Re-index |
| `indexfoundry_project_export` | Deploy | Generate files |
| `indexfoundry_project_serve` | Deploy | Start server |

**No new tools required.**

---

## Comparison: Before vs. After

### Before (IndexFoundry Only)

```typescript
// Raw tool usage - no validation
const results = await indexfoundry_project_query({
  project_id: "my-docs",
  query: "What's the vacation policy?",
  mode: "hybrid"
});

// User gets results, trusts they're correct
// Problem: Index might be stale, scores might be low, data might be incomplete
```

### After (With Librarian Protocol)

```typescript
// Step 1: Audit manifest
const project = await indexfoundry_project_get({ project_id });
if (!isValidState(project)) {
  await indexfoundry_project_build({ project_id }); // Repair
}

// Step 2: Classify query
const classification = await indexfoundry_classify_query({ query });
if (!classification.needs_retrieval) {
  return directAnswer(); // Skip expensive retrieval
}

// Step 3: Retrieve
const results = await indexfoundry_project_query({
  project_id, query, mode: classification.suggested_mode
});

// Step 4: Validate scores
const avgScore = avg(results.map(r => r.score));
if (avgScore < 0.65) {
  const debug = await indexfoundry_debug_query({ query });
  // Consider re-chunking
}

// Step 5: Return with audit trail
return {
  answer: results[0].text,
  audit: {
    stateValid: true,
    classification: classification.type,
    avgScore,
    sources: results.map(r => r.source_id)
  }
};
```

**Benefit:** User gets validated, self-correcting results with full transparency.

---

## Integration Guide

### For Orchestrator Agents (Claude, etc.)

**Implement the Librarian Loop:**

1. Before querying: Audit manifest
2. Classify query intent
3. Retrieve (if needed)
4. Validate scores
5. Return with metadata

See [`LIBRARIAN-EXAMPLES.md`](./LIBRARIAN-EXAMPLES.md#example-1-query-with-full-audit-trail) for implementation.

### For MCP Client Developers

**Add UI Support:**

- ✅ Show "Index last checked: [timestamp]"
- ✅ Display query classification ("factual", "procedural", etc.)
- ✅ Show similarity scores with color coding
- ✅ Notify user if repair is needed
- ✅ Display audit trail in chat

### For Power Users

**Use IndexFoundry directly** (Librarian is optional):

```typescript
// IndexFoundry direct usage (no Librarian overhead)
const results = await indexfoundry_project_query({
  project_id, query, mode: "hybrid", top_k: 5
});
```

**Librarian patterns are additive, not mandatory.**

---

## Key Metrics

### Thresholds

| Metric | Threshold | Purpose |
|--------|-----------|---------|
| Min chunk score | 0.50 | Relevance cutoff |
| Avg result score | 0.65 | Quality gate |
| Classification confidence | 0.50 | Intent reliability |
| Query timeout | 30s | Standard MCP timeout |
| State audit | 5-10s | Quick check |

### Overhead

| Operation | Latency | Mitigation |
|-----------|---------|-----------|
| State audit | +5-10s | Cache for 1 hour |
| Classification | +10-15s | Use keyword matching for obvious cases |
| Debug query | +10-30s | Optional, on-demand only |
| Pre-flight check | +20-30s | Before deployment only |

---

## Architecture Decision

### Why Not a Separate Mode?

| Factor | Analysis |
|--------|----------|
| **Tool Reuse** | Uses 95%+ existing IndexFoundry tools |
| **New Functionality** | No new capabilities, just orchestration |
| **User Model** | Augments IndexFoundry, doesn't replace |
| **Maintenance** | Single protocol doc easier than two tools |
| **Compatibility** | 100% compatible with all IndexFoundry projects |

**Conclusion:** A protocol is simpler than a mode.

### Why Not Just Index Foundry?

| Gap | Librarian Solution |
|-----|-------------------|
| No pre-query validation | Manifest audit step |
| No hallucination detection | Score validation + debug |
| No self-correction | Auto-repair via re-chunking |
| No deployment safety | Pre-flight checks |
| No query optimization | Classification to skip RAG |

**Conclusion:** Librarian fills real gaps in IndexFoundry workflows.

---

## Documentation Structure

```
Docs/
├── MODE-COMPARISON-ANALYSIS.md      # Decision rationale
├── ADR-007-LIBRARIAN-PROTOCOL.md    # Full specification
├── LIBRARIAN-EXAMPLES.md             # Workflow examples
├── MODES-DECISION-SUMMARY.md         # This file
└── (Updated) PROJECT_KNOWLEDGE.md    # Added Librarian section
```

---

## Next Steps

### Phase 1: Documentation ✅ COMPLETE
- [x] Create MODE-COMPARISON-ANALYSIS.md
- [x] Create ADR-007-LIBRARIAN-PROTOCOL.md
- [x] Create LIBRARIAN-EXAMPLES.md
- [x] Update PROJECT_KNOWLEDGE.md

### Phase 2: Optional Utilities (Future)
- [ ] Add helper functions to `src/utils.ts` for state validation
- [ ] Add Librarian pattern tests to `tests/librarian-protocol.test.ts`
- [ ] Create Librarian reference implementation for orchestrators

### Phase 3: Client Integration (Future)
- [ ] Update MCP Inspector to show Librarian-compatible workflows
- [ ] Create Claude Desktop plugin for Librarian support
- [ ] Document Librarian patterns for AI agents

---

## Recommendation for Users

### If You're a **Novice User**

Use **Librarian patterns** (from [`LIBRARIAN-EXAMPLES.md`](./LIBRARIAN-EXAMPLES.md)):
- Safer (automatic validation)
- Self-correcting (auto-repair)
- Transparent (audit trails)

### If You're a **Power User**

Use **IndexFoundry directly**:
- Fine-grained control
- No Librarian overhead
- Direct tool access

### If You're **Building an Orchestrator**

Implement **Librarian protocol**:
- Check state before querying
- Classify queries
- Validate retrieval quality
- Return audit trails

---

## Conclusion

**The Librarian Protocol** makes IndexFoundry safer and more reliable by adding state verification and self-correction capabilities. It achieves this without requiring new tools or breaking IndexFoundry's existing workflows.

**Key Achievement:** Created a **documented, implementable protocol** that turns IndexFoundry from a "trust-your-inputs" tool library into a "reason-over-state" RAG framework.

---

## Related Documents

- [`MODE-COMPARISON-ANALYSIS.md`](./MODE-COMPARISON-ANALYSIS.md) - Full comparison analysis
- [`ADR-007-LIBRARIAN-PROTOCOL.md`](./ADR-007-LIBRARIAN-PROTOCOL.md) - Technical specification
- [`LIBRARIAN-EXAMPLES.md`](./LIBRARIAN-EXAMPLES.md) - Workflow implementations
- [`PROJECT_KNOWLEDGE.md`](./PROJECT_KNOWLEDGE.md#operational-protocols) - Updated with Librarian section
- [`ADR-005-BATCH-SOURCE-MANAGEMENT.md`](./ADR-005-BATCH-SOURCE-MANAGEMENT.md) - Batch operations
- [`ADR-006-BUILD-CHUNKING-LARGE-REQUESTS.md`](./ADR-006-BUILD-CHUNKING-LARGE-REQUESTS.md) - Progressive builds
