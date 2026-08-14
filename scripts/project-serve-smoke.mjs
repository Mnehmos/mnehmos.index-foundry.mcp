import { initProjectManager } from "../dist/tools/projects/config.js";
import { projectServe, projectServeStop } from "../dist/tools/projects/serve.js";

initProjectManager("F:\\Github\\mnehmos.index-foundry.mcp");

const started = await projectServe({
  project_id: "close-loop-dungeon-demo",
  port: 8128,
  mode: "build",
  open_browser: false,
  health_check_timeout: 30000,
});

if (!started.success) {
  throw new Error("project_serve failed: " + started.message);
}

const health = await fetch("http://127.0.0.1:8128/health").then((response) => response.json());
console.log("project_serve: " + started.endpoint + " health=" + health.status);

const stopped = await projectServeStop({ project_id: "close-loop-dungeon-demo", force: false });
if (!stopped.success) {
  throw new Error("project_serve_stop failed: " + stopped.message);
}

console.log("project_serve_stop: " + stopped.message);
