/**
 * IndexFoundry Project Schemas
 *
 * Copyright (c) 2024 vario.automation
 * Proprietary and confidential. All rights reserved.
 */

import { z } from "zod";

// ============================================================================
// Validation Helpers
// ============================================================================

/** Safe project ID: lowercase alphanumeric with hyphens, no leading/trailing hyphens */
const safeProjectId = z.string()
  .min(1, "Project ID is required")
  .max(64, "Project ID must be 64 characters or less")
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "Project ID must be lowercase alphanumeric with hyphens, no leading/trailing hyphens");

/** Safe URL: must be http/https, no localhost/private IPs in production */
const safeUrl = z.string().url().refine((url) => {
  try {
    const parsed = new URL(url);
    // Only allow http/https protocols
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return false;
    }
    // Block obviously dangerous hosts (can be expanded)
    const blockedHosts = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"];
    if (blockedHosts.some(h => parsed.hostname === h || parsed.hostname.endsWith("." + h))) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}, "URL must be a valid http/https URL");

/** Safe file path: no path traversal, no dangerous patterns */
const safeFilePath = z.string()
  .min(1, "Path is required")
  .max(4096, "Path must be 4096 characters or less")
  .refine((p) => {
    // Block path traversal
    if (p.includes("..") || p.includes("./")) return false;
    // Block null bytes
    if (p.includes("\0")) return false;
    // Block some obviously sensitive paths
    const dangerous = ["/etc/", "/proc/", "/sys/", "C:\\Windows\\", "C:\\System"];
    if (dangerous.some(d => p.toLowerCase().includes(d.toLowerCase()))) return false;
    return true;
  }, "Path contains dangerous patterns");

/** Safe glob pattern */
const safeGlob = z.string()
  .max(256, "Glob pattern must be 256 characters or less")
  .refine((p) => !p.includes(".."), "Glob pattern cannot contain '..'")
  .default("**/*");

/** Safe tag: alphanumeric with hyphens/underscores */
const safeTag = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, "Tags must be alphanumeric with hyphens/underscores");

// ============================================================================
// Project Schemas
// ============================================================================

export const EmbeddingModelSchema = z.object({
  provider: z.enum(["openai", "cohere", "sentence-transformers", "local"]),
  model_name: z.string().min(1).max(128),
  dimensions: z.number().int().min(64).max(4096).optional(),
  api_key_env: z.string()
    .min(1)
    .max(64)
    .regex(/^[A-Z0-9_]+$/, "API key env var must be uppercase with underscores")
    .default("OPENAI_API_KEY"),
});

export const ProjectCreateSchema = z.object({
  project_id: safeProjectId,
  name: z.string().min(1).max(256, "Name must be 256 characters or less"),
  description: z.string().max(2048, "Description must be 2048 characters or less").optional(),
  embedding_model: EmbeddingModelSchema.default({
    provider: "openai",
    model_name: "text-embedding-3-small",
  }),
  chunk_config: z.object({
    strategy: z.enum(["recursive", "by_paragraph", "by_heading", "fixed_chars"]).default("recursive"),
    max_chars: z.number().int().min(100).max(10000).default(1500),
    overlap_chars: z.number().int().min(0).max(500).default(150),
  }).default({}),
});

export const ProjectListSchema = z.object({
  include_stats: z.boolean().default(false),
});

export const ProjectGetSchema = z.object({
  project_id: safeProjectId,
});

export const ProjectDeleteSchema = z.object({
  project_id: safeProjectId,
  confirm: z.boolean().describe("Must be true to delete"),
});

export const SourceType = z.enum(["url", "sitemap", "folder", "pdf", "text"]);

// Base schema for add source (shape is used for MCP tool registration)
export const ProjectAddSourceSchema = z.object({
  project_id: safeProjectId,

  // Source specification (one of these)
  url: safeUrl.optional(),
  sitemap_url: safeUrl.optional(),
  folder_path: safeFilePath.optional(),
  pdf_path: z.string().min(1).max(4096).optional(), // Can be URL or path

  // Options
  glob: safeGlob,
  include_patterns: z.array(z.string().max(256)).max(50).optional(),
  exclude_patterns: z.array(z.string().max(256)).max(50).optional(),
  max_pages: z.number().int().min(1).max(500).default(100), // Reduced max for safety

  // Metadata
  source_name: z.string().max(256).optional().describe("Human-readable name for this source"),
  tags: z.array(safeTag).max(20).default([]),
});

// Refined schema for runtime validation (exactly one source required)
export const ProjectAddSourceSchemaRefined = ProjectAddSourceSchema.refine((data) => {
  const sources = [data.url, data.sitemap_url, data.folder_path, data.pdf_path].filter(Boolean);
  return sources.length === 1;
}, "Exactly one source (url, sitemap_url, folder_path, or pdf_path) must be provided");

export const ProjectBuildSchema = z.object({
  project_id: safeProjectId,
  force: z.boolean().default(false).describe("Rebuild all sources, not just new ones"),
  dry_run: z.boolean().default(false).describe("Show what would be processed without doing it"),
});

export const ProjectQuerySchema = z.object({
  project_id: safeProjectId,
  query: z.string().min(1).max(4096, "Query must be 4096 characters or less"),
  mode: z.enum(["semantic", "keyword", "hybrid"]).default("hybrid"),
  top_k: z.number().int().min(1).max(100).default(10),
  filter_tags: z.array(safeTag).max(20).optional(),
  filter_sources: z.array(z.string().max(64)).max(50).optional(),
});

export const ProjectExportSchema = z.object({
  project_id: safeProjectId,

  // Server config
  server_name: z.string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "Server name must be lowercase alphanumeric with hyphens")
    .optional()
    .describe("MCP server name (defaults to project_id)"),
  server_description: z.string().max(512).optional(),
  port: z.number().int().min(1024).max(65535).default(8080),

  // What to include
  include_http: z.boolean().default(true).describe("Include HTTP endpoints alongside MCP"),

  // Railway specific
  railway_config: z.boolean().default(true),
});

export const ProjectDeploySchema = z.object({
  project_id: safeProjectId,
  
  // Environment variables to set on deployment
  env_vars: z.record(z.string()).optional()
    .describe("Environment variables to set (key-value pairs, e.g., { OPENAI_API_KEY: 'sk-xxx' })"),
  
  // Dry run shows commands without executing
  dry_run: z.boolean().default(false)
    .describe("Preview commands without executing (returns list of Railway CLI commands)"),
});

export const ProjectServeSchema = z.object({
  project_id: safeProjectId,
  
  // Server configuration
  port: z.number().int().min(1024).max(65535).default(8080)
    .describe("Port to run the server on"),
  
  // Mode: dev uses tsx (hot reload), build compiles first
  mode: z.enum(["dev", "build"]).default("dev")
    .describe("Server mode: 'dev' uses tsx for hot reload, 'build' compiles TypeScript first"),
  
  // Open browser after server starts
  open_browser: z.boolean().default(false)
    .describe("Open the frontend in the default browser after server starts"),
  
  // Timeout for health check polling (ms)
  health_check_timeout: z.number().int().min(1000).max(60000).default(30000)
    .describe("Timeout in ms for waiting for server health check"),
});

export const ProjectServeStopSchema = z.object({
  project_id: safeProjectId,
  
  // Force kill if graceful shutdown fails
  force: z.boolean().default(false)
    .describe("Force kill the process if graceful shutdown fails"),
});

export const ProjectServeStatusSchema = z.object({
  project_id: safeProjectId.optional()
    .describe("Project ID to check. If omitted, returns status of all running project servers"),
});

// ============================================================================
// Types
// ============================================================================

export type ProjectCreateInput = z.infer<typeof ProjectCreateSchema>;
export type ProjectListInput = z.infer<typeof ProjectListSchema>;
export type ProjectGetInput = z.infer<typeof ProjectGetSchema>;
export type ProjectDeleteInput = z.infer<typeof ProjectDeleteSchema>;
export type ProjectAddSourceInput = z.infer<typeof ProjectAddSourceSchema>;
export type ProjectBuildInput = z.infer<typeof ProjectBuildSchema>;
export type ProjectQueryInput = z.infer<typeof ProjectQuerySchema>;
export type ProjectExportInput = z.infer<typeof ProjectExportSchema>;
export type ProjectDeployInput = z.infer<typeof ProjectDeploySchema>;
export type ProjectServeInput = z.infer<typeof ProjectServeSchema>;
export type ProjectServeStopInput = z.infer<typeof ProjectServeStopSchema>;
export type ProjectServeStatusInput = z.infer<typeof ProjectServeStatusSchema>;
export type EmbeddingModel = z.infer<typeof EmbeddingModelSchema>;

// ============================================================================
// Internal Types
// ============================================================================

export interface ProjectManifest {
  project_id: string;
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
  embedding_model: EmbeddingModel;
  chunk_config: {
    strategy: string;
    max_chars: number;
    overlap_chars: number;
  };
  stats: {
    sources_count: number;
    chunks_count: number;
    vectors_count: number;
    total_tokens: number;
  };
}

export interface SourceRecord {
  source_id: string;
  type: "url" | "sitemap" | "folder" | "pdf" | "text";
  uri: string;
  source_name?: string;
  tags: string[];
  added_at: string;
  processed_at?: string;
  status: "pending" | "processing" | "completed" | "failed";
  error?: string;
  stats?: {
    files_fetched: number;
    chunks_created: number;
    vectors_created: number;
  };
}

export interface ChunkRecord {
  chunk_id: string;
  source_id: string;
  text: string;
  position: {
    index: number;
    start_char: number;
    end_char: number;
  };
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface VectorRecord {
  chunk_id: string;
  embedding: number[];
  model: string;
  created_at: string;
}
