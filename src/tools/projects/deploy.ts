/**
 * Project export and deployment.
 *
 * Generates a deployable repository for a project (Dockerfile, railway.toml,
 * frontend, server config) and copies the compiled server template into it,
 * then optionally drives the Railway CLI.
 *
 * Copyright (c) 2024 vario.automation
 * Proprietary and confidential. All rights reserved.
 */

import path from "path";
import { existsSync, readFileSync } from "fs";

import {
  ProjectExportInput,
  ProjectDeployInput,
  ProjectManifest,
  SourceRecord,
  ChunkRecord,
} from "../../schemas-projects.js";
import {
  pathExists,
  ensureDir,
  readJson,
  writeJson,
  createToolError,
  now,
} from "../../utils.js";
import { runCommand, isValidEnvVarName } from "../../process-utils.js";
import type { ToolError } from "../../types.js";
import { TEMPLATES_DIR, getProjectPaths } from "./config.js";
// ============================================================================
// Project Export
// ============================================================================

export interface ProjectExportResult {
  success: true;
  project_id: string;
  files_generated: string[];
  path: string;
  message: string;
}

export async function projectExport(input: ProjectExportInput): Promise<ProjectExportResult | ToolError> {
  const paths = getProjectPaths(input.project_id);

  if (!(await pathExists(paths.manifest))) {
    return createToolError("NOT_FOUND", `Project '${input.project_id}' not found`, {
      recoverable: false,
    });
  }

  try {
    const manifest = await readJson<ProjectManifest>(paths.manifest);

    const serverName = input.server_name || input.project_id;
    const serverDesc = input.server_description || manifest.description || `RAG search server for ${manifest.name}`;

    const files = await generateDeploymentFiles(input.project_id, manifest, {
      serverName,
      serverDescription: serverDesc,
      port: input.port,
      includeHttp: input.include_http,
      railwayConfig: input.railway_config,
    });

    return {
      success: true,
      project_id: input.project_id,
      files_generated: files,
      path: paths.root,
      message: `Export complete. cd ${paths.root} && git init && git add . && git commit -m "Initial" && git push`,
    };
  } catch (err) {
    return createToolError("EXPORT_FAILED", `Export failed: ${err}`, {
      recoverable: true,
    });
  }
}

// ============================================================================
// Project Deploy
// ============================================================================

export interface ProjectDeployResult {
  success: true;
  project_id: string;
  platform: string;
  commands: string[];
  message: string;
}

async function validateDeploymentInput(
  input: ProjectDeployInput,
  paths: ReturnType<typeof getProjectPaths>
): Promise<ToolError | null> {
  if (!(await pathExists(paths.manifest))) {
    return createToolError("NOT_FOUND", `Project '${input.project_id}' not found`, {
      recoverable: false,
    });
  }

  if (!(await pathExists(path.join(paths.src, "index.ts")))) {
    return createToolError(
      "NOT_EXPORTED",
      `Project '${input.project_id}' has not been exported. Run project_export first.`,
      { recoverable: true }
    );
  }

  for (const key of Object.keys(input.env_vars || {})) {
    if (!isValidEnvVarName(key)) {
      return createToolError(
        "INVALID_ENV_VAR",
        `Invalid environment variable name: '${key}'. Must match [A-Za-z_][A-Za-z0-9_]*`,
        { recoverable: false }
      );
    }
  }

  return null;
}

function buildDeploymentCommands(
  paths: ReturnType<typeof getProjectPaths>,
  envVars?: Record<string, string>
): string[] {
  const commands = [`cd ${paths.root}`, "railway init"];

  for (const [key, value] of Object.entries(envVars || {})) {
    const displayValue =
      key.includes("KEY") || key.includes("SECRET") || key.includes("TOKEN")
        ? "***"
        : value;
    commands.push(`railway variables set ${key}=${displayValue}`);
  }

  commands.push("railway up", "railway domain");
  return commands;
}

async function setRailwayVariables(
  paths: ReturnType<typeof getProjectPaths>,
  envVars: Record<string, string> | undefined,
  executedCommands: string[]
): Promise<ToolError | null> {
  for (const [key, value] of Object.entries(envVars || {})) {
    try {
      await runCommand("railway", ["variables", "set", `${key}=${value}`], {
        cwd: paths.root,
      });
      executedCommands.push(`railway variables set ${key}=***`);
    } catch (err) {
      return createToolError("ENV_VAR_FAILED", `Failed to set ${key}: ${err}`, {
        recoverable: true,
      });
    }
  }
  return null;
}

async function executeRailwayDeployment(
  input: ProjectDeployInput,
  paths: ReturnType<typeof getProjectPaths>
): Promise<ProjectDeployResult | ToolError> {
  try {
    const executedCommands: string[] = [];

    try {
      await runCommand("railway", ["init"], { cwd: paths.root });
      executedCommands.push("railway init");
    } catch {
      executedCommands.push("railway init (skipped - may already be initialized)");
    }

    const envError = await setRailwayVariables(paths, input.env_vars, executedCommands);
    if (envError) return envError;

    try {
      await runCommand("railway", ["up"], { cwd: paths.root });
      executedCommands.push("railway up");
    } catch (err) {
      return createToolError("DEPLOY_FAILED", `Deployment failed: ${err}`, {
        recoverable: true,
      });
    }

    let domain = "";
    try {
      const result = await runCommand("railway", ["domain"], { cwd: paths.root });
      domain = result.stdout.trim();
      executedCommands.push("railway domain");
    } catch {
      domain = "(domain not yet assigned - check Railway dashboard)";
    }

    return {
      success: true,
      project_id: input.project_id,
      platform: "railway",
      commands: executedCommands,
      message: `Deployed to Railway! Domain: ${domain}`,
    };
  } catch (err) {
    return createToolError(
      "DEPLOY_FAILED",
      `Deployment failed: ${err}. Ensure Railway CLI is installed and you are logged in.`,
      { recoverable: true }
    );
  }
}

export async function projectDeploy(input: ProjectDeployInput): Promise<ProjectDeployResult | ToolError> {
  const paths = getProjectPaths(input.project_id);
  const validationError = await validateDeploymentInput(input, paths);
  if (validationError) return validationError;

  const commands = buildDeploymentCommands(paths, input.env_vars);
  if (input.dry_run) {
    return {
      success: true,
      project_id: input.project_id,
      platform: "railway",
      commands,
      message: `Dry run complete. Would execute ${commands.length} Railway CLI commands. Ensure Railway CLI is installed (npm i -g @railway/cli) and you are logged in (railway login).`,
    };
  }

  return executeRailwayDeployment(input, paths);
}

// ============================================================================
// Frontend Generation Helpers
// ============================================================================

/**
 * Synchronous JSONL reader for use at export time only
 * (avoids async complexity in template generation)
 */
function readJsonlSync<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf-8').trim();
  if (!content) return [];
  return content.split('\n').filter(Boolean).map((line: string) => JSON.parse(line) as T);
}

/**
 * Generate 4 example questions from indexed chunks
 * Strategies:
 * 1. Extract headings -> "What is [heading]?"
 * 2. Extract source names -> "Tell me about [source]"
 * 3. Use generic fallbacks
 */
function generateExampleQuestions(projectId: string): string[] {
  const paths = getProjectPaths(projectId);
  const questions: string[] = [];

  try {
    // Try to read chunks for headings
    if (existsSync(paths.chunks)) {
      const chunks = readJsonlSync<ChunkRecord>(paths.chunks);

      // Strategy 1: Extract from headings in metadata
      const headings = chunks
        .filter(c => c.metadata?.heading && typeof c.metadata.heading === 'string')
        .map(c => c.metadata.heading as string)
        .filter(h => h.length > 3 && h.length < 50);

      const uniqueHeadings = [...new Set(headings)].slice(0, 2);
      questions.push(...uniqueHeadings.map(h => `What is ${h}?`));

      // Strategy 2: Extract key topics from first chunks
      if (questions.length < 4 && chunks.length > 0) {
        const firstChunk = chunks[0].text.slice(0, 200);
        // Extract potential topic (first sentence or phrase)
        const match = firstChunk.match(/^([A-Z][^.!?]{10,60}[.!?])/);
        if (match) {
          questions.push(`Can you explain: ${match[1].slice(0, 50)}...`);
        }
      }
    }

    // Strategy 3: Use source names
    if (questions.length < 4 && existsSync(paths.sources)) {
      const sources = readJsonlSync<SourceRecord>(paths.sources);
      const sourceNames = sources
        .filter(s => s.source_name)
        .map(s => s.source_name as string)
        .slice(0, 2);
      questions.push(...sourceNames.map(n => `Tell me about ${n}`));
    }

  } catch (err) {
    console.error('Error generating example questions:', err);
  }

  // Fallback generic questions
  const fallbacks = [
    "What are the main topics covered?",
    "Give me an overview of the content",
    "What should I know first?",
    "Summarize the key points"
  ];

  while (questions.length < 4) {
    questions.push(fallbacks[questions.length]);
  }

  return questions.slice(0, 4);
}

/**
 * Generate minimal chat HTML template as fallback
 * Used when the template file is not found
 */
function generateMinimalChatHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{PROJECT_NAME}} - Chat</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: #f5f5f5; min-height: 100vh; display: flex; flex-direction: column; }
    #app { max-width: 800px; margin: 0 auto; padding: 1rem; flex: 1; display: flex; flex-direction: column; }
    header { padding: 1rem 0; border-bottom: 1px solid #ddd; margin-bottom: 1rem; }
    h1 { font-size: 1.5rem; }
    #messages { flex: 1; overflow-y: auto; padding: 1rem; background: white; border-radius: 8px; margin-bottom: 1rem; }
    .message { padding: 0.75rem; margin: 0.5rem 0; border-radius: 8px; }
    .user { background: #007bff; color: white; margin-left: 20%; }
    .assistant { background: #e9ecef; margin-right: 20%; }
    #input-area { display: flex; gap: 0.5rem; }
    #question { flex: 1; padding: 0.75rem; border: 1px solid #ddd; border-radius: 8px; }
    button { padding: 0.75rem 1.5rem; background: #007bff; color: white; border: none; border-radius: 8px; cursor: pointer; }
    button:hover { background: #0056b3; }
    #examples { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1rem; }
    .example-btn { padding: 0.5rem 1rem; background: #f0f0f0; border: 1px solid #ddd; border-radius: 20px; cursor: pointer; font-size: 0.9rem; }
    .example-btn:hover { background: #e0e0e0; }
  </style>
</head>
<body>
  <div id="app">
    <header><h1>{{PROJECT_NAME}}</h1></header>
    <div id="examples">
      <button class="example-btn">{{EXAMPLE_1}}</button>
      <button class="example-btn">{{EXAMPLE_2}}</button>
      <button class="example-btn">{{EXAMPLE_3}}</button>
      <button class="example-btn">{{EXAMPLE_4}}</button>
    </div>
    <div id="messages"></div>
    <div id="input-area">
      <input type="text" id="question" placeholder="Ask a question...">
      <button onclick="send()">Send</button>
    </div>
  </div>
  <script>
    const CONFIG = { ragServer: window.LOCAL_CONFIG?.RAG_SERVER || '{{RAG_SERVER_URL}}' };
    const messages = document.getElementById('messages');
    document.querySelectorAll('.example-btn').forEach(b => b.onclick = () => { document.getElementById('question').value = b.textContent; send(); });
    async function send() {
      const q = document.getElementById('question').value.trim();
      if (!q) return;
      document.getElementById('question').value = '';
      messages.innerHTML += '<div class="message user">' + q + '</div>';
      const res = await fetch(CONFIG.ragServer + '/chat', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({question: q}) });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const bubble = document.createElement('div');
      bubble.className = 'message assistant';
      messages.appendChild(bubble);
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        for (const line of chunk.split('\\n')) {
          if (line.startsWith('data: ')) {
            try {
              const d = JSON.parse(line.slice(6));
              if (d.type === 'delta') { text += d.text; bubble.textContent = text; }
            } catch {}
          }
        }
      }
    }
  </script>
</body>
</html>`;
}

export async function generateDeploymentFiles(
  projectId: string,
  manifest: ProjectManifest,
  options?: {
    serverName?: string;
    serverDescription?: string;
    port?: number;
    includeHttp?: boolean;
    railwayConfig?: boolean;
    includeFrontend?: boolean;  // Generate frontend/index.html chat UI
  }
): Promise<string[]> {
  const paths = getProjectPaths(projectId);
  const files: string[] = [];

  const serverName = options?.serverName || projectId;
  const serverDesc = options?.serverDescription || manifest.description || `RAG server for ${manifest.name}`;
  const port = options?.port || 8080;
  const apiKeyEnv = manifest.embedding_model?.api_key_env || "OPENAI_API_KEY";
  const embeddingKeyDocumentation = apiKeyEnv === "OPENAI_API_KEY"
    ? "| `OPENAI_API_KEY` | For /chat and semantic search | OpenAI API key used by embeddings and chat |"
    : `| \`${apiKeyEnv}\` | For semantic search | API key used by the configured embedding provider |
| \`OPENAI_API_KEY\` | For /chat | OpenAI API key used by chat |`;
  const embeddingKeyDeploymentRows = apiKeyEnv === "OPENAI_API_KEY"
    ? "| `OPENAI_API_KEY` | `sk-proj-...` | Yes |"
    : `| \`${apiKeyEnv}\` | Embedding provider key | Yes |
| \`OPENAI_API_KEY\` | OpenAI chat key | Yes |`;

  // .gitignore
  await writeFile(path.join(paths.root, ".gitignore"), `
node_modules/
dist/
runs/
*.log
.env
.DS_Store

# Runtime state - a committed pid can collide with a live process elsewhere
.server.pid

# Machine-local frontend config; commit local.config.js.example instead
frontend/local.config.js
`);
  files.push(".gitignore");

  // package.json
  await writeFile(path.join(paths.root, "package.json"), JSON.stringify({
    name: serverName,
    version: "1.0.0",
    description: serverDesc,
    type: "module",
    main: "dist/index.js",
    scripts: {
      build: "tsc",
      start: "node dist/index.js",
      dev: "tsx src/index.ts"
    },
    dependencies: {
      "@modelcontextprotocol/sdk": "^1.0.0",
      dotenv: "^16.3.1",
      express: "^5.2.1",
    },
    devDependencies: {
      "@types/express": "^5.0.6",
      "@types/node": "^20.10.0",
      typescript: "^5.3.0",
      tsx: "^4.7.0"
    }
  }, null, 2));
  files.push("package.json");

  // Rebuild the lockfile from the generated package.json so re-exporting an
  // existing project cannot leave Docker's npm ci with stale dependency pins.
  await runCommand("npm", ["install", "--package-lock-only", "--ignore-scripts"], {
    cwd: paths.root,
  });
  files.push("package-lock.json");

  // tsconfig.json
  await writeFile(path.join(paths.root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      outDir: "./dist",
      rootDir: "./src",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      declaration: true
    },
    include: ["src/**/*"]
  }, null, 2));
  files.push("tsconfig.json");

  // Dockerfile - multi-stage build
  await writeFile(path.join(paths.root, "Dockerfile"), `# Build stage
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Production stage
FROM node:20-slim

WORKDIR /app

# Copy package files and install production dependencies only
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy built files and data
COPY --from=builder /app/dist/ ./dist/
COPY data/ ./data/
COPY frontend/index.html ./frontend/index.html
COPY sources.jsonl ./
COPY project.json ./
COPY server.config.json ./

ENV NODE_ENV=production
ENV PORT=${port}
ENV INDEXFOUNDRY_HTTP=1

EXPOSE ${port}

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \\
  CMD node -e "fetch('http://localhost:${port}/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
`);
  files.push("Dockerfile");

  // railway.toml
  if (options?.railwayConfig !== false) {
    await writeFile(path.join(paths.root, "railway.toml"), `[build]
builder = "dockerfile"

[deploy]
startCommand = "node dist/index.js"
healthcheckPath = "/health"
healthcheckTimeout = 300
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 3
`);
    files.push("railway.toml");
  }

  // README.md
  await writeFile(path.join(paths.root, "README.md"), `# ${manifest.name}

${serverDesc}

## Quick Start

\`\`\`bash
npm install
npm run build
npm start
\`\`\`

## Run modes

By default, npm start runs as a stdio-only MCP server and does not claim a TCP port.
Enable the HTTP API explicitly by setting INDEXFOUNDRY_HTTP=1 before running npm start.
On PowerShell, use $env:INDEXFOUNDRY_HTTP="1"; npm start.

## Index Stats

| Metric | Count |
|--------|-------|
| Sources | ${manifest.stats.sources_count} |
| Chunks | ${manifest.stats.chunks_count} |
| Vectors | ${manifest.stats.vectors_count} |
| Embedding Model | ${manifest.embedding_model.provider}/${manifest.embedding_model.model_name} |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| \`PORT\` | No | HTTP server port (default: ${port}) |
| \`INDEXFOUNDRY_HTTP\` | No | Set to \`1\` to enable the HTTP API; omitted for stdio-only MCP mode |
${embeddingKeyDocumentation}
| \`RAG_API_TOKEN\` | API/cross-origin /chat | Bearer token for API clients and separately hosted frontends; the bundled same-origin frontend uses the browser-origin policy |
| \`CORS_ORIGINS\` | No | Comma-separated exact origins allowed for cross-origin requests |
| \`CHAT_RATE_LIMIT_PER_MINUTE\` | No | Per-client \`/chat\` limit; defaults to 30 |
| \`OPENAI_MODEL\` | No | Model for chat (default: gpt-5-nano-2025-08-07) |

The bundled frontend is served from the RAG server's own origin, so its browser
requests use the same-origin policy and do not embed \`RAG_API_TOKEN\`. Bearer
authentication remains required for API clients and separately hosted
frontends; add their exact origin to \`CORS_ORIGINS\`. If the RAG data is
private, put an authenticated application or proxy in front of the bundled UI.

## Deploy to Railway

1. Push to GitHub
2. Connect repo to Railway
3. Add \`OPENAI_API_KEY\` and a strong \`RAG_API_TOKEN\` environment variable
4. Add the frontend origin to \`CORS_ORIGINS\` only when the frontend is hosted separately
5. Deploy

## HTTP Endpoints

### Health Check
\`\`\`bash
curl https://your-app.railway.app/health
\`\`\`

### Search
\`\`\`bash
curl -X POST https://your-app.railway.app/search \\
  -H "Content-Type: application/json" \\
  -d '{"query": "your search query", "mode": "keyword", "top_k": 10}'
\`\`\`

### Chat (RAG + LLM)
\`\`\`bash
curl -X POST https://your-app.railway.app/chat \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $RAG_API_TOKEN" \\
  -d '{"question": "What is...?"}'
\`\`\`

### List Sources
\`\`\`bash
curl https://your-app.railway.app/sources
\`\`\`

## MCP Integration

Add to your MCP client config:
\`\`\`json
{
  "mcpServers": {
    "${serverName}": {
      "command": "node",
      "args": ["path/to/dist/index.js"]
    }
  }
}
\`\`\`

---
*Generated by IndexFoundry*
`);
  files.push("README.md");

  // DEPLOYMENT.md - Step-by-step deployment guide
  await writeFile(path.join(paths.root, "DEPLOYMENT.md"), `# Deployment Guide for ${manifest.name}

---

## Quick Start: Local Development

### Step 1: Install Dependencies
\`\`\`bash
cd ${paths.root}
npm install
\`\`\`

### Step 2: Configure Environment
Add your OpenAI API key to the \`.env\` file:
\`\`\`bash
# Open .env and add your key:
OPENAI_API_KEY=sk-proj-your-key-here
\`\`\`

### Step 3: Start the HTTP Server
\`\`\`bash
INDEXFOUNDRY_HTTP=1 npm run dev
\`\`\`
On PowerShell, use $env:INDEXFOUNDRY_HTTP="1"; npm run dev.

You should see:
\`\`\`
Loaded X sources
Loaded Y chunks, Y vectors
HTTP server listening on port ${port}
\`\`\`

### Step 4: Test the Frontend
1. Copy \`frontend/local.config.js.example\` to \`frontend/local.config.js\`
2. Open \`http://localhost:${port}/\` in your browser (or run the project with \`open_browser\` enabled)
3. The status should show "Ready" (green indicator)
4. Ask a question to verify the chat works!

### Step 5: Verify API Endpoints
\`\`\`bash
# Health check
curl http://localhost:${port}/health

# Search test
curl -X POST http://localhost:${port}/search \\
  -H "Content-Type: application/json" \\
  -d '{"query": "test", "mode": "keyword", "top_k": 5}'
\`\`\`

---

## Production Deployment

### Prerequisites

| Requirement | Where to Get It |
|-------------|-----------------|
| GitHub Account | [github.com](https://github.com) |
| Railway Account | [railway.app](https://railway.app) |
| OpenAI API Key | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |

---

### Step 1: Push to GitHub

\`\`\`bash
cd ${paths.root}
git init
git add .
git commit -m "Initial commit"
gh repo create ${serverName} --public --push
\`\`\`

Or manually create a repo at [github.com/new](https://github.com/new) and push.

---

### Step 2: Deploy to Railway

1. Go to [railway.app/dashboard](https://railway.app/dashboard)
2. Click **"New Project"** -> **"Deploy from GitHub repo"**
3. Select your \`${serverName}\` repository
4. Railway will auto-detect the Dockerfile

---

### Step 3: Configure Environment Variables

In Railway dashboard -> your service -> **"Variables"** tab:

| Variable | Value | Required |
|----------|-------|----------|
${embeddingKeyDeploymentRows}
| \`RAG_API_TOKEN\` | Long random bearer token | Yes for API/cross-origin chat |
| \`CORS_ORIGINS\` | Frontend origin(s), if separate | Optional |
| \`PORT\` | \`${port}\` | Auto-set |
| \`OPENAI_MODEL\` | \`gpt-5-nano-2025-08-07\` | Optional |

> Ã¢Å¡ Ã¯Â¸Â **Never commit API keys to Git!**

---

### Step 4: Get Your Public URL

1. In Railway -> **"Settings"** -> **"Networking"**
2. Click **"Generate Domain"**
3. Copy your URL: \`https://${serverName}-production.up.railway.app\`

---

### Step 5: Verify Deployment

#### Health Check
\`\`\`bash
curl https://YOUR-APP.railway.app/health
\`\`\`

#### Test Search
\`\`\`bash
curl -X POST https://YOUR-APP.railway.app/search \\
  -H "Content-Type: application/json" \\
  -d '{"query": "test", "mode": "keyword", "top_k": 5}'
\`\`\`

#### Test Chat
\`\`\`bash
curl -X POST https://YOUR-APP.railway.app/chat \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $RAG_API_TOKEN" \\
  -d '{"question": "What is this about?"}'
\`\`\`

---

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| \`/health\` | GET | Health check |
| \`/stats\` | GET | Index statistics |
| \`/sources\` | GET | List sources |
| \`/search\` | POST | RAG search |
| \`/chat\` | POST | Chat with streaming |
| \`/chunks/:id\` | GET | Get chunk by ID |

---

## Troubleshooting

### API Key Not Loaded
If you get "OPENAI_API_KEY not configured":
- Ensure you added your key to \`.env\` (not \`.env.example\`)
- The \`.env\` file should NOT be committed to git

### Port Already in Use
If port ${port} is busy:
- Change PORT in \`.env\` to another port (e.g., 3001)
- Update \`frontend/local.config.js\` to match

### Build Failed
- Check build logs in Railway dashboard
- Ensure \`npm run build\` works locally

### Health Check Failed
- Verify \`OPENAI_API_KEY\` is set
- Check runtime logs for errors

### Chat Returns 500
- Check OpenAI API quota
- Verify API key is valid

---

## Frontend Deployment

The project includes a ready-to-use chat interface in the \`frontend/\` directory.

### Option 1: GitHub Pages (Recommended for Static)
1. Push your repo to GitHub
2. Go to **Settings** -> **Pages**
3. Set Source to **Deploy from a branch**
4. Select **main** branch and **\`/frontend\`** folder
5. Your chat UI will be live at \`https://USERNAME.github.io/REPO-NAME/\`

### Option 2: Serve from Railway (Same Origin)
The frontend is automatically served from the root path when deployed.

### Option 3: Any Static Host
Upload the contents of \`frontend/\` to:
- Netlify
- Vercel
- AWS S3 + CloudFront
- Any web server

---

*Generated by IndexFoundry*
`);
  files.push("DEPLOYMENT.md");

  // MCP Server source - copied verbatim from the compiled template
  for (const fileName of SERVER_TEMPLATE_FILES) {
    await writeFile(path.join(paths.src, fileName), readServerTemplate(fileName));
    files.push(`src/${fileName}`);
  }

  // Runtime config for the server template (name, description, port, transport)
  await writeFile(
    path.join(paths.root, "server.config.json"),
    buildServerConfig(serverName, serverDesc, port, options?.includeHttp !== false)
  );
  files.push("server.config.json");

  // The server embeds queries with the model recorded in project.json, so the
  // env var it needs is whatever that project was built with.
  const chatApiKeyExample = apiKeyEnv === "OPENAI_API_KEY"
    ? ""
    : "OPENAI_API_KEY=sk-your-chat-key-here\n";
  const chatApiKeyEmpty = apiKeyEnv === "OPENAI_API_KEY"
    ? ""
    : "OPENAI_API_KEY=\n";

  // .env.example - documents required environment variables
  await writeFile(path.join(paths.root, ".env.example"), `# Required for semantic search and the /chat endpoint
${apiKeyEnv}=sk-your-key-here
${chatApiKeyExample}RAG_API_TOKEN=replace-with-a-long-random-token

# Optional configuration
PORT=${port}
# Set INDEXFOUNDRY_HTTP=1 to enable the HTTP API (stdio-only MCP is the default)
OPENAI_MODEL=gpt-5-nano-2025-08-07
NODE_ENV=production
CORS_ORIGINS=
CHAT_RATE_LIMIT_PER_MINUTE=30
`);
  files.push(".env.example");

  // .env file for users to fill in (gitignored)
  await writeFile(path.join(paths.root, ".env"), `# Fill in your API keys below
${apiKeyEnv}=
${chatApiKeyEmpty}RAG_API_TOKEN=

# Optional configuration
PORT=${port}
OPENAI_MODEL=gpt-5-nano-2025-08-07
NODE_ENV=development
CORS_ORIGINS=
CHAT_RATE_LIMIT_PER_MINUTE=30
`);
  files.push(".env");

  // .dockerignore - reduces Docker context size
  await writeFile(path.join(paths.root, ".dockerignore"), `node_modules
.git
.gitignore
*.md
.env
.env.*
.env.example
runs/
*.log
.DS_Store
`);
  files.push(".dockerignore");

  // Frontend - Chat UI
  if (options?.includeFrontend !== false) {
    const frontendDir = path.join(paths.root, 'frontend');
    await ensureDir(frontendDir);

    // Generate example questions from indexed content
    const examples = generateExampleQuestions(projectId);

    // Compute RAG server URL for production
    const ragServerUrl = `https://${serverName}-production.up.railway.app`;

    // Read and process chat template
    const templatePath = path.join(TEMPLATES_DIR, 'chat.html');
    let chatHtml: string;

    try {
      const { readFileSync } = await import('fs');
      chatHtml = readFileSync(templatePath, 'utf-8');
    } catch {
      // Fallback: generate minimal template if file not found
      chatHtml = generateMinimalChatHtml();
    }

    // Replace template variables
    chatHtml = chatHtml
      .replace(/\{\{PROJECT_NAME\}\}/g, manifest.name)
      .replace(/\{\{RAG_SERVER_URL\}\}/g, ragServerUrl)
      .replace(/\{\{EXAMPLE_1\}\}/g, examples[0] || 'What topics are covered?')
      .replace(/\{\{EXAMPLE_2\}\}/g, examples[1] || 'Give me an overview')
      .replace(/\{\{EXAMPLE_3\}\}/g, examples[2] || 'What should I know first?')
      .replace(/\{\{EXAMPLE_4\}\}/g, examples[3] || 'Summarize the key points');

    await writeFile(path.join(frontendDir, 'index.html'), chatHtml);
    files.push('frontend/index.html');

    // local.config.js.example for development
    await writeFile(path.join(frontendDir, 'local.config.js.example'), `// Local development configuration
// Copy this file to local.config.js and edit the server URL and token as needed

window.LOCAL_CONFIG = {
  RAG_SERVER: 'http://localhost:${port}',
  // Required when the frontend calls a different origin in production.
  RAG_API_TOKEN: ''
};
`);
    files.push('frontend/local.config.js.example');

  }

  return files;
}

/**
 * Source files copied verbatim into an exported project's src/ directory.
 *
 * These are real compiled source files under src/templates/server, not strings
 * built here. They read configuration from project.json and server.config.json
 * at runtime, so no substitution happens at export time.
 */
const SERVER_TEMPLATE_FILES = ["index.ts", "search.ts", "runtime.ts"] as const;

function readServerTemplate(fileName: string): string {
  return readFileSync(path.join(TEMPLATES_DIR, "server", fileName), "utf-8");
}

/**
 * Load the exported server's entry point template.
 */
function generateMcpServerSource(): string {
  return readServerTemplate("index.ts");
}

/**
 * Runtime configuration consumed by the exported server template.
 */
function buildServerConfig(
  serverName: string,
  serverDescription: string,
  port: number,
  includeHttp: boolean
): string {
  return JSON.stringify(
    {
      server_name: serverName,
      server_description: serverDescription,
      port,
      include_http: includeHttp,
    },
    null,
    2
  );
}

async function writeFile(filePath: string, content: string): Promise<void> {
  const { writeFile: write, mkdir } = await import("fs/promises");
  await mkdir(dirname(filePath), { recursive: true });
  await write(filePath, content.trim() + "\n", "utf-8");
}

function dirname(p: string): string {
  return path.dirname(p);
}

/**
 * Test helper: read the exported server template.
 */
export function generateMcpServerSourceForTest(): string {
  return generateMcpServerSource();
}

/**
 * Test helper: build the runtime config written alongside the server template.
 */
export function buildServerConfigForTest(
  serverName: string,
  serverDescription: string,
  port: number,
  includeHttp: boolean
): string {
  return buildServerConfig(serverName, serverDescription, port, includeHttp);
}
