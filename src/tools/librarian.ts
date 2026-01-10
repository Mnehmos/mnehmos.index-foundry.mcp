/**
 * IndexFoundry-MCP: Librarian Protocol Tools
 * 
 * Implements the Librarian Protocol (ADR-007) for active data curation.
 * Provides state auditing, quality assessment, and self-correction utilities.
 * 
 * The Librarian Protocol adds:
 * - Pre-query state validation
 * - Quality assessment with score thresholds
 * - Self-correction recommendations
 * - Audit trail generation
 * 
 * Copyright (c) 2024 vario.automation
 * Proprietary and confidential. All rights reserved.
 */

import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import {
  LibrarianStateAudit,
  LibrarianQualityAssessment,
  LibrarianThresholds,
  DEFAULT_LIBRARIAN_THRESHOLDS,
  QueryClassification,
} from "../types.js";

// ============================================================================
// Schema for Librarian Audit Tool
// ============================================================================

export const LibrarianAuditSchema = z.object({
  project_id: z.string().min(1).max(64).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/)
    .describe("Project ID to audit"),
  
  include_recommendations: z.boolean().default(true)
    .describe("Include actionable recommendations in response"),
  
  thresholds: z.object({
    min_chunk_score: z.number().min(0).max(1).default(0.50),
    avg_result_score: z.number().min(0).max(1).default(0.65),
    classification_confidence: z.number().min(0).max(1).default(0.50),
  }).optional()
    .describe("Custom thresholds for quality gates"),
});

export type LibrarianAuditInput = z.infer<typeof LibrarianAuditSchema>;

// ============================================================================
// Schema for Librarian Assess Quality Tool
// ============================================================================

export const LibrarianAssessSchema = z.object({
  query: z.string().min(1).max(4096)
    .describe("Query that was executed"),
  
  results: z.array(z.object({
    chunk_id: z.string().optional(),
    score: z.number().min(0).max(1),
    text: z.string().optional(),
    source_id: z.string().optional(),
  }))
    .describe("Query results to assess"),
  
  thresholds: z.object({
    min_chunk_score: z.number().min(0).max(1).default(0.50),
    avg_result_score: z.number().min(0).max(1).default(0.65),
  }).optional()
    .describe("Custom thresholds for quality assessment"),
});

export type LibrarianAssessInput = z.infer<typeof LibrarianAssessSchema>;

// ============================================================================
// Helper: Get projects directory
// ============================================================================

let projectsDir: string = "./projects";

export function initLibrarian(baseDir: string): void {
  projectsDir = path.join(baseDir, "projects");
}

// ============================================================================
// Librarian Audit Implementation
// ============================================================================

export async function librarianAudit(
  input: LibrarianAuditInput
): Promise<{ success: true; audit: LibrarianStateAudit } | { success: false; error: string; code: string }> {
  const { project_id, include_recommendations } = input;
  const thresholds = input.thresholds ?? DEFAULT_LIBRARIAN_THRESHOLDS;
  
  const projectPath = path.join(projectsDir, project_id);
  const timestamp = new Date().toISOString();
  
  // Initialize audit result
  const audit: LibrarianStateAudit = {
    project_id,
    timestamp,
    manifest_exists: false,
    manifest_valid: false,
    total_sources: 0,
    pending_sources: 0,
    failed_sources: 0,
    processed_sources: 0,
    total_chunks: 0,
    total_vectors: 0,
    vectors_stale: false,
    server_running: false,
    is_healthy: false,
    issues: [],
    recommendations: [],
  };
  
  try {
    // Check if project directory exists
    if (!fs.existsSync(projectPath)) {
      return {
        success: false,
        error: `Project '${project_id}' not found at ${projectPath}`,
        code: "PROJECT_NOT_FOUND",
      };
    }
    
    // Check manifest
    const manifestPath = path.join(projectPath, "project.json");
    if (fs.existsSync(manifestPath)) {
      audit.manifest_exists = true;
      try {
        const manifestContent = fs.readFileSync(manifestPath, "utf-8");
        const manifest = JSON.parse(manifestContent);
        audit.manifest_valid = !!(manifest.project_id && manifest.name);
        
        if (!audit.manifest_valid) {
          audit.issues.push("Manifest is missing required fields (project_id, name)");
        }
      } catch {
        audit.issues.push("Manifest exists but is not valid JSON");
      }
    } else {
      audit.issues.push("Project manifest (project.json) not found");
    }
    
    // Check sources
    const sourcesPath = path.join(projectPath, "sources.jsonl");
    if (fs.existsSync(sourcesPath)) {
      try {
        const sourcesContent = fs.readFileSync(sourcesPath, "utf-8");
        const lines = sourcesContent.trim().split("\n").filter(l => l.trim());
        
        for (const line of lines) {
          try {
            const source = JSON.parse(line);
            audit.total_sources++;
            
            if (source.status === "pending") {
              audit.pending_sources++;
            } else if (source.status === "failed") {
              audit.failed_sources++;
            } else if (source.status === "processed") {
              audit.processed_sources++;
            }
          } catch {
            // Skip invalid lines
          }
        }
        
        if (audit.pending_sources > 0) {
          audit.issues.push(`${audit.pending_sources} source(s) pending - need to run project_build`);
        }
        if (audit.failed_sources > 0) {
          audit.issues.push(`${audit.failed_sources} source(s) failed - may need to remove and re-add`);
        }
      } catch {
        audit.issues.push("Could not read sources.jsonl");
      }
    } else if (audit.manifest_exists) {
      audit.issues.push("No sources added - use project_add_source");
    }
    
    // Check chunks
    const chunksPath = path.join(projectPath, "data", "chunks.jsonl");
    if (fs.existsSync(chunksPath)) {
      try {
        const chunksContent = fs.readFileSync(chunksPath, "utf-8");
        const lines = chunksContent.trim().split("\n").filter(l => l.trim());
        audit.total_chunks = lines.length;
      } catch {
        audit.issues.push("Could not read chunks.jsonl");
      }
    } else if (audit.processed_sources > 0) {
      audit.issues.push("Sources processed but no chunks found - data may be corrupted");
    }
    
    // Check vectors
    const vectorsPath = path.join(projectPath, "data", "vectors.jsonl");
    if (fs.existsSync(vectorsPath)) {
      try {
        const vectorsContent = fs.readFileSync(vectorsPath, "utf-8");
        const lines = vectorsContent.trim().split("\n").filter(l => l.trim());
        audit.total_vectors = lines.length;
        
        // Check if vectors match chunks
        if (audit.total_vectors < audit.total_chunks) {
          audit.vectors_stale = true;
          audit.issues.push(`Vector count (${audit.total_vectors}) < chunk count (${audit.total_chunks}) - vectors may be stale`);
        }
      } catch {
        audit.issues.push("Could not read vectors.jsonl");
      }
    } else if (audit.total_chunks > 0) {
      audit.issues.push("Chunks exist but no vectors found - need to run project_build");
    }
    
    // Check server status
    const pidPath = path.join(projectPath, ".server.pid");
    if (fs.existsSync(pidPath)) {
      try {
        const pidContent = fs.readFileSync(pidPath, "utf-8").trim();
        const pid = parseInt(pidContent, 10);
        if (!isNaN(pid)) {
          // Try to check if process is running
          try {
            process.kill(pid, 0); // Signal 0 just checks if process exists
            audit.server_running = true;
          } catch {
            // Process not running, stale PID file
            audit.issues.push("Stale PID file found - server crashed or was killed");
          }
        }
      } catch {
        // Ignore PID read errors
      }
    }
    
    // Calculate overall health
    audit.is_healthy = 
      audit.manifest_valid &&
      audit.pending_sources === 0 &&
      audit.failed_sources === 0 &&
      audit.total_chunks > 0 &&
      audit.total_vectors === audit.total_chunks &&
      !audit.vectors_stale;
    
    // Generate recommendations if requested
    if (include_recommendations) {
      if (!audit.manifest_exists) {
        audit.recommendations.push("Create project with project_create");
      } else if (audit.total_sources === 0) {
        audit.recommendations.push("Add sources with project_add_source");
      } else if (audit.pending_sources > 0) {
        audit.recommendations.push("Process pending sources with project_build");
      } else if (audit.failed_sources > 0) {
        audit.recommendations.push("Remove failed sources with project_remove_source and re-add");
      } else if (audit.total_chunks === 0) {
        audit.recommendations.push("Run project_build to create chunks and vectors");
      } else if (audit.vectors_stale) {
        audit.recommendations.push("Run project_build with force=true to refresh vectors");
      } else if (audit.is_healthy && !audit.server_running) {
        audit.recommendations.push("Project is ready - use project_query to search or project_serve to start server");
      } else if (audit.is_healthy && audit.server_running) {
        audit.recommendations.push("Project is healthy and server is running - ready for queries");
      }
    }
    
    return { success: true, audit };
    
  } catch (error) {
    return {
      success: false,
      error: `Audit failed: ${error instanceof Error ? error.message : String(error)}`,
      code: "AUDIT_FAILED",
    };
  }
}

// ============================================================================
// Librarian Quality Assessment Implementation
// ============================================================================

export function librarianAssessQuality(
  input: LibrarianAssessInput
): LibrarianQualityAssessment {
  const { query, results } = input;
  const thresholds = input.thresholds ?? {
    min_chunk_score: DEFAULT_LIBRARIAN_THRESHOLDS.min_chunk_score,
    avg_result_score: DEFAULT_LIBRARIAN_THRESHOLDS.avg_result_score,
  };
  
  // Handle empty results
  if (results.length === 0) {
    return {
      query,
      result_count: 0,
      min_score: 0,
      max_score: 0,
      avg_score: 0,
      meets_threshold: false,
      threshold_used: thresholds.avg_result_score,
      quality_level: "poor",
      recommendations: [
        "No results found for query",
        "Try broader search terms",
        "Check if project has been built with project_build",
        "Verify sources contain relevant content",
      ],
      debug_suggested: true,
      repair_suggested: true,
    };
  }
  
  // Calculate statistics
  const scores = results.map(r => r.score);
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);
  const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  
  // Assess quality level
  let qualityLevel: "excellent" | "good" | "marginal" | "poor";
  const recommendations: string[] = [];
  let debugSuggested = false;
  let repairSuggested = false;
  
  if (avgScore >= 0.80 && minScore >= 0.60) {
    qualityLevel = "excellent";
    recommendations.push("Results are high quality - safe to use directly");
  } else if (avgScore >= thresholds.avg_result_score && minScore >= thresholds.min_chunk_score) {
    qualityLevel = "good";
    recommendations.push("Results meet quality thresholds");
  } else if (avgScore >= thresholds.avg_result_score * 0.8) {
    qualityLevel = "marginal";
    debugSuggested = true;
    recommendations.push("Results are marginal - consider using debug_query for analysis");
    if (minScore < thresholds.min_chunk_score) {
      recommendations.push(`Some results below min_chunk_score (${thresholds.min_chunk_score})`);
    }
  } else {
    qualityLevel = "poor";
    debugSuggested = true;
    repairSuggested = true;
    recommendations.push("Results are poor quality - retrieval needs investigation");
    recommendations.push("Use debug_query to analyze similarity scores");
    recommendations.push("Consider re-chunking with different overlap/size settings");
    recommendations.push("Verify query matches content domain and terminology");
  }
  
  // Additional recommendations based on score distribution
  const scoreVariance = scores.reduce((sum, s) => sum + Math.pow(s - avgScore, 2), 0) / scores.length;
  if (scoreVariance > 0.1) {
    recommendations.push("High score variance - results may be inconsistent");
  }
  
  return {
    query,
    result_count: results.length,
    min_score: minScore,
    max_score: maxScore,
    avg_score: avgScore,
    meets_threshold: avgScore >= thresholds.avg_result_score,
    threshold_used: thresholds.avg_result_score,
    quality_level: qualityLevel,
    recommendations,
    debug_suggested: debugSuggested,
    repair_suggested: repairSuggested,
  };
}

// ============================================================================
// Utility: Format audit for tool response
// ============================================================================

export function formatAuditResponse(audit: LibrarianStateAudit): string {
  const lines: string[] = [];
  
  // Header
  lines.push(`## 📚 Librarian Audit: ${audit.project_id}`);
  lines.push("");
  lines.push(`**Timestamp:** ${audit.timestamp}`);
  lines.push(`**Health Status:** ${audit.is_healthy ? "✅ Healthy" : "⚠️ Issues Detected"}`);
  lines.push("");
  
  // State summary
  lines.push("### State Summary");
  lines.push("");
  lines.push(`| Component | Status |`);
  lines.push(`|-----------|--------|`);
  lines.push(`| Manifest | ${audit.manifest_valid ? "✅ Valid" : "❌ Invalid or Missing"} |`);
  lines.push(`| Sources | ${audit.total_sources} total (${audit.processed_sources} processed, ${audit.pending_sources} pending, ${audit.failed_sources} failed) |`);
  lines.push(`| Chunks | ${audit.total_chunks} |`);
  lines.push(`| Vectors | ${audit.total_vectors}${audit.vectors_stale ? " ⚠️ Stale" : ""} |`);
  lines.push(`| Server | ${audit.server_running ? "🟢 Running" : "⚪ Stopped"} |`);
  lines.push("");
  
  // Issues
  if (audit.issues.length > 0) {
    lines.push("### Issues");
    lines.push("");
    for (const issue of audit.issues) {
      lines.push(`- ⚠️ ${issue}`);
    }
    lines.push("");
  }
  
  // Recommendations
  if (audit.recommendations.length > 0) {
    lines.push("### Recommendations");
    lines.push("");
    for (const rec of audit.recommendations) {
      lines.push(`- 💡 ${rec}`);
    }
    lines.push("");
  }
  
  return lines.join("\n");
}

// ============================================================================
// Utility: Format quality assessment for tool response
// ============================================================================

export function formatQualityResponse(assessment: LibrarianQualityAssessment): string {
  const lines: string[] = [];
  
  const qualityEmoji = {
    excellent: "🌟",
    good: "✅",
    marginal: "⚠️",
    poor: "❌",
  };
  
  lines.push(`## 📊 Retrieval Quality Assessment`);
  lines.push("");
  lines.push(`**Query:** "${assessment.query.substring(0, 100)}${assessment.query.length > 100 ? "..." : ""}"`);
  lines.push(`**Quality Level:** ${qualityEmoji[assessment.quality_level]} ${assessment.quality_level.toUpperCase()}`);
  lines.push("");
  
  // Score summary
  lines.push("### Score Statistics");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Results | ${assessment.result_count} |`);
  lines.push(`| Min Score | ${(assessment.min_score * 100).toFixed(1)}% |`);
  lines.push(`| Max Score | ${(assessment.max_score * 100).toFixed(1)}% |`);
  lines.push(`| Avg Score | ${(assessment.avg_score * 100).toFixed(1)}% |`);
  lines.push(`| Threshold | ${(assessment.threshold_used * 100).toFixed(1)}% |`);
  lines.push(`| Meets Threshold | ${assessment.meets_threshold ? "✅ Yes" : "❌ No"} |`);
  lines.push("");
  
  // Recommendations
  if (assessment.recommendations.length > 0) {
    lines.push("### Recommendations");
    lines.push("");
    for (const rec of assessment.recommendations) {
      lines.push(`- ${rec}`);
    }
    lines.push("");
  }
  
  // Suggested actions
  if (assessment.debug_suggested || assessment.repair_suggested) {
    lines.push("### Suggested Actions");
    lines.push("");
    if (assessment.debug_suggested) {
      lines.push("- 🔍 Run `debug_query` for detailed similarity analysis");
    }
    if (assessment.repair_suggested) {
      lines.push("- 🔧 Consider re-building with `project_build force=true`");
      lines.push("- 🔄 Try different chunking parameters (overlap, max_chars)");
    }
    lines.push("");
  }
  
  return lines.join("\n");
}

// ============================================================================
// Export helper for getting server info
// ============================================================================

export function getServerInfo(baseDir: string): {
  server_base_dir: string;
  projects_dir: string;
  runs_dir: string;
} {
  return {
    server_base_dir: baseDir,
    projects_dir: path.join(baseDir, "projects"),
    runs_dir: path.join(baseDir, "runs"),
  };
}
