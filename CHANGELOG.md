# Changelog

All notable changes to IndexFoundry-MCP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-01-10

### Added

- **Librarian Protocol** (ADR-007): Operational workflow layer for state verification and self-correction
  - `indexfoundry_librarian_audit`: Audit project state for health and readiness
  - `indexfoundry_librarian_assess`: Assess retrieval quality after queries
  - Quality thresholds: min_chunk_score (0.50), avg_result_score (0.65), classification_confidence (0.50)
  - Full documentation in `Docs/ADR-007-LIBRARIAN-PROTOCOL.md` and `Docs/LIBRARIAN-EXAMPLES.md`

- **Batch Source Management** (ADR-005): Add/remove multiple sources in single operations
  - `project_add_source` now supports `batch` array for up to 50 sources
  - `project_remove_source` with cascade deletion options
  - Duplicate detection and skip behavior

- **Build Chunking** (ADR-006): Handle large builds with checkpointing
  - `project_build_status`: Check build progress and checkpoint state
  - Checkpointing support for resumable builds
  - Configurable `max_sources_per_build` and `fetch_concurrency`

- **Test Scripts**: Added `test:watch` for development convenience
- **Prepublish Safety**: Added `prepublishOnly` script to ensure clean builds before NPM publish

### Changed

- **License**: Changed from MIT to Proprietary Software License
- **Code Consolidation**: Deduplicated `cosineSimilarity` function (was duplicated 4x, now single export from `utils.ts`)
- **SHA256 Utility**: Centralized all SHA256 hashing through `utils.sha256()` function

### Fixed

- **tables.ts**: Now uses centralized `sha256` utility instead of inline `createHash`
- **serve.ts**: Removed duplicate `cosineSimilarity` function, imports from utils
- **projects.ts**: Removed duplicate `cosineSimilarity` function, imports from utils

### Removed

- **Stale Code**: Deleted 11 legacy TypeScript files from `Docs/` directory that were old code versions:
  - `connect.ts`, `extract.ts`, `index-tools.ts`, `index.ts`, `normalize.ts`
  - `pipeline.ts`, `serve.ts`, `types.ts`, `utils.ts`
  - `package.json`, `tsconfig.json`

### Security

- Updated `.gitignore` to exclude:
  - Database files (`*.db`, `*.sqlite`, `*.sqlite3`)
  - Screenshot artifacts (`screenshots/`)

## Architecture Decision Records

| ADR | Title | Status |
|-----|-------|--------|
| ADR-005 | Batch Source Management | Implemented |
| ADR-006 | Build Chunking Large Requests | Implemented |
| ADR-007 | Librarian Protocol | Implemented |

## Migration Notes

### From Pre-1.0 Versions

1. **License Change**: This version uses a Proprietary license. Review terms before use in new projects.

2. **No Breaking API Changes**: All existing tool calls remain compatible.

3. **New Capabilities**:
   - Use `batch` parameter in `project_add_source` for bulk operations
   - Use `project_build_status` to check checkpoint state before builds
   - Use Librarian tools (`librarian_audit`, `librarian_assess`) for production deployments

---

*For detailed documentation, see [PROJECT_KNOWLEDGE.md](./PROJECT_KNOWLEDGE.md)*
