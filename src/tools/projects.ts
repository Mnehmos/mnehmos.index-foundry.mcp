/**
 * Public project tool API.
 *
 * The implementation is split by responsibility; this module preserves the
 * original import surface for MCP handlers and downstream consumers.
 */

export { initProjectManager, RRF_CONSTANT } from "./projects/config.js";
export * from "./projects/crud.js";
export * from "./projects/sources.js";
export * from "./projects/build.js";
export * from "./projects/query.js";

export {
  projectExport,
  projectDeploy,
  generateMcpServerSourceForTest,
  buildServerConfigForTest,
} from "./projects/deploy.js";
export type {
  ProjectExportResult,
  ProjectDeployResult,
} from "./projects/deploy.js";

export {
  projectServe,
  projectServeStop,
  projectServeStatus,
} from "./projects/serve.js";
export type {
  ProjectServeResult,
  ProjectServeStopResult,
  ProjectServeStatusResult,
} from "./projects/serve.js";

export {
  fetchWithTimeout,
  fetchSource,
  chunkContent,
  embedText,
  embedChunks,
} from "./projects/ingest.js";
