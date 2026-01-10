# Mode Comparison: Index Foundry vs. The Librarian

**Status:** ANALYSIS DOCUMENT  
**Date:** 2025-01-07  
**Decision Required:** Replace / Augment / New Mode

---

## Executive Summary

**The Librarian** is a specialized operational protocol for Index Foundry, not a replacement mode. It introduces an **audit-first, state-verification workflow** ("Reason Over State") that sits *on top of* IndexFoundry's existing tools rather than replacing them.

**Recommendation:** **AUGMENT Index Foundry with Librarian Protocol** (not a separate mode)

---

## Detailed Comparison

### 1. Current Index Foundry Mode (🗄️)

#### Scope
- **Two complementary workflows:**
  - Run-based: Fine-grained phase-by-phase control (Connect → Extract → Normalize → Index → Serve)
  - Project-based: Higher-level abstraction with complete deployment repos

#### Operational Model
- **Stateless tool invocation**: Tools execute in isolation
- **Trust inputs**: Assumes sources are valid and up-to-date
- **Sequential execution**: User orchestrates multi-step workflows

#### Key Strengths
- ✅ 35+ specialized tools for each phase
- ✅ Deterministic, auditable, reproducible
- ✅ Complete project-to-deployment pipeline
- ✅ Multiple vector DB backends, embedding providers
- ✅ Fine-grained control for power users

#### Key Gaps (Where Librarian Fits)
- ❌ **No pre-query validation**: Assumes data is current
- ❌ **No manifest auditing**: Doesn't verify project.json vs. actual files
- ❌ **No self-correction loop**: Doesn't retry/repair on poor retrieval
- ❌ **No deployment safety checks**: Exports without verifying index state
- ❌ **No hallucination detection**: Doesn't validate retrieval quality before responding

---

### 2. The Librarian (Proposed Addition)

#### Scope
- **Operational protocol** for Index Foundry workflows
- **Data curator** role with audit-first mindset
- **Self-correcting retrieval pipeline** (State Check → Query → Verify → Repair → Answer)

#### Operational Model
- **State-first verification**: Always check project.json and manifest before querying
- **Query classification**: Determine if RAG is needed before retrieval
- **Retrieval validation**: Critique returned chunks for quality, completeness, hallucination
- **Self-repair loops**: Re-chunk, re-embed, re-index if retrieval is poor
- **Deployment verification**: Validate index state before export/serve

#### New Capabilities
- 🆕 **Manifest Audit**: Verify project state matches expected reality
- 🆕 **Query Classification**: Use `classify_query` to avoid unnecessary retrieval
- 🆕 **Retrieval Debugging**: Use `debug_query` to diagnose poor results
- 🆕 **Self-Correction**: Re-normalize with different chunking strategies if needed
- 🆕 **Deployment Safety**: Full state validation before shipping

#### Tools It Would Use
- `indexfoundry_project_get` (state check)
- `indexfoundry_project_query` (retrieval)
- `indexfoundry_classify_query` (intent detection)
- `indexfoundry_debug_query` (similarity analysis)
- `indexfoundry_project_build` (repair/re-index)
- All project tools (already exist)

---

## Key Decision Points

### Decision 1: Is This a New Mode or an Enhancement?

| Aspect | Analysis | Recommendation |
|--------|----------|-----------------|
| **Tool Overlap** | Uses 95%+ existing Index Foundry tools | Augment, don't replace |
| **Responsibility** | Stateful orchestration layer (workflow) vs. stateless tools (execution) | Augment with protocol |
| **User Model** | Power users keep Index Foundry; novices use Librarian patterns | Augment with docs/examples |
| **Maintenance** | New mode = new files; protocol = documented patterns | Augment is simpler |
| **Interop** | Should work with existing Index Foundry workflows | Augment requires no changes |

**→ AUGMENT, not new mode**

---

### Decision 2: Where Should Librarian Protocol Live?

#### Option A: New Mode File (`.roo/modes/librarian.md`)
- **Pros**: Clear separation, discoverable, consistent with other modes
- **Cons**: Suggests it's separate from Index Foundry, might confuse users

#### Option B: ADR in Docs/ + Protocol Examples
- **Pros**: Lives with Index Foundry docs, clear rationale, examples
- **Cons**: Not discoverable through mode listing

#### Option C: Enhance Index Foundry Mode Docs + Add Examples
- **Pros**: Integrated, clear it's part of Index Foundry
- **Cons**: Mode file might get large

**→ RECOMMENDATION: Option B + embedded examples**
- Create `Docs/ADR-007-LIBRARIAN-PROTOCOL.md` with full specification
- Add "Librarian Mode" section to `PROJECT_KNOWLEDGE.md`
- Create `Docs/LIBRARIAN-EXAMPLES.md` with workflow examples

---

## Proposed Integration Path

### Phase 1: Documentation (This Task)
Create three documents:
1. [`Docs/ADR-007-LIBRARIAN-PROTOCOL.md`](../Docs/ADR-007-LIBRARIAN-PROTOCOL.md)
   - Full operational protocol specification
   - "Reason Over State" loop
   - State check patterns
   - Query classification patterns
   - Retrieval validation patterns
   - Self-correction procedures

2. [`Docs/LIBRARIAN-EXAMPLES.md`](../Docs/LIBRARIAN-EXAMPLES.md)
   - Step-by-step workflow examples
   - State audit examples
   - Query classification examples
   - Retrieval debugging examples
   - Deployment safety validation

3. Update [`PROJECT_KNOWLEDGE.md`](../PROJECT_KNOWLEDGE.md)
   - Add "Librarian Protocol" section
   - Cross-reference ADR-007

### Phase 2: Example Implementation (Optional)
Create a reference implementation (TypeScript):
- `src/tools/librarian.ts` - Optional helper functions for Librarian-style workflows
- Not a tool (no schema), just utility functions for orchestrators

### Phase 3: Testing (Optional)
- `tests/librarian-protocol.test.ts` - Verify Librarian workflow patterns

---

## Contract: How Librarian Uses Index Foundry

### Operational Contract

```
┌─────────────────────────────────────────────────────────────────┐
│                    Librarian Protocol                           │
├─────────────────────────────────────────────────────────────────┤
│  INPUT: User query or deployment request                        │
│                                                                 │
│  Step 1: STATE CHECK (Manifest Audit)                          │
│  ├─ Use: indexfoundry_project_get()                            │
│  ├─ Check: sources.jsonl exists, has expected counts           │
│  ├─ Check: data/chunks.jsonl size > 0                          │
│  ├─ Check: data/vectors.jsonl size > 0                         │
│  └─ Decision: Proceed if valid, repair if stale               │
│                                                                 │
│  Step 2: CLASSIFY (Intent Detection)                           │
│  ├─ Use: indexfoundry_classify_query()                         │
│  ├─ Determine: Is RAG retrieval needed?                        │
│  ├─ Determine: Query type (factual/procedural/conceptual?)     │
│  └─ Decision: Skip retrieval for some queries                  │
│                                                                 │
│  Step 3: QUERY (Retrieval)                                     │
│  ├─ Use: indexfoundry_project_query()                          │
│  ├─ Modes: semantic/keyword/hybrid based on classification     │
│  ├─ Critique: Similarity scores ≥ threshold?                   │
│  └─ Decision: Proceed or repair                                │
│                                                                 │
│  Step 4: VERIFY (Hallucination Check)                          │
│  ├─ Use: indexfoundry_debug_query() if scores are marginal     │
│  ├─ Check: Chunks have semantic cohesion?                      │
│  ├─ Check: No contradictions in retrieved set?                 │
│  └─ Decision: Trust results or re-chunk                        │
│                                                                 │
│  Step 5: REPAIR (Self-Correction Loop)                         │
│  ├─ If scores low: Re-run with different chunking strategy     │
│  │  Use: indexfoundry_project_remove_source() + rebuild       │
│  ├─ If chunks are orphaned: Clean up data files               │
│  │  Use: indexfoundry_normalize_dedupe()                       │
│  ├─ If vectors are stale: Re-index                             │
│  │  Use: indexfoundry_project_build()                          │
│  └─ Decision: Retry query or escalate                          │
│                                                                 │
│  Step 6: ANSWER (Final Response)                               │
│  ├─ Return results ONLY after state validation                 │
│  ├─ Include: "Index state checked: [timestamp]"               │
│  ├─ Include: "Retrieval confidence: [score]"                   │
│  └─ Include: "Data last refreshed: [date]"                     │
│                                                                 │
│  OUTPUT: Validated result or escalation                        │
└─────────────────────────────────────────────────────────────────┘
```

### Tools Required (All Exist)

| Tool | Usage | Phase |
|------|-------|-------|
| `indexfoundry_project_get` | State check | 1 |
| `indexfoundry_classify_query` | Intent detection | 2 |
| `indexfoundry_project_query` | Retrieval | 3 |
| `indexfoundry_debug_query` | Hallucination check | 4 |
| `indexfoundry_project_remove_source` | Clean up | 5 |
| `indexfoundry_normalize_dedupe` | Deduplication | 5 |
| `indexfoundry_project_build` | Re-index | 5 |

**No new tools needed.** Librarian is a *workflow orchestration pattern*, not new functionality.

---

## Comparison Matrix

| Aspect | Index Foundry | Librarian Protocol |
|--------|---------------|-------------------|
| **Type** | MCP tool library | Operational protocol |
| **Scope** | Individual tool invocation | Multi-step orchestrated workflow |
| **Trust Model** | Trust inputs | Verify first, trust after audit |
| **Error Handling** | User handles errors | Auto-repair loops |
| **Use Case** | Power users, fine control | Novices, self-correcting workflows |
| **State Awareness** | None | Full project state tracking |
| **Validation** | None | Pre-query, post-query, pre-deploy |
| **Hallucination Check** | None | Yes, via `debug_query` |
| **Deployment Safety** | None | Full state validation |
| **New Tools** | N/A | None needed |
| **File Changes** | None | Documentation only |

---

## Recommendation Summary

### Do NOT create a new mode. Instead:

1. **Create ADR-007**: Full Librarian Protocol specification
2. **Create Examples**: LIBRARIAN-EXAMPLES.md with workflows
3. **Update Docs**: Add Librarian section to PROJECT_KNOWLEDGE.md
4. **Optional**: Add utility functions to `src/utils.ts` for state validation

### Why?

- ✅ **Zero breaking changes** to Index Foundry
- ✅ **Maximum code reuse** (uses existing tools)
- ✅ **Clear mental model** (protocol + docs, not separate mode)
- ✅ **Easy to document** (ADR format fits the project)
- ✅ **Power users unaffected** (Index Foundry stays as-is)
- ✅ **Novices get safe defaults** (Librarian patterns)

### Implementation Timeline

| Phase | Effort | Output |
|-------|--------|--------|
| Phase 1: Docs | 4 hours | 3 documents + updates |
| Phase 2: Utils (opt) | 2 hours | Helper functions |
| Phase 3: Tests (opt) | 2 hours | Test coverage |

---

## Next Steps

Confirm recommendation and I will:
1. Create `Docs/ADR-007-LIBRARIAN-PROTOCOL.md` (full spec)
2. Create `Docs/LIBRARIAN-EXAMPLES.md` (workflow examples)
3. Update `PROJECT_KNOWLEDGE.md` (Librarian section)
4. Optional: Add utility functions to support Librarian workflows
