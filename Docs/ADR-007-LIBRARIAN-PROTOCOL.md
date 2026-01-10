# ADR-007: The Librarian Protocol - Active Data Curation for IndexFoundry

**Status:** 📋 PROPOSED  
**Date:** 2025-01-07  
**Author:** RAG Specialist  
**Relates To:** IndexFoundry MCP Server (existing), ADR-005 (Batch Source Management), ADR-006 (Build Chunking)

---

## Context

IndexFoundry provides a complete toolset for building deterministic vector indices from any content source. However, it operates as a **stateless tool library**—each tool invocation is independent, and the server does not verify data freshness, retrieval quality, or index consistency before responding.

### Current State

**IndexFoundry Strengths:**
- ✅ 35+ specialized tools for each RAG pipeline phase
- ✅ Deterministic, auditable, reproducible builds
- ✅ Multiple vector DB backends and embedding providers
- ✅ Fine-grained control for power users

**IndexFoundry Gaps:**
- ❌ No pre-query validation (assumes data is current)
- ❌ No manifest auditing (doesn't verify project.json vs. reality)
- ❌ No self-correction loop (doesn't retry/repair on poor retrieval)
- ❌ No hallucination detection (doesn't validate retrieval quality)
- ❌ No deployment safety checks (exports without verifying index state)
- ❌ No query classification (always runs retrieval, even for trivial questions)

### Use Case

A novice user (or automated system) needs to:
1. Query a RAG knowledge base confidently
2. Know if the retrieved data is fresh
3. Automatically repair poor retrieval without manual intervention
4. Deploy safely with confidence in index state
5. Avoid hallucinations by validating chunk cohesion

### Operational Principle

> **"Reason Over State"**: Before trusting any retrieval result, audit the underlying data pipeline state. If state is invalid, repair it. Only then provide the answer.

---

## Decision

Introduce **The Librarian Protocol**, an operational workflow layer for IndexFoundry that:

1. **Always checks state first** before querying or serving
2. **Classifies queries** to avoid unnecessary retrieval
3. **Validates retrieval quality** before trusting results
4. **Self-corrects** by re-chunking, re-embedding, or rebuilding
5. **Ensures deployment safety** through comprehensive pre-flight checks

The Librarian is **not a new mode**. It is a **documented protocol** and **workflow pattern** that orchestrates IndexFoundry's existing tools in a state-aware, self-correcting manner.

---

## Architecture

### The "Reason Over State" Loop

```
┌─────────────────────────────────────────────────────────────────────┐
│                     User Request                                    │
│                (Query / Deploy / Search)                            │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
    ┌────────────────────────────────────────────────────────┐
    │  STEP 1: MANIFEST AUDIT (State Check)                  │
    │  ┌──────────────────────────────────────────────────┐  │
    │  │ Load project.json                               │  │
    │  │ Verify sources.jsonl exists & is not empty     │  │
    │  │ Verify data/chunks.jsonl exists & has content  │  │
    │  │ Verify data/vectors.jsonl exists & has content │  │
    │  │ Check: total_sources == processed_sources      │  │
    │  │ Check: chunk_count > 0                          │  │
    │  │ Check: vector_count == chunk_count             │  │
    │  └──────────────────────────────────────────────────┘  │
    │  Decision: [State Valid] → Step 2  OR  [Stale] → Repair
    └────────────────────────────────────────────────────────┘
                             │
                ┌────────────┴────────────┐
                │ Valid                   │ Stale
                ▼                         ▼
    ┌─────────────────────┐     [Repair: Run project_build]
    │  STEP 2: CLASSIFY   │     └─ Re-index pending sources
    │  (Query Intent)     │     └─ Re-embed stale vectors
    │ ┌─────────────────┐ │     └─ Retry from Step 1
    │ │ User query text │ │
    │ │   (if query)    │ │
    │ └────────┬────────┘ │
    │ Call:    │          │
    │ classify │          │
    │ _query() │          │
    │ ┌────────▼────────┐ │
    │ │ Type: ?         │ │
    │ │ - Factual       │ │
    │ │ - Procedural    │ │
    │ │- Conceptual     │ │
    │ │- Navigational   │ │
    │ │- Conversational │ │
    │ └────────┬────────┘ │
    │ ┌────────▼────────┐ │
    │ │ Needs RAG?      │ │
    │ │ [YES] → Step 3  │ │
    │ │ [NO] → Skip to  │ │
    │ │        Answer   │ │
    │ └─────────────────┘ │
    └─────────────────────┘
                │
                ▼
    ┌────────────────────────────────────────────────────────┐
    │  STEP 3: QUERY & RETRIEVE                              │
    │  ┌──────────────────────────────────────────────────┐  │
    │  │ Call: indexfoundry_project_query()               │  │
    │  │ Mode: semantic / keyword / hybrid (adaptive)     │  │
    │  │ Top K: 5-10 results                              │  │
    │  │ Include metadata & similarity scores             │  │
    │  └──────────────────────────────────────────────────┘  │
    │  Results: [chunk_id, score, text, source, metadata]   │
    └────────────────────────────────────────────────────────┘
                             │
                             ▼
    ┌────────────────────────────────────────────────────────┐
    │  STEP 4: VERIFY (Hallucination Check)                  │
    │  ┌──────────────────────────────────────────────────┐  │
    │  │ Min Score Threshold: 0.6                         │  │
    │  │ Avg Score Threshold: 0.65                        │  │
    │  │                                                  │  │
    │  │ If scores < threshold:                          │  │
    │  │ └─ Call: indexfoundry_debug_query()             │  │
    │  │    Trace: retrieval pipeline details             │  │
    │  │    Analyze: why scores are low?                  │  │
    │  │    Options:                                      │  │
    │  │    a) Chunks too large → re-chunk               │  │
    │  │    b) Poor chunking → change strategy            │  │
    │  │    c) Missing source → add data                  │  │
    │  │    d) Query outside domain → escalate           │  │
    │  └──────────────────────────────────────────────────┘  │
    │  Decision: [Valid Scores] → Step 5  OR  [Low] → Repair
    └────────────────────────────────────────────────────────┘
                             │
                ┌────────────┴────────────┐
                │ Valid                   │ Low Scores
                ▼                         ▼
    ┌─────────────────────┐     [Repair Options:]
    │  STEP 5: ANSWER     │     1) Re-chunk project
    │  (with Metadata)    │        - indexfoundry_project_remove_source()
    │ ┌─────────────────┐ │        - Add new chunking strategy
    │ │ Return Results: │ │        - indexfoundry_project_add_source()
    │ │ - Chunks        │ │        - indexfoundry_project_build()
    │ │ - Scores        │ │     2) Add more sources
    │ │ - Citations     │ │        - indexfoundry_project_add_source()
    │ │ - Metadata      │ │        - indexfoundry_project_build()
    │ │ - Audit Trail:  │ │     3) Escalate to human
    │ │   - State check │ │        - "Unable to find relevant content"
    │ │     timestamp   │ │        - Return audit details
    │ │   - Last refresh│ │        - Ask for clarification
    │ │   - Data sources│ │     
    │ │   - Confidence  │ │     After repair:
    │ │     score       │ │     └─ Retry from Step 1
    │ │ - Warnings (if  │ │
    │ │   any)          │ │
    │ └─────────────────┘ │
    └─────────────────────┘
                │
                ▼
        ┌──────────────────┐
        │  FINAL RESPONSE  │
        └──────────────────┘
```

### State Check Patterns

#### Pattern 1: Manifest Audit (Minimal)
```typescript
// Quick check: is the index ready?
async function auditManifest(projectId: string): Promise<{
  isValid: boolean;
  issues: string[];
  stats: { sources: number; chunks: number; vectors: number };
}> {
  const project = await indexfoundry_project_get({ project_id: projectId });
  
  const issues: string[] = [];
  
  // Check project.json exists
  if (!project.manifest) issues.push("project.json missing");
  
  // Check sources exist
  if (!project.sources || project.sources.length === 0) {
    issues.push("No sources added");
  }
  
  // Check all sources are processed
  const pending = project.sources.filter(s => s.status === "pending");
  if (pending.length > 0) {
    issues.push(`${pending.length} sources pending (not processed)`);
  }
  
  // Check chunks exist
  if (project.manifest?.chunk_count === 0) {
    issues.push("No chunks indexed");
  }
  
  // Check vector count matches chunk count
  if (project.manifest?.chunk_count !== project.manifest?.vector_count) {
    issues.push(
      `Chunk/vector mismatch: ${project.manifest?.chunk_count} chunks vs ` +
      `${project.manifest?.vector_count} vectors`
    );
  }
  
  return {
    isValid: issues.length === 0,
    issues,
    stats: {
      sources: project.sources?.length ?? 0,
      chunks: project.manifest?.chunk_count ?? 0,
      vectors: project.manifest?.vector_count ?? 0
    }
  };
}
```

#### Pattern 2: Query Classification (Intent Detection)
```typescript
// Before querying, determine if RAG is needed
async function classifyAndRoute(
  projectId: string,
  query: string
): Promise<{
  type: string;
  needsRag: boolean;
  confidence: number;
  recommendation: string;
}> {
  const classification = await indexfoundry_classify_query({
    query,
    context: { domain: projectId, available_collections: [projectId] }
  });
  
  // Rule-based routing
  const needsRag =
    classification.needs_retrieval !== false &&
    classification.confidence >= 0.5;
  
  return {
    type: classification.query_type,
    needsRag,
    confidence: classification.confidence,
    recommendation: needsRag
      ? `Search with ${classification.suggested_mode || "hybrid"} mode`
      : "Answer without retrieval"
  };
}
```

#### Pattern 3: Retrieval Validation (Score Analysis)
```typescript
// After querying, validate result quality
async function validateRetrievalQuality(
  results: Array<{ chunk_id: string; score: number; text: string }>,
  query: string
): Promise<{
  isValid: boolean;
  minScore: number;
  avgScore: number;
  issues: string[];
  recommendation: "trust" | "debug" | "repair";
}> {
  if (results.length === 0) {
    return {
      isValid: false,
      minScore: 0,
      avgScore: 0,
      issues: ["No results returned"],
      recommendation: "repair"
    };
  }
  
  const scores = results.map(r => r.score);
  const minScore = Math.min(...scores);
  const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  
  const issues: string[] = [];
  
  // Check minimum score
  if (minScore < 0.5) {
    issues.push(`Lowest score ${minScore} below 0.5 threshold`);
  }
  
  // Check average score
  if (avgScore < 0.65) {
    issues.push(`Average score ${avgScore} below 0.65 threshold`);
  }
  
  // Check result diversity (simple heuristic)
  const uniqueSources = new Set(results.map(r => r.source_id));
  if (uniqueSources.size === 1) {
    issues.push("All results from single source (limited perspective)");
  }
  
  const isValid = issues.length === 0;
  const recommendation = isValid
    ? "trust"
    : avgScore >= 0.6
    ? "debug"
    : "repair";
  
  return {
    isValid,
    minScore,
    avgScore,
    issues,
    recommendation
  };
}
```

#### Pattern 4: Self-Correction (Re-Chunking)
```typescript
// If retrieval quality is poor, try different chunking strategy
async function attemptRepair(
  projectId: string,
  currentStrategy: string
): Promise<{ success: boolean; newStrategy: string; reason: string }> {
  // Determine alternative strategy based on current
  const strategies: Record<string, string> = {
    "recursive": "hierarchical",
    "hierarchical": "by_paragraph",
    "by_paragraph": "by_sentence",
    "by_sentence": "fixed_chars"
  };
  
  const newStrategy = strategies[currentStrategy] || "recursive";
  
  // Repair: remove all sources and rebuild with new strategy
  const project = await indexfoundry_project_get({ project_id: projectId });
  
  // In a real implementation:
  // 1. Store current sources
  // 2. Remove project
  // 3. Recreate with new chunk_config.strategy
  // 4. Re-add all sources
  // 5. Rebuild
  
  return {
    success: true,
    newStrategy,
    reason: `Changed from ${currentStrategy} to ${newStrategy} for better granularity`
  };
}
```

### Deployment Safety Pattern

```typescript
// Before exporting/deploying, run full validation
async function preFlightCheck(projectId: string): Promise<{
  canDeploy: boolean;
  checks: Array<{ name: string; status: "pass" | "fail" | "warn"; details: string }>;
  recommendations: string[];
}> {
  const checks: Array<{ name: string; status: "pass" | "fail" | "warn"; details: string }> = [];
  const recommendations: string[] = [];
  
  // Check 1: Manifest validity
  const manifest = await auditManifest(projectId);
  checks.push({
    name: "Manifest Audit",
    status: manifest.isValid ? "pass" : "fail",
    details: manifest.isValid ? "All checks passed" : manifest.issues.join("; ")
  });
  
  // Check 2: Data completeness
  const project = await indexfoundry_project_get({ project_id: projectId });
  if (!project.manifest || project.manifest.chunk_count === 0) {
    checks.push({
      name: "Data Completeness",
      status: "fail",
      details: "No indexed data found"
    });
    recommendations.push("Run project_build to index sources");
  } else {
    checks.push({
      name: "Data Completeness",
      status: "pass",
      details: `${project.manifest.chunk_count} chunks, ${project.manifest.vector_count} vectors`
    });
  }
  
  // Check 3: Source coverage
  const failedSources = project.sources.filter(s => s.status === "failed");
  if (failedSources.length > 0) {
    checks.push({
      name: "Source Status",
      status: "warn",
      details: `${failedSources.length} sources failed processing`
    });
    recommendations.push("Review and retry failed sources before deploying");
  } else {
    checks.push({
      name: "Source Status",
      status: "pass",
      details: `All ${project.sources.length} sources processed`
    });
  }
  
  // Check 4: Configuration validation
  const hasValidEmbeddingConfig = project.manifest?.embedding_model?.provider &&
    project.manifest?.embedding_model?.model_name;
  checks.push({
    name: "Embedding Configuration",
    status: hasValidEmbeddingConfig ? "pass" : "fail",
    details: hasValidEmbeddingConfig
      ? `${project.manifest?.embedding_model?.provider}/${project.manifest?.embedding_model?.model_name}`
      : "Embedding model not configured"
  });
  
  // Overall decision
  const hasFailures = checks.some(c => c.status === "fail");
  const canDeploy = !hasFailures;
  
  return {
    canDeploy,
    checks,
    recommendations
  };
}
```

---

## Protocols & Rules

### Protocol 1: Query Handling

```
┌──────────────────────────────────────────────────────────────┐
│ User Issues Query                                            │
└────────────────┬─────────────────────────────────────────────┘
                 │
    ┌────────────▼──────────────┐
    │ Step 1: Audit Manifest   │
    │ (5 second check)          │
    └────────────┬──────────────┘
                 │
    ┌────────────▼─────────────────────────────────────┐
    │ Result: [Valid] → Continue                       │
    │         [Stale] → Run project_build              │
    │         [Error] → Escalate                       │
    └────────────┬─────────────────────────────────────┘
                 │
    ┌────────────▼─────────────────────┐
    │ Step 2: Classify Query           │
    │ (Intent detection)                │
    └────────────┬─────────────────────┘
                 │
    ┌────────────▼──────────────────────────────┐
    │ Result: [Needs RAG] → Query                │
    │         [No RAG] → Answer directly         │
    │         [Unclear] → Ask for clarification  │
    └────────────┬──────────────────────────────┘
                 │
    ┌────────────▼────────────────────────────────────────┐
    │ Step 3: Execute Query (if needed)                   │
    │ Call: indexfoundry_project_query()                  │
    │ Collect: top_k=10, include scores & metadata        │
    └────────────┬────────────────────────────────────────┘
                 │
    ┌────────────▼──────────────────────────────────────────┐
    │ Step 4: Validate Scores                              │
    │ Min Score ≥ 0.5? Avg Score ≥ 0.65?                  │
    └────────────┬──────────────────────────────────────────┘
                 │
    ┌────────────▼────────────────────────────────────────┐
    │ Result: [Valid] → Step 5 (Answer)                  │
    │         [Low] → Call debug_query                    │
    │         [None] → Escalate (no relevant data)       │
    └────────────┬────────────────────────────────────────┘
                 │
    ┌────────────▼─────────────────────────────┐
    │ Step 5: Return Results                   │
    │ Include: Chunks + Scores + Citations +   │
    │          Metadata + Audit Trail          │
    └────────────┬─────────────────────────────┘
                 │
                 ▼
        ┌──────────────────┐
        │ Answer to User   │
        └──────────────────┘
```

### Protocol 2: Deployment Workflow

```
┌────────────────────────────────────────────────┐
│ User Requests: project_export or project_serve │
└────────────────┬────────────────────────────────┘
                 │
    ┌────────────▼──────────────────────┐
    │ Step 1: Run Pre-Flight Check      │
    │ - Manifest audit                  │
    │ - Data completeness               │
    │ - Source coverage                 │
    │ - Configuration validation        │
    └────────────┬──────────────────────┘
                 │
    ┌────────────▼─────────────────────────────┐
    │ Result: [All Pass] → Proceed             │
    │         [Warnings] → Warn user + proceed │
    │         [Failures] → Abort               │
    └────────────┬─────────────────────────────┘
                 │
    ┌────────────▼────────────────────────────┐
    │ Step 2: Execute Deployment              │
    │ Call: indexfoundry_project_export() or  │
    │       indexfoundry_project_serve()      │
    └────────────┬────────────────────────────┘
                 │
    ┌────────────▼──────────────────────────┐
    │ Step 3: Log Deployment Event          │
    │ - Timestamp                           │
    │ - Project state snapshot              │
    │ - All check results                   │
    │ - Warnings (if any)                   │
    └────────────┬──────────────────────────┘
                 │
                 ▼
        ┌─────────────────────┐
        │ Deployment Complete │
        └─────────────────────┘
```

---

## Thresholds & Configuration

### Score Thresholds

| Metric | Threshold | Rationale |
|--------|-----------|-----------|
| Minimum chunk score | 0.50 | Below this, chunk is likely irrelevant |
| Average result score | 0.65 | Indicates reasonable retrieval quality |
| Confidence (classification) | 0.50 | Minimum confidence to run RAG |
| Similarity variance | Should not exceed 0.4 | Flag if results have high variance |

### Retry Strategy

| Scenario | Action | Max Retries |
|----------|--------|------------|
| Stale manifest | Run `project_build` | 1 |
| Low scores (avg < 0.65) | Call `debug_query`, analyze | 1 |
| Re-chunk needed | Change strategy, rebuild | 2 |
| Persistent low scores | Escalate to human | N/A |
| Failed source | Mark, continue | N/A |

### Timeout Safeguards

| Operation | Timeout | Reason |
|-----------|---------|--------|
| Manifest audit | 5 seconds | Quick validation |
| Classification | 10 seconds | Intent detection |
| Query retrieval | 30 seconds | Standard MCP timeout |
| Debug query | 30 seconds | Detailed analysis |
| Project build | 300 seconds (5 min) | Long-running, uses checkpoints |

---

## Error Handling & Escalation

### Error Categories

#### Category 1: State Errors (Recoverable)
- **Stale manifest**: Run `project_build` to refresh
- **Missing chunks**: Add sources via `project_add_source`, rebuild
- **Missing vectors**: Run `project_build` to generate embeddings

**Recovery**: Librarian auto-repairs, then retries query

#### Category 2: Retrieval Errors (Partially Recoverable)
- **Low scores**: Debug via `debug_query`, consider re-chunking
- **No results**: Query outside domain knowledge base
- **High score variance**: Chunks may be too large or too small

**Recovery**: Librarian offers options (debug, re-chunk, escalate)

#### Category 3: System Errors (Not Recoverable)
- **API rate limiting**: OpenAI quota exceeded
- **Database connection**: Vector DB unreachable
- **Disk full**: Cannot write embeddings

**Recovery**: Escalate to human with diagnostic details

### Escalation Pattern

```typescript
interface EscalationReport {
  severity: "warn" | "error" | "critical";
  category: string;
  description: string;
  diagnostics: Record<string, unknown>;
  suggestedActions: string[];
  retryable: boolean;
}

async function escalate(report: EscalationReport): Promise<void> {
  // Log escalation
  console.error(`[ESCALATION] ${report.severity}: ${report.description}`);
  console.error(`Diagnostics:`, report.diagnostics);
  console.error(`Suggested actions:`, report.suggestedActions);
  
  // Optionally: send alert to monitoring system
  // Optionally: notify admin
  // Optionally: create support ticket
  
  // Return structured error to user
  throw new Error(
    `Unable to complete request: ${report.description}. ` +
    `${report.suggestedActions.join(" ")} ` +
    `${report.retryable ? "Please retry." : "Manual intervention required."}`
  );
}
```

---

## Usage Examples

See [`Docs/LIBRARIAN-EXAMPLES.md`](./LIBRARIAN-EXAMPLES.md) for detailed workflow examples:

1. **Query with Full Audit** - Step-by-step query with state checking
2. **Retrieval Debugging** - Analyzing poor retrieval quality
3. **Self-Correction Loop** - Auto-repairing via re-chunking
4. **Deployment Pre-Flight** - Full validation before shipping
5. **Batch Indexing** - Managing large multi-source projects

---

## Integration with IndexFoundry

### Dependencies

The Librarian protocol **depends on** and **uses only existing** IndexFoundry tools:

| Tool | Phase | Purpose |
|------|-------|---------|
| `indexfoundry_project_get` | State Check | Load project manifest |
| `indexfoundry_project_list` | Discovery | Find projects |
| `indexfoundry_classify_query` | Intent | Determine if RAG needed |
| `indexfoundry_project_query` | Retrieval | Execute search |
| `indexfoundry_debug_query` | Validation | Analyze poor results |
| `indexfoundry_project_add_source` | Repair | Add new content |
| `indexfoundry_project_remove_source` | Repair | Clean up sources |
| `indexfoundry_project_build` | Repair | Re-index with new strategy |
| `indexfoundry_project_export` | Deploy | Export files |
| `indexfoundry_project_serve` | Deploy | Start local server |

**No new tools are required.** The Librarian is a workflow orchestration pattern.

### Compatibility

- ✅ Works with all IndexFoundry projects (run-based and project-based)
- ✅ Compatible with all embedding providers (OpenAI, Cohere, local, etc.)
- ✅ Compatible with all vector DB backends (Pinecone, Weaviate, Qdrant, Milvus, Chroma, local)
- ✅ Does not modify IndexFoundry behavior or state
- ✅ Power users can bypass Librarian and use IndexFoundry directly

---

## Implementation Guidance

### For Orchestrator Agents

If implementing Librarian in an orchestrator (e.g., Claude with tool access):

1. **Before querying**:
   ```typescript
   const auditResult = await indexfoundry_project_get({ project_id });
   if (!isValidState(auditResult)) {
     await indexfoundry_project_build({ project_id });
   }
   ```

2. **During retrieval**:
   ```typescript
   const classification = await indexfoundry_classify_query({ query });
   if (!classification.needs_retrieval) {
     // Answer without RAG
     return directAnswer;
   }
   const results = await indexfoundry_project_query({ project_id, query });
   ```

3. **After retrieval**:
   ```typescript
   if (avgScore < 0.65) {
     const debug = await indexfoundry_debug_query({ query, run_id });
     // Analyze debug output, decide on re-chunking
   }
   ```

4. **Before deploying**:
   ```typescript
   const checks = await preFlightCheck(projectId);
   if (!checks.canDeploy) {
     throw new Error(`Pre-flight failed: ${checks.recommendations.join("; ")}`);
   }
   await indexfoundry_project_export({ project_id });
   ```

### For MCP Client Developers

If adding Librarian support to a client:

1. **Add state validation UI**: Show "Index last checked: [timestamp]"
2. **Add query classification UI**: Show "Query type: [classification]"
3. **Add score visualization**: Show similarity scores with color coding
4. **Add escalation alerts**: Notify user if repair is needed

---

## Consequences

### Positive

1. **Reliability**: Automatic state verification prevents stale data issues
2. **User Confidence**: Transparency through audit trails and metadata
3. **Self-Correction**: Automatic recovery from retrieval failures
4. **Safety**: Pre-flight checks prevent bad deployments
5. **Usability**: Novices get safe defaults; power users stay unaffected
6. **Debuggability**: Rich diagnostic information for troubleshooting

### Negative

1. **Latency**: State checks add 5-10 seconds per query
2. **Complexity**: More orchestration required from client/agent
3. **Overhead**: Additional API calls (classify, debug)
4. **Cost**: More embeddings/tokens on re-repairs

### Mitigation

- Implement caching for state checks (reuse if < 1 hour old)
- Make all Librarian steps optional (clients can skip)
- Use classification to avoid unnecessary retrieval
- Document performance implications

---

## Related ADRs

- **ADR-001**: ChatBot Template Generation (chatbot exports)
- **ADR-005**: Batch Source Management (bulk operations)
- **ADR-006**: Build Chunking and Large Requests (progressive builds)

---

## References

- [`src/tools/projects.ts`](../src/tools/projects.ts) - IndexFoundry project tools
- [`src/tools/classify.ts`](../src/tools/classify.ts) - Query classification
- [`src/tools/debug.ts`](../src/tools/debug.ts) - Retrieval debugging
- [`PROJECT_KNOWLEDGE.md`](./PROJECT_KNOWLEDGE.md) - IndexFoundry overview
