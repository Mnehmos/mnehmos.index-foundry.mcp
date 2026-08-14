/**
 * Runtime mode helpers for exported IndexFoundry servers.
 *
 * HTTP is deliberately opt-in at runtime. A generated server is commonly
 * launched by an MCP client as a stdio subprocess, and that process should not
 * claim a TCP port unless the caller explicitly wants the HTTP API.
 */

export interface HttpRuntimeConfig {
  include_http?: boolean;
}

export type RuntimeEnvironment = Record<string, string | undefined>;

export function shouldStartHttp(
  config: HttpRuntimeConfig,
  env: RuntimeEnvironment = process.env
): boolean {
  if (config.include_http !== true) return false;

  const value = env.INDEXFOUNDRY_HTTP?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}
