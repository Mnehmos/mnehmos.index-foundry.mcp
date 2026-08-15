import { initProjectManager } from "../dist/tools/projects/config.js";
import { projectQuery } from "../dist/tools/projects.js";

initProjectManager("F:\\Github\\mnehmos.index-foundry.mcp");

const result = await projectQuery({
  project_id: "close-loop-dungeon-demo",
  query: "room D50",
  mode: "keyword",
  top_k: 3,
});

if (!result.success || result.results.length === 0) {
  throw new Error("Keyword project query returned no results");
}

console.log(
  "project_query keyword: " +
  result.results.length +
  " results; top=" +
  result.results[0].chunk_id
);
