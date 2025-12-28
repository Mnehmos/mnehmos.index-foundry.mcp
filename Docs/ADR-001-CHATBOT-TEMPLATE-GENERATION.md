# ADR-001: IndexFoundry Deploy Enhancement

## Status
✅ **IMPLEMENTED** - All tasks completed 2025-12-26

## Date
2025-12-26

## Context

### Planning Artifacts Reviewed

**Parent Directory**: `C:\Users\mnehm\Desktop\vario-automation\planning\`

| Document | Purpose | Status |
|----------|---------|--------|
| [`README.md`](file:///C:/Users/mnehm/Desktop/vario-automation/planning/README.md) | Project summary | IndexFoundry is 95% complete |
| [`01-analysis.md`](file:///C:/Users/mnehm/Desktop/vario-automation/planning/01-analysis.md) | Gap analysis | Identified static file gaps |
| [`02-refactor-plan.md`](file:///C:/Users/mnehm/Desktop/vario-automation/planning/02-refactor-plan.md) | Implementation plan | Detailed code snippets |
| [`04-task-map.md`](file:///C:/Users/mnehm/Desktop/vario-automation/planning/04-task-map.md) | Atomic subtasks | Ready for delegation |

**Subdirectory**: `C:\Users\mnehm\Desktop\vario-automation\planning\indexfoundry-refactor\`

| Document | Purpose | Status |
|----------|---------|--------|
| [`01-vario-automation-analysis.md`](file:///C:/Users/mnehm/Desktop/vario-automation/planning/indexfoundry-refactor/01-vario-automation-analysis.md) | Reference architecture | Complete chatbot structure |
| [`02-indexfoundry-capabilities.md`](file:///C:/Users/mnehm/Desktop/vario-automation/planning/indexfoundry-refactor/02-indexfoundry-capabilities.md) | Capability audit | 42 tools, gaps identified |

### Implementation Status Audit

**Task Map Execution Progress (from `04-task-map.md`)**:

| Task ID | Description | Status | Evidence |
|---------|-------------|--------|----------|
| TASK-001a | .env.example generation | ✅ DONE | [`projects.ts:1572-1581`](../src/tools/projects.ts:1572) |
| TASK-001b | .dockerignore generation | ✅ DONE | [`projects.ts:1584-1595`](../src/tools/projects.ts:1584) |
| TASK-002 | Deploy tool schema | ✅ DONE | [`schemas-projects.ts:173`](../src/schemas-projects.ts:173) |
| TASK-003 | Deploy tool implementation | ✅ DONE | [`projects.ts:813-929`](../src/tools/projects.ts:813) |
| TASK-004 | Register tool in MCP server | ✅ DONE | [`index.ts:85,124,530-540`](../src/index.ts:530) |
| TASK-005 | Integration test | ✅ DONE | Test project created at `projects/test-deploy/` |

### Additional Fix Applied
| Task | Description | Evidence |
|------|-------------|----------|
| TASK-004-FIX | Add missing ErrorCode types | [`types.ts`](../src/types.ts) - Added `NOT_EXPORTED`, `ENV_VAR_FAILED`, `DEPLOY_FAILED` |

### Validation Summary

**Planning Documents Assessment: ✅ VALID - 100% EXECUTED**

| Criterion | Status | Notes |
|-----------|--------|-------|
| Technical Accuracy | ✅ | Analysis matches actual codebase |
| Task Map | ✅ | Executed from `04-task-map.md` |
| Implementation Progress | ✅ 100% | All tasks complete |
| Reference Architecture | ✅ | Vario-automation validated as template |

### Current IndexFoundry Capabilities (Verified)

From [`src/tools/projects.ts`](../src/tools/projects.ts:1):
- ✅ Project lifecycle management (create, build, query, export)
- ✅ MCP server code generation ([`generateMcpServerSource()`](../src/tools/projects.ts:1600))
- ✅ HTTP REST API with Express ([`/chat`](../src/tools/projects.ts:2141) endpoint with SSE streaming)
- ✅ Railway deployment files (Dockerfile, railway.toml)
- ✅ Multi-source ingestion (URL, sitemap, folder, PDF)
- ✅ Embedding generation (OpenAI)
- ✅ Keyword/semantic/hybrid search

### Identified Gaps (Validated)

| Gap | Impact | Priority |
|-----|--------|----------|
| No Frontend UI Generation | Requires manual UI creation | P0 |
| No Conversation State | Stateless `/chat` only | P1 |
| Single LLM Provider | OpenAI only | P2 |
| No Auth/Rate Limiting | Production risk | P2 |
| No Structured Logging | Debugging difficulty | P3 |
| No CI/CD Templates | Manual deployment | P3 |

## Decision

Extend IndexFoundry's `project_export` functionality to generate complete chatbot templates including:

1. **Frontend Templates**: Astro-based chat UI with SSE streaming and citations
2. **Backend Enhancements**: Conversation context, multi-LLM support
3. **DevEx Improvements**: Docker Compose, hot reload, CI/CD
4. **Production Hardening**: Auth middleware, rate limiting, logging

## Architecture

### New Tool: `indexfoundry_project_export_chatbot`

```typescript
interface ChatbotExportOptions extends ProjectExportInput {
  // Frontend options
  frontend_framework: "astro" | "react" | "vue" | "vanilla";
  frontend_deploy_target: "github-pages" | "vercel" | "netlify" | "railway";
  
  // Backend enhancements
  llm_providers: Array<"openai" | "anthropic" | "cohere">;
  enable_auth: boolean;
  auth_type?: "api-key" | "jwt" | "oauth2";
  enable_rate_limiting: boolean;
  
  // DevEx
  include_docker_compose: boolean;
  include_github_actions: boolean;
  
  // Production
  logging_format: "json" | "text";
  include_metrics_endpoint: boolean;
}
```

### File Generation Structure

```
projects/<project_id>/
├── [existing files]
├── frontend/                    # NEW: Chat UI
│   ├── src/
│   │   ├── pages/
│   │   │   └── demo.astro      # Chat interface
│   │   ├── components/
│   │   │   ├── ChatWidget.tsx  # Optional React version
│   │   │   └── CitationModal.tsx
│   │   └── styles/
│   │       └── chat.css
│   ├── public/
│   │   └── local.config.js.example
│   ├── astro.config.mjs
│   └── package.json
├── docker-compose.yml           # NEW: Local dev
├── .github/
│   └── workflows/
│       ├── deploy-frontend.yml  # NEW: GitHub Pages
│       └── deploy-backend.yml   # NEW: Railway
└── src/
    └── index.ts                # ENHANCED: Auth, rate limit, logging
```

## Task Map

### Phase 1: Frontend Template (P0)
| Task ID | Description | Mode | Dependencies | Acceptance Criteria |
|---------|-------------|------|--------------|---------------------|
| FE-1 | Create Astro chat page template | code | - | SSE streaming works, citations render |
| FE-2 | Create citation modal component | code | FE-1 | Modal shows source, score, link |
| FE-3 | Add example questions system | code | FE-1 | 3+ example questions configurable |
| FE-4 | Create Tailwind CSS styling | code | FE-1 | Responsive, dark/light mode |
| FE-5 | Create React version (optional) | code | FE-1 | Feature parity with Astro |

### Phase 2: Backend Enhancements (P1-P2)
| Task ID | Description | Mode | Dependencies | Acceptance Criteria |
|---------|-------------|------|--------------|---------------------|
| BE-1 | Add Anthropic Claude integration | code | - | /chat supports model: "claude-*" |
| BE-2 | Add conversation context | code | - | Session-based multi-turn |
| BE-3 | Add auth middleware template | code | - | API key validation works |
| BE-4 | Add rate limiting | code | - | Configurable req/min |
| BE-5 | Add structured JSON logging | code | - | Logs parse as JSON |

### Phase 3: DevEx (P3)
| Task ID | Description | Mode | Dependencies | Acceptance Criteria |
|---------|-------------|------|--------------|---------------------|
| DX-1 | Create docker-compose.yml | code | - | `docker compose up` starts both services |
| DX-2 | Create GitHub Actions workflows | code | - | Push triggers deploy |
| DX-3 | Add hot reload for dev | code | - | File changes auto-reload |
| DX-4 | Update project_export tool | code | All above | New options work |

### Phase 4: Tests
| Task ID | Description | Mode | Dependencies | Acceptance Criteria |
|---------|-------------|------|--------------|---------------------|
| T-1 | Unit tests for new generators | red-phase/green-phase | Phase 1-3 | 80%+ coverage |
| T-2 | Integration test for export | red-phase/green-phase | DX-4 | Full export generates valid project |

## Consequences

### Positive
- IndexFoundry becomes complete chatbot factory
- Users can deploy in minutes, not hours
- Reference architecture validated in production (vario-automation)

### Negative
- Larger generated projects (more files)
- More maintenance surface for templates
- Frontend framework lock-in (mitigated by multiple options)

### Risks
- Frontend frameworks evolve rapidly (mitigate: pin versions, keep templates simple)
- Template drift from best practices (mitigate: periodic audits)

## References

- [01-vario-automation-analysis.md](file:///C:/Users/mnehm/Desktop/vario-automation/planning/indexfoundry-refactor/01-vario-automation-analysis.md)
- [02-indexfoundry-capabilities.md](file:///C:/Users/mnehm/Desktop/vario-automation/planning/indexfoundry-refactor/02-indexfoundry-capabilities.md)
- [`src/tools/projects.ts`](../src/tools/projects.ts) - Current implementation
