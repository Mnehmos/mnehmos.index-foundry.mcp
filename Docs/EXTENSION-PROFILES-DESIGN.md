# Extension Profiles for Exported RAG Servers

## Design Document

**Version:** 1.0.0  
**Created:** 2025-12-25  
**Status:** Draft  

---

## 1. Executive Summary

This document defines **Extension Profiles** for IndexFoundry exported servers. Profiles provide a tiered approach to feature inclusion, allowing operators to choose between:

- **Minimal runtime** (production-optimized search appliances)
- **Operator tools** (development & debugging capabilities)
- **Agent assist** (AI agent integration features)

This architecture maintains the clean separation between the Factory Layer (IndexFoundry MCP Server with full intelligence tools) and the Runtime Layer (exported project servers).

---

## 2. Profile Specifications

### 2.1 Profile Tier Summary

| Profile | Use Case | Approx. Lines | Dependencies | Startup Time |
|---------|----------|---------------|--------------|--------------|
| `minimal-runtime` | Production, edge servers | ~500 | SDK + express | Fast |
| `operator-tools` | Development, debugging | ~1000 | SDK + express | Medium |
| `agent-assist` | AI agent integration | ~1500 | SDK + express + zod | Medium |

### 2.2 Profile 1: `minimal-runtime` (Default)

**Purpose:** Production deployments requiring minimal footprint and fastest startup.

**Features Included:**

| Category | Feature | Description |
|----------|---------|-------------|
| **Core Search** | `search` | Keyword, semantic, and hybrid search |
| **Core Search** | `get_chunk` | Retrieve specific chunk by ID |
| **Core Search** | `list_sources` | List all indexed sources |
| **Observability** | `stats` | Index statistics (chunk/vector counts) |
| **HTTP** | `/health` | Health check endpoint |
| **HTTP** | `/stats` | Stats endpoint |
| **HTTP** | `/sources` | List sources endpoint |
| **HTTP** | `/search` | Search endpoint (POST) |
| **HTTP** | `/chunks/:id` | Get chunk by ID |
| **HTTP** | `/chat` | RAG + LLM streaming (optional) |

**Generated Structure:**
```
src/
└── index.ts          # ~500 lines, all-in-one
```

**Code Characteristics:**
- No Zod runtime validation (trust factory pre-processing)
- Inline type definitions
- No debug logging beyond request logging
- Minimal error messages

---

### 2.3 Profile 2: `operator-tools`

**Purpose:** Development, debugging, and operator workflows requiring introspection.

**Features Included (extends `minimal-runtime`):**

| Category | Feature | Description |
|----------|---------|-------------|
| **Intelligence** | `classify_query` | Query type classification (factual/procedural/etc.) |
| **Intelligence** | `debug_search` | Retrieval trace with similarity scores |
| **Intelligence** | `expand_context` | Fetch adjacent/parent chunks |
| **Introspection** | `introspect` | Server capability introspection |
| **HTTP** | `/classify` | Query classification endpoint |
| **HTTP** | `/debug` | Debug search endpoint |
| **HTTP** | `/expand/:chunk_id` | Context expansion endpoint |
| **HTTP** | `/introspect` | Server introspection |

**Generated Structure:**
```
src/
├── index.ts          # Main server (~300 lines)
├── tools/
│   ├── search.ts     # Core search (~200 lines)
│   ├── classify.ts   # Query classification (~150 lines)
│   ├── debug.ts      # Debug search (~200 lines)
│   └── hydrate.ts    # Context expansion (~150 lines)
└── types.ts          # Shared types (~50 lines)
```

**Code Characteristics:**
- Modular file structure
- Enhanced error messages with suggestions
- Trace logging for pipeline steps
- Input validation with helpful errors

---

### 2.4 Profile 3: `agent-assist`

**Purpose:** AI agent integration with advanced RAG workflow support.

**Features Included (extends `operator-tools`):**

| Category | Feature | Description |
|----------|---------|-------------|
| **Agent** | `plan_query` | Multi-step query planning helpers |
| **Agent** | `rerank_inspect` | Reranking score inspection |
| **Agent** | `explain_chunk` | Chunk explanation mode (why this chunk?) |
| **Metrics** | `quality_metrics` | Retrieval quality metrics (MRR, NDCG) |
| **HTTP** | `/plan` | Query planning endpoint |
| **HTTP** | `/rerank` | Rerank inspection endpoint |
| **HTTP** | `/explain/:chunk_id` | Chunk explanation |
| **HTTP** | `/metrics` | Quality metrics endpoint |

**Generated Structure:**
```
src/
├── index.ts          # Main server (~300 lines)
├── tools/
│   ├── search.ts     # Core search (~200 lines)
│   ├── classify.ts   # Query classification (~150 lines)
│   ├── debug.ts      # Debug search (~200 lines)
│   ├── hydrate.ts    # Context expansion (~150 lines)
│   ├── plan.ts       # Query planning (~150 lines)
│   ├── rerank.ts     # Rerank inspection (~100 lines)
│   └── explain.ts    # Chunk explanation (~150 lines)
├── metrics/
│   └── quality.ts    # Quality metrics (~200 lines)
└── types.ts          # Shared types (~100 lines)
```

**Code Characteristics:**
- Full Zod validation with schemas
- Comprehensive error handling
- Structured logging with correlation IDs
- OpenTelemetry-ready instrumentation hooks

---

## 3. Schema Design

### 3.1 Enhanced Export Schema

```typescript
// src/schemas-projects.ts - Enhanced ProjectExportSchema

import { z } from "zod";

/**
 * Available extension profiles for exported servers.
 */
export const ExtensionProfileEnum = z.enum([
  "minimal-runtime",
  "operator-tools", 
  "agent-assist"
]);

export type ExtensionProfile = z.infer<typeof ExtensionProfileEnum>;

/**
 * Available granular features for custom exports.
 */
export const ExportFeatureEnum = z.enum([
  // Core (always included)
  "search",
  "get_chunk",
  "list_sources",
  "stats",
  
  // Operator tools
  "classify",
  "debug",
  "hydrate",
  "introspect",
  
  // Agent assist
  "plan",
  "rerank",
  "explain",
  "metrics"
]);

export type ExportFeature = z.infer<typeof ExportFeatureEnum>;

/**
 * Enhanced export input schema with profile support.
 */
export const ProjectExportSchema = z.object({
  project_id: safeProjectId,

  // Server configuration
  server_name: z.string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "Server name must be lowercase alphanumeric with hyphens")
    .optional()
    .describe("MCP server name (defaults to project_id)"),
  
  server_description: z.string().max(512).optional(),
  
  // ─────────────────────────────────────────────────────────
  // NEW: Extension profile selection
  // ─────────────────────────────────────────────────────────
  
  profile: ExtensionProfileEnum
    .default("minimal-runtime")
    .describe("Feature profile: minimal-runtime | operator-tools | agent-assist"),
  
  features: z.array(ExportFeatureEnum)
    .optional()
    .describe("Specific features to include (overrides profile if provided)"),
  
  // ─────────────────────────────────────────────────────────
  // Deployment options
  // ─────────────────────────────────────────────────────────
  
  include_http: z.boolean().default(true)
    .describe("Include HTTP endpoints alongside MCP"),
  
  include_chat: z.boolean().default(true)
    .describe("Include /chat endpoint for RAG + LLM"),
  
  port: z.number().int().min(1024).max(65535).default(8080),
  
  // Platform-specific configs
  railway_config: z.boolean().default(true),
  
  // ─────────────────────────────────────────────────────────
  // Advanced options
  // ─────────────────────────────────────────────────────────
  
  modular_output: z.boolean().default(false)
    .describe("Generate modular file structure (auto-enabled for operator-tools+)"),
  
  include_types: z.boolean().default(false)
    .describe("Generate separate types.ts file"),
  
  validation_level: z.enum(["none", "basic", "strict"]).default("basic")
    .describe("Input validation level: none | basic | strict (Zod)"),
});

export type ProjectExportInput = z.infer<typeof ProjectExportSchema>;
```

### 3.2 Feature Resolution Logic

```typescript
// src/tools/projects.ts - Feature resolution

/**
 * Feature sets for each profile tier.
 */
const PROFILE_FEATURES: Record<ExtensionProfile, ExportFeature[]> = {
  "minimal-runtime": [
    "search",
    "get_chunk", 
    "list_sources",
    "stats"
  ],
  
  "operator-tools": [
    // Inherits minimal-runtime
    "search",
    "get_chunk",
    "list_sources", 
    "stats",
    // Plus operator tools
    "classify",
    "debug",
    "hydrate",
    "introspect"
  ],
  
  "agent-assist": [
    // Inherits operator-tools
    "search",
    "get_chunk",
    "list_sources",
    "stats",
    "classify",
    "debug",
    "hydrate",
    "introspect",
    // Plus agent assist
    "plan",
    "rerank",
    "explain",
    "metrics"
  ]
};

/**
 * Resolve effective features based on profile and explicit feature list.
 * 
 * @param profile - Selected profile tier
 * @param features - Optional explicit feature list (overrides profile)
 * @returns Resolved feature set
 */
function resolveFeatures(
  profile: ExtensionProfile,
  features?: ExportFeature[]
): Set<ExportFeature> {
  // Explicit features override profile
  if (features && features.length > 0) {
    // Always include core features
    const core: ExportFeature[] = ["search", "get_chunk", "list_sources", "stats"];
    return new Set([...core, ...features]);
  }
  
  // Use profile defaults
  return new Set(PROFILE_FEATURES[profile]);
}
```

---

## 4. Template Composition Architecture

### 4.1 Recommended Approach: Template Composition

Instead of complex conditionals, we use a **composition pattern** with discrete feature modules.

```
templates/
├── base/
│   ├── header.ts.template       # Copyright, imports
│   ├── types.ts.template        # Core type definitions
│   ├── data-loading.ts.template # JSONL loading, chunk/vector maps
│   ├── search.ts.template       # Core search functions
│   ├── mcp-server.ts.template   # MCP server setup and handlers
│   ├── http-server.ts.template  # Express server setup
│   └── startup.ts.template      # Server startup logic
│
├── features/
│   ├── classify.ts.template     # Query classification
│   ├── debug.ts.template        # Debug/trace search
│   ├── hydrate.ts.template      # Context expansion
│   ├── introspect.ts.template   # Server introspection
│   ├── plan.ts.template         # Query planning
│   ├── rerank.ts.template       # Rerank inspection
│   ├── explain.ts.template      # Chunk explanation
│   └── metrics.ts.template      # Quality metrics
│
├── http/
│   ├── classify-routes.ts.template
│   ├── debug-routes.ts.template
│   ├── hydrate-routes.ts.template
│   └── ... (feature routes)
│
└── index.ts                     # Template composition engine
```

### 4.2 Template Variables

Each template has access to these variables:

```typescript
interface TemplateContext {
  // Server identity
  serverName: string;
  serverDescription: string;
  projectId: string;
  
  // Configuration
  port: number;
  profile: ExtensionProfile;
  features: Set<ExportFeature>;
  
  // Build info
  generatedAt: string;
  version: string;
  
  // Feature flags (derived from features set)
  hasClassify: boolean;
  hasDebug: boolean;
  hasHydrate: boolean;
  hasIntrospect: boolean;
  hasPlan: boolean;
  hasRerank: boolean;
  hasExplain: boolean;
  hasMetrics: boolean;
  
  // Stats (from manifest)
  stats: {
    sources: number;
    chunks: number;
    vectors: number;
  };
}
```

### 4.3 Composition Engine

```typescript
// templates/index.ts - Template composition engine

import { TemplateContext, ExportFeature } from './types';

/**
 * Template module with content generator and dependencies.
 */
interface TemplateModule {
  /** Template content generator */
  render: (ctx: TemplateContext) => string;
  /** Features that include this module */
  features: ExportFeature[];
  /** Module dependencies (other template IDs) */
  dependencies?: string[];
  /** Output file path (relative to src/) */
  outputPath: string;
}

/**
 * Registry of all template modules.
 */
const TEMPLATE_REGISTRY: Map<string, TemplateModule> = new Map([
  ['base/types', {
    render: renderTypes,
    features: ['search'], // Always included
    outputPath: 'types.ts'
  }],
  
  ['base/search', {
    render: renderSearch,
    features: ['search'],
    outputPath: 'tools/search.ts'
  }],
  
  ['features/classify', {
    render: renderClassify,
    features: ['classify'],
    dependencies: ['base/types'],
    outputPath: 'tools/classify.ts'
  }],
  
  // ... more modules
]);

/**
 * Compose all templates for given feature set.
 * 
 * For minimal-runtime: outputs single index.ts
 * For operator-tools+: outputs modular file structure
 */
export function composeTemplates(ctx: TemplateContext): Map<string, string> {
  const output = new Map<string, string>();
  
  if (ctx.profile === 'minimal-runtime') {
    // Single file output
    output.set('src/index.ts', renderMonolithicServer(ctx));
  } else {
    // Modular output
    for (const [id, module] of TEMPLATE_REGISTRY) {
      const shouldInclude = module.features.some(f => ctx.features.has(f));
      if (shouldInclude) {
        output.set(`src/${module.outputPath}`, module.render(ctx));
      }
    }
    
    // Generate main index.ts that imports modules
    output.set('src/index.ts', renderModularIndex(ctx));
  }
  
  return output;
}
```

### 4.4 Example Template: Classify Feature

```typescript
// templates/features/classify.ts.template

export function renderClassify(ctx: TemplateContext): string {
  return `/**
 * Query Classification - ${ctx.serverName}
 * 
 * Auto-generated by IndexFoundry (${ctx.profile} profile)
 * Generated: ${ctx.generatedAt}
 */

import type { Chunk } from '../types.js';

// ============================================================================
// Types
// ============================================================================

export type QueryType = 'factual' | 'procedural' | 'conceptual' | 'navigational' | 'conversational';
export type QueryComplexity = 'simple' | 'medium' | 'complex';
export type SearchMode = 'semantic' | 'keyword' | 'hybrid';

export interface ClassifyResult {
  query: string;
  needs_retrieval: boolean;
  confidence: number;
  classification: {
    type: QueryType;
    subtype?: string;
  };
  complexity: QueryComplexity;
  retrieval_hints?: {
    suggested_top_k: number;
    suggested_mode: SearchMode;
  };
}

// ============================================================================
// Pattern Definitions
// ============================================================================

const QUERY_TYPE_PATTERNS = {
  factual: [
    /^what (is|are|was|were)\\b/i,
    /^who (is|are|was|were)\\b/i,
    /^when (did|was|is|were)\\b/i,
    /^how (much|many|long|far|old)\\b/i,
  ],
  procedural: [
    /^how (to|do|can|should|would)\\b/i,
    /\\bsteps to\\b/i,
    /\\binstructions? for\\b/i,
  ],
  conceptual: [
    /^explain\\b/i,
    /^why (does|do|is|are|did)\\b/i,
    /\\bwhat causes\\b/i,
  ],
  navigational: [
    /^where\\b/i,
    /^find\\b/i,
    /\\bsection\\s+\\d/i,
  ],
  conversational: [
    /^(thanks|thank you|thx)\\b/i,
    /^(hello|hi|hey)\\b/i,
    /^(yes|no|sure)\\b/i,
  ],
};

// ============================================================================
// Classification Function
// ============================================================================

export function classifyQuery(query: string): ClassifyResult {
  const normalized = query.toLowerCase().trim();
  
  // Detect query type
  let type: QueryType = 'factual';
  for (const [qType, patterns] of Object.entries(QUERY_TYPE_PATTERNS)) {
    if (patterns.some(p => p.test(normalized))) {
      type = qType as QueryType;
      break;
    }
  }
  
  // Assess complexity
  const wordCount = normalized.split(/\\s+/).length;
  const complexity: QueryComplexity = 
    wordCount > 20 ? 'complex' :
    wordCount > 10 ? 'medium' : 'simple';
  
  // Determine if retrieval needed
  const needs_retrieval = type !== 'conversational';
  
  // Calculate confidence
  const confidence = type === 'conversational' ? 0.9 : 0.75;
  
  return {
    query,
    needs_retrieval,
    confidence,
    classification: { type },
    complexity,
    retrieval_hints: needs_retrieval ? {
      suggested_top_k: complexity === 'complex' ? 15 : complexity === 'medium' ? 7 : 3,
      suggested_mode: type === 'conceptual' ? 'semantic' : 'hybrid',
    } : undefined,
  };
}
`;
}
```

---

## 5. File Structure

### 5.1 Source Structure (IndexFoundry Factory)

```
src/
├── templates/
│   ├── base/
│   │   ├── header.template.ts
│   │   ├── types.template.ts
│   │   ├── data-loading.template.ts
│   │   ├── search.template.ts
│   │   ├── mcp-server.template.ts
│   │   ├── http-server.template.ts
│   │   └── startup.template.ts
│   │
│   ├── features/
│   │   ├── classify.template.ts
│   │   ├── debug.template.ts
│   │   ├── hydrate.template.ts
│   │   ├── introspect.template.ts
│   │   ├── plan.template.ts
│   │   ├── rerank.template.ts
│   │   ├── explain.template.ts
│   │   └── metrics.template.ts
│   │
│   ├── http/
│   │   ├── core-routes.template.ts
│   │   ├── classify-routes.template.ts
│   │   ├── debug-routes.template.ts
│   │   └── ... (feature routes)
│   │
│   ├── config/
│   │   ├── package-json.template.ts
│   │   ├── tsconfig.template.ts
│   │   ├── dockerfile.template.ts
│   │   └── railway.template.ts
│   │
│   ├── compose.ts          # Template composition engine
│   ├── render.ts           # Template rendering utilities
│   └── types.ts            # Template context types
│
├── tools/
│   └── projects.ts         # Enhanced with template composition
│
└── schemas-projects.ts     # Enhanced export schema
```

### 5.2 Generated Output Structure

**minimal-runtime (single file):**
```
projects/{project-id}/
├── src/
│   └── index.ts            # ~500 lines, monolithic
├── data/
│   ├── chunks.jsonl
│   └── vectors.jsonl
├── sources.jsonl
├── project.json            # With export metadata
├── package.json
├── tsconfig.json
├── Dockerfile
├── railway.toml
└── README.md
```

**operator-tools (modular):**
```
projects/{project-id}/
├── src/
│   ├── index.ts            # ~200 lines, imports modules
│   ├── types.ts            # Shared type definitions
│   └── tools/
│       ├── search.ts       # Core search
│       ├── classify.ts     # Query classification
│       ├── debug.ts        # Debug/trace
│       └── hydrate.ts      # Context expansion
├── data/
│   ├── chunks.jsonl
│   └── vectors.jsonl
├── sources.jsonl
├── project.json
├── package.json
├── tsconfig.json
├── Dockerfile
├── railway.toml
└── README.md
```

**agent-assist (full modular):**
```
projects/{project-id}/
├── src/
│   ├── index.ts            # ~200 lines
│   ├── types.ts            # Shared types
│   ├── tools/
│   │   ├── search.ts
│   │   ├── classify.ts
│   │   ├── debug.ts
│   │   ├── hydrate.ts
│   │   ├── plan.ts
│   │   ├── rerank.ts
│   │   └── explain.ts
│   └── metrics/
│       └── quality.ts
├── data/
│   ├── chunks.jsonl
│   └── vectors.jsonl
├── sources.jsonl
├── project.json
├── package.json
├── tsconfig.json
├── Dockerfile
├── railway.toml
└── README.md
```

---

## 6. Manifest Tracking

### 6.1 Enhanced Project Manifest

```typescript
// project.json structure
interface ProjectManifest {
  project_id: string;
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
  
  // Embedding configuration
  embedding_model: {
    provider: string;
    model_name: string;
  };
  
  // Chunk configuration
  chunk_config: {
    strategy: string;
    max_chars: number;
    overlap_chars: number;
  };
  
  // Index statistics
  stats: {
    sources_count: number;
    chunks_count: number;
    vectors_count: number;
    total_tokens: number;
  };
  
  // ─────────────────────────────────────────────────────────
  // NEW: Export metadata
  // ─────────────────────────────────────────────────────────
  export?: {
    /** Selected profile tier */
    profile: ExtensionProfile;
    
    /** Resolved feature list */
    features: ExportFeature[];
    
    /** Export timestamp */
    exported_at: string;
    
    /** IndexFoundry version used for export */
    generator_version: string;
    
    /** Export configuration used */
    config: {
      include_http: boolean;
      include_chat: boolean;
      port: number;
      modular_output: boolean;
      validation_level: 'none' | 'basic' | 'strict';
    };
    
    /** Generated files list */
    files: string[];
  };
}
```

### 6.2 Example Manifest

```json
{
  "project_id": "msha-rag-v2",
  "name": "MSHA Mine Safety RAG",
  "description": "Mine safety documentation search",
  "created_at": "2025-12-25T20:00:00Z",
  "updated_at": "2025-12-25T22:00:00Z",
  "embedding_model": {
    "provider": "openai",
    "model_name": "text-embedding-3-small"
  },
  "chunk_config": {
    "strategy": "recursive",
    "max_chars": 1500,
    "overlap_chars": 150
  },
  "stats": {
    "sources_count": 3,
    "chunks_count": 127,
    "vectors_count": 127,
    "total_tokens": 45200
  },
  "export": {
    "profile": "operator-tools",
    "features": [
      "search",
      "get_chunk",
      "list_sources",
      "stats",
      "classify",
      "debug",
      "hydrate",
      "introspect"
    ],
    "exported_at": "2025-12-25T22:30:00Z",
    "generator_version": "1.1.0",
    "config": {
      "include_http": true,
      "include_chat": true,
      "port": 8080,
      "modular_output": true,
      "validation_level": "basic"
    },
    "files": [
      "src/index.ts",
      "src/types.ts",
      "src/tools/search.ts",
      "src/tools/classify.ts",
      "src/tools/debug.ts",
      "src/tools/hydrate.ts",
      "package.json",
      "tsconfig.json",
      "Dockerfile",
      "railway.toml",
      "README.md"
    ]
  }
}
```

---

## 7. Implementation Plan (TDD Tasks)

### 7.1 Phase 1: Schema & Types

| Task ID | Objective | Mode | Dependencies | Acceptance Criteria |
|---------|-----------|------|--------------|---------------------|
| `EP-001` | Add `ExtensionProfileEnum` to schemas | `red-phase` | - | Test validates enum values: minimal-runtime, operator-tools, agent-assist |
| `EP-002` | Add `ExportFeatureEnum` to schemas | `red-phase` | EP-001 | Test validates all 12 feature enum values |
| `EP-003` | Extend `ProjectExportSchema` with profile/features | `green-phase` | EP-002 | Schema validates profile + features inputs |
| `EP-004` | Add feature resolution logic | `green-phase` | EP-003 | `resolveFeatures()` returns correct sets for each profile |

### 7.2 Phase 2: Template Infrastructure

| Task ID | Objective | Mode | Dependencies | Acceptance Criteria |
|---------|-----------|------|--------------|---------------------|
| `EP-005` | Create template directory structure | `code` | EP-004 | Directories exist: templates/{base,features,http,config} |
| `EP-006` | Implement `TemplateContext` type | `red-phase` | EP-005 | Type has all required fields per spec |
| `EP-007` | Implement base template rendering | `green-phase` | EP-006 | Can render header, types, data-loading templates |
| `EP-008` | Implement template composition engine | `green-phase` | EP-007 | `composeTemplates()` produces file map |

### 7.3 Phase 3: Minimal Runtime Templates

| Task ID | Objective | Mode | Dependencies | Acceptance Criteria |
|---------|-----------|------|--------------|---------------------|
| `EP-009` | Port existing monolithic template | `green-phase` | EP-008 | Current export behavior preserved |
| `EP-010` | Add minimal-runtime tests | `red-phase` | EP-009 | Tests validate ~500 line output, no extra features |
| `EP-011` | Refactor to use template engine | `blue-phase` | EP-010 | All tests pass, code uses new engine |

### 7.4 Phase 4: Operator Tools Templates

| Task ID | Objective | Mode | Dependencies | Acceptance Criteria |
|---------|-----------|------|--------------|---------------------|
| `EP-012` | Create classify.template.ts | `green-phase` | EP-011 | Renders classify feature module |
| `EP-013` | Create debug.template.ts | `green-phase` | EP-012 | Renders debug feature module |
| `EP-014` | Create hydrate.template.ts | `green-phase` | EP-013 | Renders hydrate feature module |
| `EP-015` | Create introspect.template.ts | `green-phase` | EP-014 | Renders introspect feature module |
| `EP-016` | Add HTTP routes for operator tools | `green-phase` | EP-015 | Routes render for /classify, /debug, /expand |
| `EP-017` | Add operator-tools profile tests | `red-phase` | EP-016 | Tests validate modular output, all features present |
| `EP-018` | Integration test operator-tools export | `green-phase` | EP-017 | Full export generates working server |

### 7.5 Phase 5: Agent Assist Templates

| Task ID | Objective | Mode | Dependencies | Acceptance Criteria |
|---------|-----------|------|--------------|---------------------|
| `EP-019` | Create plan.template.ts | `green-phase` | EP-018 | Renders query planning module |
| `EP-020` | Create rerank.template.ts | `green-phase` | EP-019 | Renders rerank inspection module |
| `EP-021` | Create explain.template.ts | `green-phase` | EP-020 | Renders chunk explanation module |
| `EP-022` | Create metrics.template.ts | `green-phase` | EP-021 | Renders quality metrics module |
| `EP-023` | Add HTTP routes for agent assist | `green-phase` | EP-022 | Routes render for /plan, /rerank, /explain, /metrics |
| `EP-024` | Add agent-assist profile tests | `red-phase` | EP-023 | Tests validate full feature set |
| `EP-025` | Integration test agent-assist export | `green-phase` | EP-024 | Full export generates working server |

### 7.6 Phase 6: Documentation & Polish

| Task ID | Objective | Mode | Dependencies | Acceptance Criteria |
|---------|-----------|------|--------------|---------------------|
| `EP-026` | Update README.md generation | `green-phase` | EP-025 | README documents profile-specific features |
| `EP-027` | Add export CLI documentation | `memory` | EP-026 | Usage docs for profile selection |
| `EP-028` | Refactor for clean abstractions | `blue-phase` | EP-027 | Code review clean, no duplication |

---

## 8. Migration Path

### 8.1 Backward Compatibility

**Existing exports continue to work unchanged:**

1. **Default behavior unchanged**: `profile` defaults to `"minimal-runtime"`
2. **No features = profile defaults**: Empty `features` array uses profile defaults
3. **Current output preserved**: `minimal-runtime` generates identical output to current implementation

### 8.2 Migration Steps

**For existing projects:**

```bash
# Current (continues to work)
indexfoundry_project_export --project_id=my-project

# Equivalent to:
indexfoundry_project_export --project_id=my-project --profile=minimal-runtime

# Upgrade to operator-tools:
indexfoundry_project_export --project_id=my-project --profile=operator-tools

# Custom feature selection:
indexfoundry_project_export --project_id=my-project \
  --features=classify,debug
```

### 8.3 Re-export Workflow

Projects can be re-exported with different profiles:

```typescript
// Re-export with upgraded profile
await projectExport({
  project_id: "msha-rag-v2",
  profile: "operator-tools",
  // Data is preserved, only server code regenerated
});
```

**Preserved during re-export:**
- `data/chunks.jsonl`
- `data/vectors.jsonl`
- `sources.jsonl`
- Project statistics

**Regenerated during re-export:**
- `src/**/*.ts`
- `package.json`
- `tsconfig.json`
- `Dockerfile`
- `README.md`

---

## 9. Example Usage

### 9.1 MCP Tool Invocation

```json
{
  "tool": "indexfoundry_project_export",
  "arguments": {
    "project_id": "msha-rag-v2",
    "server_name": "msha-search",
    "profile": "operator-tools",
    "include_http": true,
    "port": 8080
  }
}
```

### 9.2 Custom Feature Selection

```json
{
  "tool": "indexfoundry_project_export", 
  "arguments": {
    "project_id": "msha-rag-v2",
    "features": ["classify", "hydrate"],
    "validation_level": "strict"
  }
}
```

### 9.3 CLI Equivalent

```bash
# Profile-based export
npx indexfoundry export msha-rag-v2 --profile=agent-assist

# Feature-based export  
npx indexfoundry export msha-rag-v2 --features=classify,debug,metrics
```

---

## 10. Future Considerations

### 10.1 Potential Extensions

- **Custom profile definitions**: Allow users to define custom profiles in config
- **Plugin system**: External feature modules that can be added to exports
- **Runtime profile switching**: Single build that can activate features via env vars
- **Profile inheritance**: Custom profiles that extend built-in profiles

### 10.2 Performance Optimizations

- **Tree-shaking**: Generate code that bundlers can optimize
- **Lazy loading**: Dynamic imports for heavy features
- **Conditional compilation**: TypeScript conditional types for profile-aware types

---

## 11. Appendix: Feature Reference

### 11.1 Core Features (Always Included)

| Feature | MCP Tool | HTTP Endpoint | Description |
|---------|----------|---------------|-------------|
| `search` | `search` | `POST /search` | Multi-mode search (keyword/semantic/hybrid) |
| `get_chunk` | `get_chunk` | `GET /chunks/:id` | Retrieve chunk by ID |
| `list_sources` | `list_sources` | `GET /sources` | List indexed sources |
| `stats` | `stats` | `GET /stats` | Index statistics |

### 11.2 Operator Tools Features

| Feature | MCP Tool | HTTP Endpoint | Description |
|---------|----------|---------------|-------------|
| `classify` | `classify_query` | `POST /classify` | Query type classification |
| `debug` | `debug_search` | `POST /debug` | Search with pipeline trace |
| `hydrate` | `expand_context` | `GET /expand/:id` | Fetch adjacent/parent chunks |
| `introspect` | `introspect` | `GET /introspect` | Server capability listing |

### 11.3 Agent Assist Features

| Feature | MCP Tool | HTTP Endpoint | Description |
|---------|----------|---------------|-------------|
| `plan` | `plan_query` | `POST /plan` | Multi-step query planning |
| `rerank` | `rerank_inspect` | `POST /rerank` | Reranking score inspection |
| `explain` | `explain_chunk` | `GET /explain/:id` | Why this chunk matched |
| `metrics` | `quality_metrics` | `GET /metrics` | MRR, NDCG, retrieval metrics |

---

*Document generated by IndexFoundry Planner Mode*
