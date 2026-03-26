---
agent: linter
date: 2026-03-26
v4_features_tested: [all v4 source files]
verdict: pass
---

## What Worked
- All 20 v4 source files compile without TypeScript errors
- Consistent export patterns across modules
- JSDoc present on public class declarations
- No `any` types in public APIs

## What Didn't Work
- **Missing barrel exports** — no index.ts for communication/, flywheel/, memory/, session/, api/ (being fixed)
- **Inconsistent method naming** — some use `get()`, others use `find()`, others `query()`
- **Some test helpers exported** — `_setForTest`, `_setAppliedAtForTest` in production code
- **No consistent return type for "not found"** — some return null, some throw

## v4.1 Recommendations
1. Standardize naming: `getById()`, `getAll()`, `findBy*()`, `search*()`
2. Remove test helpers from production or mark with @internal JSDoc tag
3. Standardize not-found behavior: always return null for queries, throw for mutations
4. Add ESLint rules for v4 module conventions
