# Ollama.com cloud catalog via OLLAMA_API_KEY

**Branch:** `feature/ollama-cloud-catalog`
**Version bump:** minor (new feature → 0.16.0)

## Goal

When `OLLAMA_API_KEY` is set, build the model catalog from Ollama.com's own
API endpoints (`GET /api/tags` + `POST /api/show`) instead of scraping
ollama.com HTML. Cache the catalog in the `CatalogModel` table with a 24h TTL.
Show capabilities, parent model / family, parameter size, quantization level,
context length, and an ollama.com link on both the Discover page and the
Models page (list format).

Verified live (2026-10-16, unauthenticated requests behave identically):
- `GET https://ollama.com/api/tags` → `{ models: [{ name, model, modified_at, size, digest, details{parent_model, family, parameter_size, quantization_level (empty on tags)}, capabilities[] }] }` — cloud models catalog.
- `POST https://ollama.com/api/show {"model":"gemma4:31b-cloud"}` → `{ capabilities[], details{parent_model, family, parameter_size (raw count string), quantization_level}, model_info{"<family>.context_length", "general.parameter_count"} }`.
- Source docs: https://docs.ollama.com/api/tags.md and https://docs.ollama.com/api-reference/show-model-details.md

## Plan

- [ ] `lib/catalog-cloud.ts` — cloud fetch + enrichment; exported pure mappers (`mapApiCapabilities`, `formatParameterSize`, `extractContextLength`, map functions)
- [ ] `lib/catalog.ts` — unified `getCatalog(force)` with 24h DB cache; cloud when key set (scrape fallback on cloud failure), scrape otherwise; stale-DB fallback
- [ ] Schema `CatalogModel` + migration: capabilities, parentModel, parameterSize, quantizationLevel, contextLength, sizeBytes, url, sizes, pullCount, lastUpdated
- [ ] `/api/catalog` + `/api/catalog/seed` use the service; `X-Catalog-Stale` header
- [ ] `/api/admin/models` — enrich local models with capabilities + context length (24h in-memory per-server cache, bounded concurrency)
- [ ] Discover page — list columns: Family, Params, Quant, Context, ollama.com link
- [ ] Models page — convert card grid to list format with the same columns
- [ ] i18n keys (en, es, ca, fr); `.env.example`; CLAUDE.md catalog section
- [ ] Unit tests (`lib/__tests__/catalog-cloud.test.ts`)
- [ ] Gate: `npm test`, `npx next lint`, `npm run build`; bump 0.16.0

## Notes / decisions

- `CatalogModel` table is unused legacy (no code wrote to it) → reshape freely; migration drops + recreates.
- Cloud `/api/show` reports `parameter_size` as a raw count string ("32682372656") → format to "32.7B".
- API capabilities use "completion" → mapped to "text" for the existing UI filters; "decision" passes through.
- `parent_model` for cloud models echoes the full name (e.g. "gemma4:31b-cloud") → only shown when different from the model name and non-empty.
- Context length read from `model_info` key matching `/\.context_length$/` (family-prefixed), fallback `context_length`.
- Model page link: `https://ollama.com/library/<name-without-tag>`.
- Model page list format reuses the Discover list styling; local models get context length from server-side `/api/show` enrichment.

## Review

**Done 2026-10-16** — all plan items complete.

- Verified live end-to-end (dummy key, endpoints answer unauthenticated as documented):
  first `GET /api/catalog` fetched 19 cloud models + per-model `/api/show` enrichment in ~3.3s
  and persisted to `CatalogModel`; subsequent requests served from the 24h DB cache in ~30ms
  with full detail columns (e.g. `parameterSize: "763.2B"`, `quantizationLevel: "FP8"`,
  `contextLength: 1048576`, `sizeBytes: 486723007816`).
- Bug found in smoke test and fixed: cloud `size` overflows a 32-bit Int → `sizeBytes` is
  `BigInt` in Prisma, converted to `Number` at the row/entry boundary (BigInt is not
  JSON-serializable).
- Gates: `vitest run` 204/204, `tsc --noEmit` clean, `eslint .` clean, `next build` success.
- Not done: CLAUDE.md catalog docs (write-protected for agents — paragraph handed to user);
  a live authenticated run needs a real `OLLAMA_API_KEY`.
