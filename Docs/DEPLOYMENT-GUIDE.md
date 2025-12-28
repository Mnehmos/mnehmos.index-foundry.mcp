# IndexFoundry Deployment Guide

Complete step-by-step instructions for deploying your RAG server to Railway.

---

## Prerequisites

Before you begin, ensure you have:

| Requirement | Where to Get It |
|-------------|-----------------|
| GitHub Account | [github.com](https://github.com) |
| Railway Account | [railway.app](https://railway.app) (free tier available) |
| OpenAI API Key | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| Railway CLI (optional) | `npm install -g @railway/cli` |
| GitHub CLI (optional) | `npm install -g gh` |

---

## Part 1: Create Your RAG Project

### Step 1.1: Create the Project
Use IndexFoundry MCP tools to create your project:

```
indexfoundry_project_create({
  project_id: "my-rag-server",
  name: "My RAG Server",
  description: "Production RAG chatbot"
})
```

### Step 1.2: Add Your Data Sources
Add URLs, sitemaps, PDFs, or local folders:

```
// From a website sitemap
indexfoundry_project_add_source({
  project_id: "my-rag-server",
  sitemap_url: "https://docs.example.com/sitemap.xml"
})

// From a single URL
indexfoundry_project_add_source({
  project_id: "my-rag-server",
  url: "https://example.com/important-page"
})

// From a PDF
indexfoundry_project_add_source({
  project_id: "my-rag-server",
  pdf_path: "https://example.com/document.pdf"
})
```

### Step 1.3: Build the Vector Database
Process all sources and generate embeddings:

```
indexfoundry_project_build({
  project_id: "my-rag-server"
})
```
> ⏱️ This may take a few minutes depending on data size.

### Step 1.4: Export Deployment Files
Generate all files needed for Railway:

```
indexfoundry_project_export({
  project_id: "my-rag-server"
})
```

This creates:
- `Dockerfile` - Production container config
- `railway.toml` - Railway deployment settings
- `src/index.ts` - MCP + HTTP server
- `.env.example` - Environment variable template
- `README.md` - Project documentation

---

## Part 2: Push to GitHub

### Step 2.1: Navigate to Your Project

```bash
cd ~/.indexfoundry/projects/my-rag-server
# Windows: cd %APPDATA%\Roo-Code\MCP\IndexFoundry\projects\my-rag-server
```

### Step 2.2: Initialize Git Repository

```bash
git init
git add .
git commit -m "Initial commit - RAG server"
```

### Step 2.3: Create GitHub Repository

**Option A: Using GitHub CLI**
```bash
gh repo create my-rag-server --public --push
```

**Option B: Manual**
1. Go to [github.com/new](https://github.com/new)
2. Create repository named `my-rag-server`
3. Push your code:
   ```bash
   git remote add origin https://github.com/YOUR_USERNAME/my-rag-server.git
   git branch -M main
   git push -u origin main
   ```

---

## Part 3: Deploy to Railway

### Step 3.1: Connect Railway to GitHub

1. Go to [railway.app/dashboard](https://railway.app/dashboard)
2. Click **"New Project"**
3. Select **"Deploy from GitHub repo"**
4. Authorize Railway to access your GitHub
5. Select your `my-rag-server` repository

### Step 3.2: Configure Environment Variables (REQUIRED)

Railway will detect the Dockerfile automatically. Now add your secrets:

1. In Railway dashboard, click on your service
2. Go to **"Variables"** tab
3. Add the following variables:

| Variable | Value | Required |
|----------|-------|----------|
| `OPENAI_API_KEY` | `sk-proj-your-key-here` | ✅ Yes |
| `PORT` | `8080` | ❌ No (auto-set) |
| `OPENAI_MODEL` | `gpt-4o-mini` | ❌ No (default) |
| `NODE_ENV` | `production` | ❌ No (default) |

> ⚠️ **IMPORTANT**: Never commit your API key to Git. Only add it in Railway's dashboard.

### Step 3.3: Deploy

Railway will automatically:
1. Build the Docker container
2. Run health checks
3. Deploy your service

Wait for the deployment to show **"Success"** (usually 2-3 minutes).

### Step 3.4: Get Your Public URL

1. In Railway dashboard, click **"Settings"** tab
2. Scroll to **"Networking"**
3. Click **"Generate Domain"**
4. Copy your URL (e.g., `https://my-rag-server-production.up.railway.app`)

---

## Part 4: Verify Deployment

### Test Health Endpoint
```bash
curl https://YOUR-APP.railway.app/health
```

Expected response:
```json
{
  "status": "ok",
  "project": "My RAG Server",
  "chunks": 245,
  "vectors": 245,
  "sources": 3,
  "uptime": 42
}
```

### Test Search Endpoint
```bash
curl -X POST https://YOUR-APP.railway.app/search \
  -H "Content-Type: application/json" \
  -d '{"query": "your search term", "mode": "keyword", "top_k": 5}'
```

### Test Chat Endpoint
```bash
curl -X POST https://YOUR-APP.railway.app/chat \
  -H "Content-Type: application/json" \
  -d '{"question": "What is this about?"}'
```

---

## Part 5: Using with MCP Clients

### Add to Claude Desktop

Edit `~/.config/claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "my-rag-server": {
      "command": "npx",
      "args": ["-y", "mcp-remote-client", "https://YOUR-APP.railway.app"]
    }
  }
}
```

### Add to Cline/Roo-Code

Edit your MCP settings:

```json
{
  "my-rag-server": {
    "command": "node",
    "args": ["path/to/projects/my-rag-server/dist/index.js"]
  }
}
```

---

## Part 6: Alternative - Deploy with MCP Tool

If you have Railway CLI installed and authenticated:

### Preview Commands (Dry Run)
```
indexfoundry_project_deploy({
  project_id: "my-rag-server",
  dry_run: true
})
```

### Deploy with Environment Variables
```
indexfoundry_project_deploy({
  project_id: "my-rag-server",
  env_vars: {
    "OPENAI_API_KEY": "sk-proj-your-key-here"
  }
})
```

---

## Troubleshooting

### "Build Failed" in Railway

**Check the build logs:**
1. Click on your service in Railway
2. Go to **"Deployments"** tab
3. Click the failed deployment
4. Read the error message

**Common fixes:**
- Ensure `npm run build` works locally
- Check that all files are committed to Git

### "Health Check Failed"

**Check the runtime logs:**
1. Go to **"Logs"** tab in Railway
2. Look for startup errors

**Common causes:**
- Missing `OPENAI_API_KEY` environment variable
- Port mismatch (should be `8080` or auto-configured)

### Chat Endpoint Returns 500

**Check the logs for API errors:**
- Verify `OPENAI_API_KEY` is set correctly
- Check OpenAI API quota/billing

---

## Managing Secrets

### Railway Secrets Best Practices

1. **Never commit secrets to Git** - Use `.gitignore` and `.env.example`
2. **Use Railway's Variables** - They're encrypted and injected at runtime
3. **Rotate keys periodically** - Update in Railway dashboard

### GitHub Secrets (for CI/CD)

If using GitHub Actions for deployments:

1. Go to your repo → **Settings** → **Secrets and variables** → **Actions**
2. Add secrets:
   - `RAILWAY_TOKEN` - Get from [railway.app/account/tokens](https://railway.app/account/tokens)
   - `OPENAI_API_KEY` - Your OpenAI API key

---

## API Reference

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check with stats |
| `/stats` | GET | Index statistics |
| `/sources` | GET | List indexed sources |
| `/search` | POST | RAG search (keyword/semantic/hybrid) |
| `/chat` | POST | RAG + LLM streaming response |
| `/chunks/:id` | GET | Retrieve specific chunk |

### Search Request
```json
{
  "query": "search terms",
  "mode": "keyword|semantic|hybrid",
  "top_k": 10,
  "query_vector": [...]  // Required for semantic/hybrid
}
```

### Chat Request
```json
{
  "question": "What is...?",
  "system_prompt": "Optional custom prompt",
  "model": "gpt-4o-mini",
  "top_k": 5
}
```

### Chat Response (SSE Stream)
```
data: {"type": "sources", "sources": [...]}
data: {"type": "delta", "text": "The answer..."}
data: {"type": "delta", "text": " continues..."}
data: {"type": "done"}
```

---

## Cost Estimates

| Service | Free Tier | Usage-Based |
|---------|-----------|-------------|
| Railway | $5/month credits | ~$0.000463/min/GB RAM |
| OpenAI (text-embedding-3-small) | - | $0.02 per 1M tokens |
| OpenAI (gpt-4o-mini) | - | $0.15 per 1M input tokens |

**Typical small project** (100 pages, light usage): ~$5-10/month

---

## Next Steps

- [ ] Add more data sources as your knowledge base grows
- [ ] Monitor usage in Railway dashboard
- [ ] Set up a custom domain in Railway settings
- [ ] Create a frontend chat UI (see vario-automation template)

---

*Generated by IndexFoundry*
