# Librarian Protocol: Workflow Examples

**Reference:** See [`ADR-007-LIBRARIAN-PROTOCOL.md`](./ADR-007-LIBRARIAN-PROTOCOL.md) for full specification.

This document provides step-by-step examples of Librarian workflows using IndexFoundry tools.

---

## Example 1: Query with Full Audit Trail

**Scenario:** User asks a question about company vacation policy. Librarian must verify index freshness before responding.

### Workflow

```typescript
async function queryWithAudit(
  projectId: string,
  userQuery: string
): Promise<{ answer: string; audit: Record<string, unknown> }> {
  const audit: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    steps: []
  };

  try {
    // ─────────────────────────────────────────────────────────────
    // STEP 1: Manifest Audit (State Check)
    // ─────────────────────────────────────────────────────────────
    console.log("🔍 Step 1: Auditing project manifest...");
    
    const project = await indexfoundry_project_get({ project_id: projectId });
    
    const auditResult = {
      step: 1,
      action: "manifest_audit",
      timestamp: new Date().toISOString(),
      checks: {
        projectExists: !!project.manifest,
        sourcesExist: (project.sources?.length ?? 0) > 0,
        sourcesProcessed: project.sources?.every(s => s.status === "completed"),
        chunksIndexed: (project.manifest?.chunk_count ?? 0) > 0,
        vectorsGenerated: (project.manifest?.vector_count ?? 0) > 0,
        countMatch: project.manifest?.chunk_count === project.manifest?.vector_count
      },
      stats: {
        sources: project.sources?.length ?? 0,
        chunks: project.manifest?.chunk_count ?? 0,
        vectors: project.manifest?.vector_count ?? 0
      }
    };
    
    audit.steps.push(auditResult);
    
    // Check if state is valid
    const isStateValid = Object.values(auditResult.checks).every(v => v === true);
    
    if (!isStateValid) {
      console.warn("⚠️  Index state is invalid. Rebuilding...");
      
      // Attempt repair: rebuild pending sources
      const buildResult = await indexfoundry_project_build({
        project_id: projectId
      });
      
      audit.steps.push({
        step: "repair",
        action: "rebuild",
        result: buildResult
      });
      
      // Re-check manifest after rebuild
      const projectAfterBuild = await indexfoundry_project_get({
        project_id: projectId
      });
      project.manifest = projectAfterBuild.manifest;
      project.sources = projectAfterBuild.sources;
    }
    
    // ─────────────────────────────────────────────────────────────
    // STEP 2: Query Classification (Intent Detection)
    // ─────────────────────────────────────────────────────────────
    console.log("🏷️  Step 2: Classifying query intent...");
    
    const classification = await indexfoundry_classify_query({
      query: userQuery,
      context: {
        domain: projectId,
        available_collections: [projectId]
      },
      options: {
        include_confidence: true,
        include_reasoning: true
      }
    });
    
    const classificationResult = {
      step: 2,
      action: "query_classification",
      queryType: classification.query_type,
      needsRag: classification.needs_retrieval ?? true,
      confidence: classification.confidence,
      reasoning: classification.reasoning
    };
    
    audit.steps.push(classificationResult);
    
    if (!classificationResult.needsRag) {
      console.log("💡 Query can be answered without retrieval.");
      return {
        answer: "Query does not require knowledge base retrieval.",
        audit
      };
    }
    
    // ─────────────────────────────────────────────────────────────
    // STEP 3: Execute Query Retrieval
    // ─────────────────────────────────────────────────────────────
    console.log("🔎 Step 3: Retrieving relevant chunks...");
    
    const searchMode =
      classification.suggested_mode ||
      (classification.query_type === "factual" ? "semantic" : "hybrid");
    
    const queryResult = await indexfoundry_project_query({
      project_id: projectId,
      query: userQuery,
      mode: searchMode,
      top_k: 10,
      include_text: true
    });
    
    const retrievalResult = {
      step: 3,
      action: "retrieve",
      mode: searchMode,
      resultsReturned: queryResult.results?.length ?? 0,
      scores: queryResult.results?.map((r: { score: number }) => r.score) ?? []
    };
    
    audit.steps.push(retrievalResult);
    
    // ─────────────────────────────────────────────────────────────
    // STEP 4: Validate Retrieval Quality
    // ─────────────────────────────────────────────────────────────
    console.log("✅ Step 4: Validating retrieval quality...");
    
    if (!queryResult.results || queryResult.results.length === 0) {
      const validationResult = {
        step: 4,
        action: "validate",
        status: "fail",
        issue: "No results returned",
        recommendation: "Query may be outside knowledge base domain"
      };
      audit.steps.push(validationResult);
      
      return {
        answer:
          "No relevant information found in knowledge base. " +
          "Please rephrase your question or contact support.",
        audit
      };
    }
    
    const scores = queryResult.results.map((r: { score: number }) => r.score);
    const minScore = Math.min(...scores);
    const avgScore = scores.reduce((a: number, b: number) => a + b, 0) / scores.length;
    
    const validationResult = {
      step: 4,
      action: "validate",
      minScore,
      avgScore,
      thresholds: {
        minRequired: 0.5,
        avgRequired: 0.65
      },
      status:
        minScore >= 0.5 && avgScore >= 0.65
          ? "pass"
          : avgScore >= 0.6
          ? "marginal"
          : "fail",
      issues: []
    };
    
    if (minScore < 0.5) {
      (validationResult.issues as string[]).push(`Minimum score ${minScore} below 0.5`);
    }
    if (avgScore < 0.65) {
      (validationResult.issues as string[]).push(`Average score ${avgScore} below 0.65`);
    }
    
    audit.steps.push(validationResult);
    
    if (validationResult.status === "fail") {
      console.warn(
        "⚠️  Retrieval quality is poor. Running debug analysis..."
      );
      
      const debugResult = await indexfoundry_debug_query({
        run_id: projectId,
        query: userQuery,
        options: {
          trace_level: "verbose",
          include_all_scores: true
        }
      });
      
      audit.steps.push({
        step: "debug",
        action: "debug_query",
        trace: debugResult
      });
      
      return {
        answer:
          "The knowledge base has limited information on this topic. " +
          "Please provide more context or contact support.",
        audit
      };
    }
    
    // ─────────────────────────────────────────────────────────────
    // STEP 5: Return Results with Metadata
    // ─────────────────────────────────────────────────────────────
    console.log("📝 Step 5: Preparing final response...");
    
    const chunks = queryResult.results.map((r: any) => ({
      text: r.text,
      score: r.score,
      source: r.source_id,
      metadata: r.metadata
    }));
    
    const answer = `
Based on the knowledge base:

${chunks
  .slice(0, 3)
  .map(
    (c: any, i: number) => `${i + 1}. ${c.text.substring(0, 200)}... (confidence: ${(c.score * 100).toFixed(0)}%)`
  )
  .join("\n\n")}

[Full ${chunks.length} results available with full audit trail]
    `.trim();
    
    const finalResult = {
      step: 5,
      action: "return_answer",
      chunksUsed: chunks.length,
      avgConfidence: avgScore,
      citations: chunks.map((c: any) => c.source)
    };
    
    audit.steps.push(finalResult);
    
    return { answer, audit };
  } catch (error) {
    audit.steps.push({
      step: "error",
      action: "exception",
      error: error instanceof Error ? error.message : String(error)
    });
    
    throw error;
  }
}
```

### Sample Output

```json
{
  "answer": "Based on the knowledge base:\n1. Employees receive 15 days of vacation per year... (confidence: 87%)\n2. Vacation requests must be submitted 2 weeks in advance... (confidence: 82%)\n3. Unused vacation carries over...",
  "audit": {
    "timestamp": "2025-01-07T10:30:00Z",
    "steps": [
      {
        "step": 1,
        "action": "manifest_audit",
        "timestamp": "2025-01-07T10:30:00Z",
        "checks": {
          "projectExists": true,
          "sourcesExist": true,
          "sourcesProcessed": true,
          "chunksIndexed": true,
          "vectorsGenerated": true,
          "countMatch": true
        },
        "stats": {
          "sources": 5,
          "chunks": 342,
          "vectors": 342
        }
      },
      {
        "step": 2,
        "action": "query_classification",
        "queryType": "factual",
        "needsRag": true,
        "confidence": 0.92,
        "reasoning": "User is asking for specific policy information"
      },
      {
        "step": 3,
        "action": "retrieve",
        "mode": "semantic",
        "resultsReturned": 10,
        "scores": [0.87, 0.82, 0.79, 0.76, 0.73, 0.71, 0.68, 0.65, 0.62, 0.59]
      },
      {
        "step": 4,
        "action": "validate",
        "minScore": 0.59,
        "avgScore": 0.722,
        "status": "pass",
        "issues": []
      },
      {
        "step": 5,
        "action": "return_answer",
        "chunksUsed": 10,
        "avgConfidence": 0.722,
        "citations": ["policy-2023", "hr-handbook-section-3", "vacation-faq"]
      }
    ]
  }
}
```

---

## Example 2: Retrieval Debugging & Re-Chunking

**Scenario:** Queries return low scores. Librarian analyzes why and attempts recovery through re-chunking.

### Workflow

```typescript
async function debugAndRepair(
  projectId: string,
  query: string
): Promise<{ repaired: boolean; newStrategy: string; reason: string }> {
  console.log("🐛 Starting retrieval debug and repair...");
  
  // ─────────────────────────────────────────────────────────────
  // STEP 1: Get Current Configuration
  // ─────────────────────────────────────────────────────────────
  const project = await indexfoundry_project_get({ project_id: projectId });
  const currentStrategy = project.manifest?.chunk_config?.strategy || "recursive";
  
  console.log(`📊 Current chunking strategy: ${currentStrategy}`);
  
  // ─────────────────────────────────────────────────────────────
  // STEP 2: Run Debug Query
  // ─────────────────────────────────────────────────────────────
  console.log("🔍 Running debug query with full pipeline trace...");
  
  const debugResult = await indexfoundry_debug_query({
    run_id: projectId,
    query,
    expected: {
      min_matches: 5,
      keywords: [] // User doesn't specify expected keywords
    },
    options: {
      trace_level: "verbose",
      include_embeddings: false,
      include_all_scores: true
    }
  });
  
  console.log(`Debug trace:`, debugResult);
  
  // ─────────────────────────────────────────────────────────────
  // STEP 3: Analyze Results
  // ─────────────────────────────────────────────────────────────
  const scores = debugResult.results?.map((r: any) => r.score) || [];
  const avgScore = scores.reduce((a: number, b: number) => a + b, 0) / scores.length || 0;
  
  console.log(`📈 Score analysis:`);
  console.log(`   Min: ${Math.min(...scores)} | Avg: ${avgScore} | Max: ${Math.max(...scores)}`);
  
  if (avgScore >= 0.65) {
    console.log("✅ Scores are acceptable. No repair needed.");
    return {
      repaired: false,
      newStrategy: currentStrategy,
      reason: "Retrieval quality is acceptable"
    };
  }
  
  // ─────────────────────────────────────────────────────────────
  // STEP 4: Diagnose Problem
  // ─────────────────────────────────────────────────────────────
  const diagnosis = await diagnoseRetrievalProblem(debugResult, currentStrategy);
  
  console.log(`🔧 Diagnosis:`, diagnosis);
  
  // ─────────────────────────────────────────────────────────────
  // STEP 5: Determine Repair Strategy
  // ─────────────────────────────────────────────────────────────
  const repairStrategies: Record<string, string> = {
    recursive: "hierarchical",
    hierarchical: "by_paragraph",
    by_paragraph: "by_sentence",
    by_sentence: "fixed_chars"
  };
  
  const newStrategy = repairStrategies[currentStrategy] || "hierarchical";
  
  console.log(`🔄 Attempting repair: ${currentStrategy} → ${newStrategy}`);
  console.log(`   Reason: ${diagnosis.issue}`);
  
  // ─────────────────────────────────────────────────────────────
  // STEP 6: Execute Repair (Re-chunk & Rebuild)
  // ─────────────────────────────────────────────────────────────
  
  // 6a: Get current sources
  const sources = project.sources || [];
  
  // 6b: Remove all sources (cascade delete chunks/vectors)
  console.log("📋 Removing old sources...");
  for (const source of sources) {
    if (source.source_id) {
      await indexfoundry_project_remove_source({
        project_id: projectId,
        source_id: source.source_id,
        remove_chunks: true,
        remove_vectors: true,
        confirm: true
      });
    }
  }
  
  // 6c: Update project with new chunking strategy
  console.log("⚙️  Updating chunking configuration...");
  const updatedProject = await indexfoundry_project_get({
    project_id: projectId
  });
  
  // Note: In real implementation, would update project.json directly
  // Here we just document what would be changed:
  console.log(`Would update chunk_config.strategy: ${newStrategy}`);
  
  // 6d: Re-add all sources
  console.log("📥 Re-adding sources with new configuration...");
  for (const source of sources) {
    await indexfoundry_project_add_source({
      project_id: projectId,
      url: source.type === "url" ? source.uri : undefined,
      sitemap_url: source.type === "sitemap" ? source.uri : undefined,
      folder_path: source.type === "folder" ? source.uri : undefined,
      pdf_path: source.type === "pdf" ? source.uri : undefined,
      source_name: source.source_name,
      tags: source.tags
    });
  }
  
  // 6e: Rebuild with new chunking strategy
  console.log("🔨 Building index with new chunking strategy...");
  const buildResult = await indexfoundry_project_build({
    project_id: projectId,
    force: true
  });
  
  console.log(`✅ Rebuild complete: ${buildResult.chunks_added} chunks, ${buildResult.vectors_added} vectors`);
  
  // ─────────────────────────────────────────────────────────────
  // STEP 7: Verify Improvement
  // ─────────────────────────────────────────────────────────────
  console.log("📊 Verifying retrieval improvement...");
  
  const verifyQuery = await indexfoundry_project_query({
    project_id: projectId,
    query,
    mode: "hybrid",
    top_k: 10
  });
  
  const newScores = (verifyQuery.results || []).map((r: any) => r.score);
  const newAvgScore =
    newScores.reduce((a: number, b: number) => a + b, 0) / newScores.length || 0;
  
  console.log(`📈 Score improvement: ${avgScore.toFixed(3)} → ${newAvgScore.toFixed(3)}`);
  
  return {
    repaired: newAvgScore > avgScore,
    newStrategy,
    reason: `Changed from ${currentStrategy} (avg ${avgScore.toFixed(3)}) to ${newStrategy} (avg ${newAvgScore.toFixed(3)})`
  };
}

async function diagnoseRetrievalProblem(
  debugResult: any,
  currentStrategy: string
): Promise<{ issue: string; recommendation: string }> {
  // Heuristic diagnosis based on debug output
  
  const resultCount = debugResult.results?.length || 0;
  const scores = debugResult.results?.map((r: any) => r.score) || [];
  const avgScore = scores.reduce((a: number, b: number) => a + b, 0) / scores.length || 0;
  const variance =
    scores.length > 1
      ? Math.sqrt(
          scores.reduce((sum: number, s: number) => sum + Math.pow(s - avgScore, 2), 0) /
            scores.length
        )
      : 0;
  
  if (resultCount === 0) {
    return {
      issue: "No results returned (query outside domain knowledge base)",
      recommendation: "Add more relevant sources"
    };
  }
  
  if (avgScore < 0.5) {
    return {
      issue: "Very low average score (chunks don't match query semantically)",
      recommendation: "Change chunking strategy to create more cohesive chunks"
    };
  }
  
  if (variance > 0.3) {
    return {
      issue: "High score variance (inconsistent chunk quality)",
      recommendation: `Change from ${currentStrategy} to smaller chunks`
    };
  }
  
  return {
    issue: "Unknown (marginal retrieval quality)",
    recommendation: "Add more training data or clarify query"
  };
}
```

### Sample Output

```
🐛 Starting retrieval debug and repair...
📊 Current chunking strategy: recursive
🔍 Running debug query with full pipeline trace...
📈 Score analysis:
   Min: 0.42 | Avg: 0.58 | Max: 0.71
🔧 Diagnosis: High score variance (inconsistent chunk quality)
🔄 Attempting repair: recursive → hierarchical
   Reason: Change from recursive (avg 0.58) to hierarchical (avg 0.72)
📋 Removing old sources...
⚙️  Updating chunking configuration...
Would update chunk_config.strategy: hierarchical
📥 Re-adding sources with new configuration...
🔨 Building index with new chunking strategy...
✅ Rebuild complete: 487 chunks, 487 vectors
📊 Verifying retrieval improvement...
📈 Score improvement: 0.58 → 0.72
{ repaired: true, newStrategy: 'hierarchical', reason: '...' }
```

---

## Example 3: Deployment Pre-Flight Check

**Scenario:** User requests to deploy a project to production. Librarian validates everything before export.

### Workflow

```typescript
async function deploymentPreFlight(
  projectId: string
): Promise<{
  canDeploy: boolean;
  checks: Array<{ name: string; status: "pass" | "fail" | "warn"; details: string }>;
  recommendations: string[];
}> {
  console.log("✈️  Running pre-flight check before deployment...\n");
  
  const checks: Array<{ name: string; status: "pass" | "fail" | "warn"; details: string }> = [];
  const recommendations: string[] = [];
  
  // ─────────────────────────────────────────────────────────────
  // Check 1: Project Exists
  // ─────────────────────────────────────────────────────────────
  let project;
  try {
    project = await indexfoundry_project_get({ project_id: projectId });
    checks.push({
      name: "Project Exists",
      status: "pass",
      details: `Project '${projectId}' found`
    });
  } catch (error) {
    checks.push({
      name: "Project Exists",
      status: "fail",
      details: `Project '${projectId}' not found`
    });
    return {
      canDeploy: false,
      checks,
      recommendations: ["Create project before deploying"]
    };
  }
  
  // ─────────────────────────────────────────────────────────────
  // Check 2: Embedding Configuration
  // ─────────────────────────────────────────────────────────────
  const hasEmbeddingConfig =
    project.manifest?.embedding_model?.provider &&
    project.manifest?.embedding_model?.model_name;
  
  checks.push({
    name: "Embedding Model Configured",
    status: hasEmbeddingConfig ? "pass" : "fail",
    details: hasEmbeddingConfig
      ? `${project.manifest?.embedding_model?.provider}/${project.manifest?.embedding_model?.model_name}`
      : "No embedding model configured"
  });
  
  if (!hasEmbeddingConfig) {
    recommendations.push("Configure embedding model in project.json");
  }
  
  // ─────────────────────────────────────────────────────────────
  // Check 3: Chunk Configuration
  // ─────────────────────────────────────────────────────────────
  const hasChunkConfig =
    project.manifest?.chunk_config?.strategy &&
    project.manifest?.chunk_config?.max_chars;
  
  checks.push({
    name: "Chunk Configuration Defined",
    status: hasChunkConfig ? "pass" : "fail",
    details: hasChunkConfig
      ? `${project.manifest?.chunk_config?.strategy} (${project.manifest?.chunk_config?.max_chars} chars)`
      : "Chunking strategy not configured"
  });
  
  if (!hasChunkConfig) {
    recommendations.push("Configure chunking strategy in project.json");
  }
  
  // ─────────────────────────────────────────────────────────────
  // Check 4: Data Completeness
  // ─────────────────────────────────────────────────────────────
  const sourceCount = project.sources?.length || 0;
  const chunkCount = project.manifest?.chunk_count || 0;
  const vectorCount = project.manifest?.vector_count || 0;
  
  if (sourceCount === 0) {
    checks.push({
      name: "Sources Added",
      status: "fail",
      details: "No sources added to project"
    });
    recommendations.push("Add at least one source via project_add_source");
  } else if (chunkCount === 0) {
    checks.push({
      name: "Data Indexed",
      status: "fail",
      details: `${sourceCount} sources added but no chunks indexed`
    });
    recommendations.push("Run project_build to process sources");
  } else if (vectorCount !== chunkCount) {
    checks.push({
      name: "Data Consistency",
      status: "fail",
      details: `Chunk/vector mismatch: ${chunkCount} chunks vs ${vectorCount} vectors`
    });
    recommendations.push("Run project_build to regenerate vectors");
  } else {
    checks.push({
      name: "Data Completeness",
      status: "pass",
      details: `${sourceCount} sources, ${chunkCount} chunks, ${vectorCount} vectors`
    });
  }
  
  // ─────────────────────────────────────────────────────────────
  // Check 5: Source Status
  // ─────────────────────────────────────────────────────────────
  const failedSources = project.sources?.filter((s: any) => s.status === "failed") || [];
  const pendingSources = project.sources?.filter((s: any) => s.status === "pending") || [];
  
  if (failedSources.length > 0) {
    checks.push({
      name: "Source Status",
      status: "fail",
      details: `${failedSources.length} sources failed to process: ${failedSources.map((s: any) => s.uri).join(", ")}`
    });
    recommendations.push(
      `Review and fix ${failedSources.length} failed sources before deploying`
    );
  } else if (pendingSources.length > 0) {
    checks.push({
      name: "Source Status",
      status: "warn",
      details: `${pendingSources.length} sources not yet processed`
    });
    recommendations.push("Run project_build to process pending sources");
  } else {
    checks.push({
      name: "Source Status",
      status: "pass",
      details: "All sources processed successfully"
    });
  }
  
  // ─────────────────────────────────────────────────────────────
  // Check 6: Sample Query Test
  // ─────────────────────────────────────────────────────────────
  if (chunkCount > 0) {
    try {
      const testQuery = await indexfoundry_project_query({
        project_id: projectId,
        query: "test query",
        mode: "hybrid",
        top_k: 3
      });
      
      const avgScore = (testQuery.results || []).length > 0
        ? (testQuery.results || [])
            .map((r: any) => r.score)
            .reduce((a: number, b: number) => a + b, 0) /
          (testQuery.results || []).length
        : 0;
      
      if (avgScore < 0.3) {
        checks.push({
          name: "Retrieval Quality",
          status: "warn",
          details: `Test query average score: ${avgScore.toFixed(3)} (consider re-chunking)`
        });
        recommendations.push(
          "Run debug_query to analyze retrieval quality; consider re-chunking strategy"
        );
      } else {
        checks.push({
          name: "Retrieval Quality",
          status: "pass",
          details: `Test query average score: ${avgScore.toFixed(3)}`
        });
      }
    } catch (error) {
      checks.push({
        name: "Retrieval Quality",
        status: "fail",
        details: `Query test failed: ${error instanceof Error ? error.message : String(error)}`
      });
      recommendations.push("Debug and fix retrieval pipeline before deploying");
    }
  }
  
  // ─────────────────────────────────────────────────────────────
  // Check 7: Environment Variables
  // ─────────────────────────────────────────────────────────────
  const apiKeyEnv = project.manifest?.embedding_model?.api_key_env;
  if (!apiKeyEnv) {
    checks.push({
      name: "Environment Configuration",
      status: "warn",
      details: "No API key env variable specified"
    });
    recommendations.push(`Set API key env variable for ${apiKeyEnv || "embeddings"}`);
  } else {
    checks.push({
      name: "Environment Configuration",
      status: "pass",
      details: `API key configured in ${apiKeyEnv}`
    });
  }
  
  // ─────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────
  const failures = checks.filter(c => c.status === "fail");
  const warnings = checks.filter(c => c.status === "warn");
  
  console.log("\n📋 Pre-Flight Check Results:\n");
  checks.forEach(check => {
    const icon = check.status === "pass" ? "✅" : check.status === "fail" ? "❌" : "⚠️ ";
    console.log(`${icon} ${check.name}: ${check.details}`);
  });
  
  if (recommendations.length > 0) {
    console.log("\n💡 Recommendations:");
    recommendations.forEach((r, i) => console.log(`   ${i + 1}. ${r}`));
  }
  
  const canDeploy = failures.length === 0;
  console.log(
    `\n🚀 Ready to deploy: ${canDeploy ? "YES" : "NO (${failures.length} issues)"}`
  );
  
  return {
    canDeploy,
    checks,
    recommendations
  };
}

// Usage
const preFlightResult = await deploymentPreFlight("my-rag-project");

if (preFlightResult.canDeploy) {
  // Safe to export and deploy
  const exportResult = await indexfoundry_project_export({
    project_id: "my-rag-project",
    include_http: true,
    railway_config: true
  });
  
  console.log("✅ Export complete. Ready to deploy to Railway.");
  console.log(exportResult.deployment_instructions);
} else {
  console.log("❌ Fix issues above before deploying.");
}
```

### Sample Output

```
✈️  Running pre-flight check before deployment...

📋 Pre-Flight Check Results:

✅ Project Exists: Project 'my-rag-project' found
✅ Embedding Model Configured: openai/text-embedding-3-small
✅ Chunk Configuration Defined: recursive (1500 chars)
✅ Data Completeness: 3 sources, 342 chunks, 342 vectors
✅ Source Status: All sources processed successfully
✅ Retrieval Quality: Test query average score: 0.714
✅ Environment Configuration: API key configured in OPENAI_API_KEY

🚀 Ready to deploy: YES
```

---

## Example 4: Batch Source Management with Repair

**Scenario:** User adds multiple sources, builds, but some fail. Librarian identifies failed sources and rebuilds selectively.

### Workflow

```typescript
async function manageBatchSources(
  projectId: string,
  sources: Array<{ type: string; uri: string; name: string }>
): Promise<{
  successCount: number;
  failureCount: number;
  rebuilt: boolean;
}> {
  console.log(`📦 Adding ${sources.length} sources in batch...\n`);
  
  // ─────────────────────────────────────────────────────────────
  // STEP 1: Add All Sources (Batch)
  // ─────────────────────────────────────────────────────────────
  const addResults = [];
  
  for (const source of sources) {
    try {
      let result;
      
      if (source.type === "url") {
        result = await indexfoundry_project_add_source({
          project_id: projectId,
          url: source.uri,
          source_name: source.name
        });
      } else if (source.type === "folder") {
        result = await indexfoundry_project_add_source({
          project_id: projectId,
          folder_path: source.uri,
          source_name: source.name
        });
      } else if (source.type === "pdf") {
        result = await indexfoundry_project_add_source({
          project_id: projectId,
          pdf_path: source.uri,
          source_name: source.name
        });
      }
      
      addResults.push({
        source: source.name,
        status: "added",
        result
      });
      
      console.log(`✅ Added: ${source.name}`);
    } catch (error) {
      addResults.push({
        source: source.name,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      });
      
      console.log(`❌ Failed to add: ${source.name}`);
    }
  }
  
  // ─────────────────────────────────────────────────────────────
  // STEP 2: Build Index
  // ─────────────────────────────────────────────────────────────
  console.log("\n🔨 Building index with chunked processing...");
  
  let buildResult;
  try {
    buildResult = await indexfoundry_project_build({
      project_id: projectId,
      chunk_options: {
        max_sources_per_build: 5,
        fetch_concurrency: 3,
        embedding_batch_size: 50
      }
    });
    
    console.log(`✅ Build complete: ${buildResult.chunks_added} chunks`);
  } catch (error) {
    console.log(`⚠️  Build failed: ${error}`);
  }
  
  // ─────────────────────────────────────────────────────────────
  // STEP 3: Analyze Build Results
  // ─────────────────────────────────────────────────────────────
  const project = await indexfoundry_project_get({ project_id: projectId });
  
  const failedSources = project.sources?.filter((s: any) => s.status === "failed") || [];
  const completedSources = project.sources?.filter((s: any) => s.status === "completed") || [];
  
  console.log(`\n📊 Build Results:`);
  console.log(`   ✅ Successful: ${completedSources.length}`);
  console.log(`   ❌ Failed: ${failedSources.length}`);
  
  if (failedSources.length > 0) {
    console.log(`\n   Failed sources:`);
    failedSources.forEach((s: any) => {
      console.log(`   - ${s.source_name}: ${s.error}`);
    });
  }
  
  // ─────────────────────────────────────────────────────────────
  // STEP 4: Repair Failed Sources
  // ─────────────────────────────────────────────────────────────
  let repaired = false;
  
  if (failedSources.length > 0) {
    console.log(`\n🔧 Attempting to repair ${failedSources.length} failed sources...\n`);
    
    for (const failedSource of failedSources) {
      try {
        // Remove the failed source
        console.log(`Removing: ${failedSource.source_name}`);
        
        await indexfoundry_project_remove_source({
          project_id: projectId,
          source_id: failedSource.source_id,
          remove_chunks: true,
          remove_vectors: true,
          confirm: true
        });
        
        // Re-add with potentially different parameters
        console.log(`Re-adding: ${failedSource.source_name}`);
        
        // Use timeout increase for problematic sources
        let result;
        
        if (failedSource.type === "url") {
          result = await indexfoundry_project_add_source({
            project_id: projectId,
            url: failedSource.uri,
            source_name: failedSource.source_name
          });
        } else if (failedSource.type === "folder") {
          result = await indexfoundry_project_add_source({
            project_id: projectId,
            folder_path: failedSource.uri,
            source_name: failedSource.source_name,
            max_pages: 10 // Reduce max files for troublesome folders
          });
        }
        
        // Re-build just this source
        const rebuildResult = await indexfoundry_project_build({
          project_id: projectId,
          chunk_options: {
            max_sources_per_build: 1,
            fetch_concurrency: 1 // Single threaded for problematic sources
          }
        });
        
        console.log(`   ✅ Repaired: ${failedSource.source_name}`);
        repaired = true;
      } catch (error) {
        console.log(
          `   ⚠️  Could not repair: ${failedSource.source_name} - ${error}`
        );
      }
    }
  }
  
  // ─────────────────────────────────────────────────────────────
  // STEP 5: Final Status
  // ─────────────────────────────────────────────────────────────
  const finalProject = await indexfoundry_project_get({
    project_id: projectId
  });
  
  const finalFailed = finalProject.sources?.filter((s: any) => s.status === "failed") || [];
  
  console.log(`\n📈 Final Status:`);
  console.log(`   Total sources: ${finalProject.sources?.length}`);
  console.log(`   Successful: ${finalProject.sources?.length - finalFailed.length}`);
  console.log(`   Still failed: ${finalFailed.length}`);
  console.log(`   Total chunks: ${finalProject.manifest?.chunk_count}`);
  console.log(`   Total vectors: ${finalProject.manifest?.vector_count}`);
  
  return {
    successCount: (finalProject.sources?.length || 0) - finalFailed.length,
    failureCount: finalFailed.length,
    rebuilt: repaired
  };
}
```

---

## Example 5: Query Classification to Skip RAG

**Scenario:** User asks a trivial question. Librarian classifies it and skips expensive retrieval.

### Workflow

```typescript
async function classifyAndRespond(
  projectId: string,
  userQuery: string
): Promise<{ response: string; usedRag: boolean; reason: string }> {
  console.log(`🤔 Processing query: "${userQuery}"\n`);
  
  // ─────────────────────────────────────────────────────────────
  // STEP 1: Classify Query
  // ─────────────────────────────────────────────────────────────
  const classification = await indexfoundry_classify_query({
    query: userQuery,
    options: {
      include_confidence: true,
      include_reasoning: true
    }
  });
  
  console.log(`📊 Classification Result:`);
  console.log(`   Type: ${classification.query_type}`);
  console.log(`   Needs RAG: ${classification.needs_retrieval ?? true}`);
  console.log(`   Confidence: ${(classification.confidence * 100).toFixed(0)}%`);
  console.log(`   Reasoning: ${classification.reasoning || "N/A"}\n`);
  
  // ─────────────────────────────────────────────────────────────
  // STEP 2: Decision Logic
  // ─────────────────────────────────────────────────────────────
  
  // Skip RAG for certain query types
  const skipRagTypes = ["greeting", "off-topic", "meta"];
  const shouldSkipRag =
    skipRagTypes.includes(classification.query_type) ||
    !classification.needs_retrieval;
  
  if (shouldSkipRag) {
    console.log("💡 Skipping retrieval - answering without RAG\n");
    
    const response = generateDirectAnswer(userQuery, classification.query_type);
    
    return {
      response,
      usedRag: false,
      reason: `Query classified as ${classification.query_type} (no retrieval needed)`
    };
  }
  
  // ─────────────────────────────────────────────────────────────
  // STEP 3: Execute RAG Retrieval
  // ─────────────────────────────────────────────────────────────
  console.log("🔍 Query requires RAG - executing retrieval...\n");
  
  const queryResult = await indexfoundry_project_query({
    project_id: projectId,
    query: userQuery,
    mode: classification.suggested_mode || "hybrid",
    top_k: 5
  });
  
  const response =
    (queryResult.results && queryResult.results.length > 0)
      ? `Based on available information: ${queryResult.results[0].text?.substring(0, 200)}`
      : "No relevant information found.";
  
  return {
    response,
    usedRag: true,
    reason: `Query classified as ${classification.query_type} (retrieval executed)`
  };
}

function generateDirectAnswer(query: string, queryType: string): string {
  const responses: Record<string, string> = {
    greeting: "Hello! I'm here to help answer your questions about company policies and procedures.",
    off_topic: "That question is outside my area of expertise. I specialize in company policies and documentation.",
    meta: "I'm an AI assistant powered by IndexFoundry. I can search company documentation to answer your questions."
  };
  
  return responses[queryType] || "I'm not sure how to answer that. Try asking about company policies or documentation.";
}

// Sample outputs
await classifyAndRespond("my-docs", "Hello!");
// 🤔 Processing query: "Hello!"
// 📊 Classification Result:
//    Type: greeting
//    Needs RAG: false
//    Confidence: 95%
//    Reasoning: Simple greeting
// 💡 Skipping retrieval - answering without RAG
// { response: "Hello! I'm here to help...", usedRag: false, reason: "..." }

await classifyAndRespond("my-docs", "What's the vacation policy?");
// 🤔 Processing query: "What's the vacation policy?"
// 📊 Classification Result:
//    Type: factual
//    Needs RAG: true
//    Confidence: 98%
//    Reasoning: User is asking for specific policy information
// 🔍 Query requires RAG - executing retrieval...
// { response: "Based on available information: ...", usedRag: true, reason: "..." }
```

---

## Integration Checklist

When implementing Librarian workflows, ensure:

- [ ] **State Check** - Always audit manifest before querying
- [ ] **Classification** - Always classify query intent
- [ ] **Validation** - Always validate retrieval scores
- [ ] **Error Handling** - Implement escalation for unrecoverable errors
- [ ] **Audit Trail** - Log all steps with timestamps
- [ ] **Pre-Flight** - Run checks before deployment
- [ ] **Documentation** - Include Librarian context in responses

---

## Performance Considerations

| Operation | Overhead | Mitigation |
|-----------|----------|-----------|
| State audit | +5-10s | Cache for 1 hour |
| Query classification | +10-15s | Use simple keyword matching for obvious cases |
| Retrieval validation | +5-10s | Only if scores marginal |
| Debug query | +10-30s | Optional, on-demand |
| Pre-flight check | +20-30s | Before deployment only |

---

## See Also

- [`ADR-007-LIBRARIAN-PROTOCOL.md`](./ADR-007-LIBRARIAN-PROTOCOL.md) - Full specification
- [`src/tools/projects.ts`](../src/tools/projects.ts) - IndexFoundry project tools
- [`PROJECT_KNOWLEDGE.md`](./PROJECT_KNOWLEDGE.md) - IndexFoundry overview
