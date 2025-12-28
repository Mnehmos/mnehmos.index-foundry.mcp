# ADR-003: Hybrid Search Scoring Strategy for RAG Templates

**Status:** Proposed  
**Date:** 2025-12-26  
**Author:** Architect Mode  
**Scope:** IndexFoundry template generation (`src/tools/projects.ts`)

---

## Context

IndexFoundry generates standalone RAG servers via `project_export`. These generated servers include a `searchHybrid` function that combines keyword and semantic search.

**Current Problem:** The template uses Reciprocal Rank Fusion (RRF) which scores by *rank position* rather than *match quality*. This causes specific identifier queries to fail:

| Query | Expected Behavior | RRF Behavior |
|-------|-------------------|--------------|
| "D40" | Exact match → top result | Buried at rank 12+ |
| "Aboleth" | Monster name → top 3 | Diluted by semantic neighbors |
| "MSHA 30 CFR 75" | Regulation code → top result | Lost in generic matches |

**Root Cause:** RRF formula `1/(k+rank)` treats a keyword match at rank 1 vs rank 5 as only 1.3x better, but an *exact identifier match* should be 10x+ better than a fuzzy semantic match.

---

## Problem Analysis

### Query Types in RAG Systems

1. **Identifier Queries** (high specificity)
   - Pattern: Short alphanumeric codes, proper nouns, technical terms
   - Examples: `D40`, `Aboleth`, `30 CFR 75.1725`, `PII-2024-0042`
   - Need: Exact keyword match should dominate

2. **Conceptual Queries** (low specificity)  
   - Pattern: Natural language questions with common words
   - Examples: "What are the safety requirements?", "Tell me about fire hazards"
   - Need: Semantic understanding should dominate

3. **Mixed Queries** (medium specificity)
   - Pattern: Natural language + identifier
   - Examples: "Tell me about Room D40", "Explain regulation 75.1725"
   - Need: Anchor on identifier, expand with semantics

### Why RRF Fails

```
RRF score = Σ 1/(k + rank_i)   where k = 60

For query "D40":
- Keyword rank 1 match "Region D40": RRF contribution = 1/61 = 0.0164
- Semantic rank 1 match "Region D41": RRF contribution = 1/61 = 0.0164 (same!)
- Semantic rank 3 match "Area D": RRF contribution = 1/63 = 0.0159

Result: D41 ties with D40, D area close behind → exact match buried
```

### Why Linear Interpolation Works Better

```
Linear score = α * semantic_score + (1-α) * keyword_score

For query "D40":
- Chunk "Region D40": keyword=1.0, semantic=0.7 → 0.7*0.7 + 0.3*1.0 = 0.79
- Chunk "Region D41": keyword=0.0, semantic=0.85 → 0.7*0.85 + 0.3*0 = 0.595
- Chunk "Area D": keyword=0.5, semantic=0.6 → 0.7*0.6 + 0.3*0.5 = 0.57

Result: D40 clearly wins (0.79 vs 0.595)
```

---

## Decision

### Option A: Simple Linear Interpolation (Recommended for v1)

Replace RRF with weighted linear combination:
- **Semantic weight (α):** 0.7
- **Keyword weight (1-α):** 0.3

**Pros:**
- Simple, predictable behavior
- Matches existing `projectQuery` tool implementation
- Preserves actual match quality scores

**Cons:**
- Fixed weighting doesn't adapt to query type
- May over-weight semantics for identifier-heavy queries

### Option B: Query-Adaptive Weighting (Future Enhancement)

Analyze query to classify specificity, then adjust weights:

```typescript
function getQueryWeights(query: string): { semantic: number; keyword: number } {
  const tokens = query.toLowerCase().split(/\s+/);
  const identifierPattern = /^[a-z]\d+$|^\d+[a-z]+$/i;
  const stopwords = new Set(['tell', 'me', 'about', 'what', 'is', 'the', 'how']);
  
  const identifiers = tokens.filter(t => identifierPattern.test(t));
  const meaningful = tokens.filter(t => !stopwords.has(t));
  
  const specificity = identifiers.length / Math.max(1, meaningful.length);
  
  if (specificity > 0.5) {
    // Identifier-heavy: favor keyword
    return { semantic: 0.3, keyword: 0.7 };
  } else if (specificity > 0.2) {
    // Mixed: balanced
    return { semantic: 0.5, keyword: 0.5 };
  } else {
    // Conceptual: favor semantic
    return { semantic: 0.7, keyword: 0.3 };
  }
}
```

**Pros:**
- Adapts to query intent
- Best of both worlds

**Cons:**
- More complex
- Requires tuning per domain
- Classification heuristics may fail

### Option C: Anchor Term Boosting (Alternative)

Detect "anchor terms" in query and apply multiplicative boost:

```typescript
function searchHybrid(query: string, topK: number) {
  const anchors = extractAnchors(query); // e.g., ["D40"]
  const results = linearInterpolationSearch(query, topK * 2);
  
  // Boost exact anchor matches
  for (const result of results) {
    for (const anchor of anchors) {
      if (result.text.includes(anchor)) {
        result.score *= 1.5; // 50% boost for exact anchor match
      }
    }
  }
  
  return results.sort((a, b) => b.score - a.score).slice(0, topK);
}
```

**Pros:**
- Works with any base algorithm
- Surgical fix for identifier problem

**Cons:**
- Anchor detection is domain-specific
- Regex patterns need tuning

---

## Recommended Approach

### Phase 1: Immediate Fix (Option A)
Replace RRF with linear interpolation in the template:
- Location: `generateMcpServerSource()` in `src/tools/projects.ts`
- Change: Template `searchHybrid` function uses `0.7*semantic + 0.3*keyword`
- Scope: All newly exported projects get the fix

### Phase 2: Keyword-Only Fallback
Add detection for pure identifier queries:
- If query matches `/^[A-Z]\d+$/` pattern (single identifier)
- Use keyword-only search (ignore semantic)
- Avoids embedding API call for simple lookups

### Phase 3: Query Classification (Future)
Integrate with `indexfoundry_classify_query` tool:
- Reuse existing query classification logic
- Adapt search strategy based on query type
- Expose as template configuration option

---

## Implementation Contract

### Template Changes Required

**File:** `src/tools/projects.ts`  
**Function:** `generateMcpServerSource()` (lines 2928-3760)  
**Target:** Template `searchHybrid` function (embedded in template string)

**Current (Broken):**
```typescript
// Inside template string at ~line 3163
async function searchHybrid(query: string, topK: number) {
  const RRF_K = 60;
  // ... RRF logic
  rrfScores.set(r.chunk.chunk_id, ... + rrfScore * 0.5);
}
```

**Target (Fixed):**
```typescript
async function searchHybrid(query: string, topK: number) {
  const keywordResults = searchKeyword(query, topK * 2);
  
  let semanticResults: Array<{ chunk_id: string; score: number }> = [];
  if (vectors.length > 0) {
    try {
      const queryVector = await generateQueryEmbedding(query);
      semanticResults = searchSemantic(queryVector, topK * 2);
    } catch {
      return keywordResults.slice(0, topK);
    }
  } else {
    return keywordResults.slice(0, topK);
  }
  
  // Build lookup maps
  const keywordMap = new Map(keywordResults.map(r => [r.chunk.chunk_id, r.score]));
  const semanticMap = new Map(semanticResults.map(r => [r.chunk_id, r.score]));
  
  // Linear interpolation: 70% semantic + 30% keyword
  const allChunkIds = new Set([
    ...keywordResults.map(r => r.chunk.chunk_id),
    ...semanticResults.map(r => r.chunk_id)
  ]);
  
  const combined = Array.from(allChunkIds).map(chunk_id => {
    const chunk = chunkMap.get(chunk_id);
    if (!chunk) return null;
    
    const semanticScore = semanticMap.get(chunk_id) || 0;
    const keywordScore = keywordMap.get(chunk_id) || 0;
    const score = semanticScore * 0.7 + keywordScore * 0.3;
    
    return { chunk, score };
  }).filter((r): r is { chunk: Chunk; score: number } => r !== null);
  
  return combined.sort((a, b) => b.score - a.score).slice(0, topK);
}
```

---

## Acceptance Criteria

1. **Template generates valid TypeScript** - `npm run build` succeeds
2. **Keyword matches are preserved** - Exact identifier matches rank in top 3
3. **Semantic still contributes** - Conceptual queries return relevant results
4. **No breaking changes** - Existing `/search` and `/chat` endpoints work
5. **Regenerated projects work** - `project_export` produces functional servers

---

## Test Cases for Validation

| Query | Expected Top Result | Validation |
|-------|---------------------|------------|
| `"D40"` | Chunk containing "Region D40" | keyword_score = 1.0 |
| `"Tell me about D40"` | Chunk containing "Region D40" | Anchor term preserved |
| `"What are the safety requirements?"` | Safety-related chunks | semantic relevance |
| `"Aboleth"` | Monster stat block | Proper noun match |
| `"30 CFR 75.1725"` | Regulation text | Code identifier match |

---

## References

- RRF paper: Cormack et al., "Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods"
- Existing implementation: `projectQuery()` in `src/tools/projects.ts:739-744`
- Related: `indexfoundry_classify_query` for query type detection
