/** Project CRUD operations. */

import path from "path";
import {
  ProjectCreateInput,
  ProjectListInput,
  ProjectGetInput,
  ProjectDeleteInput,
  ProjectManifest,
  SourceRecord,
} from "../../schemas-projects.js";
import {
  ensureDir,
  pathExists,
  readJson,
  readJsonl,
  writeJsonl,
  writeJson,
  createToolError,
  now,
} from "../../utils.js";
import { getProjectsBaseDir, getProjectPaths } from "./config.js";
import { generateDeploymentFiles } from "./deploy.js";
import type { ToolError } from "../../types.js";

// ============================================================================
// Project Create
// ============================================================================

export interface ProjectCreateResult {
  success: true;
  project_id: string;
  path: string;
  message: string;
}

export async function projectCreate(input: ProjectCreateInput): Promise<ProjectCreateResult | ToolError> {
  const paths = getProjectPaths(input.project_id);

  // Check if exists
  if (await pathExists(paths.manifest)) {
    return createToolError("PROJECT_EXISTS", `Project '${input.project_id}' already exists`, {
      recoverable: true,
    });
  }

  try {
    // Create directory structure
    await ensureDir(paths.root);
    await ensureDir(paths.data);
    await ensureDir(paths.runs);
    await ensureDir(paths.src);

    // Initialize manifest
    const manifest: ProjectManifest = {
      project_id: input.project_id,
      name: input.name,
      description: input.description,
      created_at: now(),
      updated_at: now(),
      embedding_model: input.embedding_model,
      chunk_config: input.chunk_config,
      stats: {
        sources_count: 0,
        chunks_count: 0,
        vectors_count: 0,
        total_tokens: 0,
      },
    };

    await writeJson(paths.manifest, manifest);

    // Initialize empty sources file
    await writeJsonl(paths.sources, []);

    // Generate deployment files
    await generateDeploymentFiles(input.project_id, manifest);

    return {
      success: true,
      project_id: input.project_id,
      path: paths.root,
      message: `Project '${input.name}' created. Add sources with project_add_source.`,
    };
  } catch (err) {
    return createToolError("CREATE_FAILED", `Failed to create project: ${err}`, {
      recoverable: false,
    });
  }
}

// ============================================================================
// Project List
// ============================================================================

export interface ProjectListResult {
  success: true;
  projects: Array<{
    project_id: string;
    name: string;
    created_at: string;
    stats?: ProjectManifest["stats"];
  }>;
  total: number;
}

export async function projectList(input: ProjectListInput): Promise<ProjectListResult | ToolError> {
  try {
    await ensureDir(getProjectsBaseDir());

    const { readdir } = await import("fs/promises");
    const entries = await readdir(getProjectsBaseDir(), { withFileTypes: true });

    const projects: ProjectListResult["projects"] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const manifestPath = path.join(getProjectsBaseDir(), entry.name, "project.json");
      if (!(await pathExists(manifestPath))) continue;

      const manifest = await readJson<ProjectManifest>(manifestPath);
      projects.push({
        project_id: manifest.project_id,
        name: manifest.name,
        created_at: manifest.created_at,
        stats: input.include_stats ? manifest.stats : undefined,
      });
    }

    return {
      success: true,
      projects,
      total: projects.length,
    };
  } catch (err) {
    return createToolError("LIST_FAILED", `Failed to list projects: ${err}`, {
      recoverable: true,
    });
  }
}

// ============================================================================
// Project Get
// ============================================================================

export interface ProjectGetResult {
  success: true;
  manifest: ProjectManifest;
  sources: SourceRecord[];
  path: string;
}

export async function projectGet(input: ProjectGetInput): Promise<ProjectGetResult | ToolError> {
  const paths = getProjectPaths(input.project_id);

  if (!(await pathExists(paths.manifest))) {
    return createToolError("NOT_FOUND", `Project '${input.project_id}' not found`, {
      recoverable: false,
    });
  }

  try {
    const manifest = await readJson<ProjectManifest>(paths.manifest);
    const sources = await pathExists(paths.sources)
      ? await readJsonl<SourceRecord>(paths.sources)
      : [];

    return {
      success: true,
      manifest,
      sources,
      path: paths.root,
    };
  } catch (err) {
    return createToolError("READ_FAILED", `Failed to read project: ${err}`, {
      recoverable: true,
    });
  }
}

// ============================================================================
// Project Delete
// ============================================================================

export interface ProjectDeleteResult {
  success: true;
  project_id: string;
  message: string;
}

export async function projectDelete(input: ProjectDeleteInput): Promise<ProjectDeleteResult | ToolError> {
  if (!input.confirm) {
    return createToolError("NOT_CONFIRMED", "Set confirm: true to delete project", {
      recoverable: true,
    });
  }

  const paths = getProjectPaths(input.project_id);

  if (!(await pathExists(paths.root))) {
    return createToolError("NOT_FOUND", `Project '${input.project_id}' not found`, {
      recoverable: false,
    });
  }

  try {
    const { rm } = await import("fs/promises");
    await rm(paths.root, { recursive: true, force: true });

    return {
      success: true,
      project_id: input.project_id,
      message: `Project '${input.project_id}' deleted`,
    };
  } catch (err) {
    return createToolError("DELETE_FAILED", `Failed to delete project: ${err}`, {
      recoverable: false,
    });
  }
}
