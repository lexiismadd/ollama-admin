/**
 * Server-only HuggingFace model search client with live enrichment.
 *
 * When HUGGINGFACE_API_KEY is set, the Discover search queries HuggingFace
 * live and surfaces params/quant/context/size where available. Enriched
 * details are cached in the HuggingFaceModel table with a 7-day TTL — a
 * separate table from CatalogModel so "Refresh catalog" (ollama.com-only,
 * deleteMany + createMany) never touches HF rows.
 */
import { prisma } from "@/lib/prisma";
import { formatParameterSize } from "@/lib/catalog-cloud";

const HF_BASE_URL = "https://huggingface.co";
const SEARCH_TIMEOUT_MS = 15_000;
const DETAIL_TIMEOUT_MS = 12_000;
const DEFAULT_LIMIT = 20;
const HF_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface HuggingFaceModel {
  id: string;
  author?: string;
  lastModified?: string;
  createdAt?: string;
  downloads?: number;
  likes?: number;
  pipeline_tag?: string;
  library_name?: string;
  gated?: boolean | string;
  tags?: string[];
  siblings?: Array<{ rfilename: string }>;
}

export function isHuggingFaceEnabled(): boolean {
  return Boolean(process.env.HUGGINGFACE_API_KEY);
}

async function hfFetch(path: string, init?: RequestInit): Promise<Response> {
  const options: RequestInit = {
    ...init,
    headers: {
      ...(process.env.HUGGINGFACE_API_KEY
        ? { Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}` }
        : {}),
      ...init?.headers,
    },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  };
  const res = await fetch(`${HF_BASE_URL}${path}`, options);
  if (!res.ok) throw new Error(`HuggingFace API error: ${res.status} ${res.statusText}`);
  return res;
}

/** Map a HF pipeline tag to the UI capability vocabulary. */
function capabilitiesFromPipeline(pipelineTag: string | undefined, library: string | undefined): string[] {
  const caps: string[] = [];
  const p = (pipelineTag ?? "").toLowerCase();
  if (p.includes("text-generation") || p.includes("conversational")) caps.push("text");
  if (p.includes("image-text") || p.includes("vision") || p.includes("image-to")) caps.push("vision");
  if (p.includes("feature-extraction") || p.includes("embedding") || p.includes("sentence-similarity")) caps.push("embedding");
  if (p.includes("tool")) caps.push("tools");
  if (caps.length === 0) caps.push("text");
  // MLX-quantised repos surface as a distinct library.
  if (library === "mlx" && !caps.includes("thinking")) caps.push("thinking");
  return caps;
}

/** Derive a quant tag from GGUF siblings; empty for safetensors-only repos. */
function tagFromSiblings(model: HuggingFaceModel): string {
  const ggufs = (model.siblings ?? [])
    .map((s) => s.rfilename)
    .filter((f) => f.toLowerCase().endsWith(".gguf"));
  if (ggufs.length === 0) return "";
  // Prefer a canonical quant file name: "<something>-Q4_K_M.gguf".
  const quantMatch = ggufs[0].match(/([QIF][0-9]+(?:_[A-Z0-9]+)*)\.gguf$/i);
  return quantMatch ? quantMatch[1] : "";
}

/** Search HuggingFace models; returns CatalogEntry-shaped rows (not persisted). */
export async function searchHuggingFaceModels(
  query: string,
  limit = DEFAULT_LIMIT
): Promise<HuggingFaceModel[]> {
  const params = new URLSearchParams({ search: query, limit: String(limit), full: "true" });
  const res = await hfFetch(`/api/models?${params}`);
  const data = (await res.json()) as HuggingFaceModel[];
  return data ?? [];
}

/** Total download size of the repo's weight files (.safetensors/.gguf/.bin). */
async function fetchRepoSizeBytes(repoId: string): Promise<number | null> {
  try {
    const res = await hfFetch(`/api/models/${repoId}/tree/main?recursive=true`, {
      signal: AbortSignal.timeout(DETAIL_TIMEOUT_MS),
    });
    const entries = (await res.json()) as Array<{ path?: string; size?: number; lfs?: { size?: number } }>;
    let total = 0;
    let found = false;
    for (const e of entries) {
      const p = (e.path ?? "").toLowerCase();
      if (p.endsWith(".safetensors") || p.endsWith(".gguf") || p.endsWith(".bin")) {
        total += e.lfs?.size ?? e.size ?? 0;
        found = true;
      }
    }
    return found ? total : null;
  } catch {
    return null;
  }
}

/** Total parameter count from safetensors-metadata (<index>.safetensors.index.json). */
async function fetchParameterCount(repoId: string, siblings: Array<{ rfilename: string }> | undefined): Promise<number | null> {
  const indexFile = (siblings ?? []).map((s) => s.rfilename).find((f) => f.endsWith(".safetensors.index.json"));
  if (!indexFile) return null;
  try {
    const res = await hfFetch(`/api/models/${repoId}/safetensors-metadata/${indexFile}`, {
      signal: AbortSignal.timeout(DETAIL_TIMEOUT_MS),
    });
    const data = (await res.json()) as { index?: { metadata?: { total_parameters?: number } } };
    return data?.index?.metadata?.total_parameters ?? null;
  } catch {
    return null;
  }
}

/** Context length from config.json (max_position_embeddings / context_length). */
async function fetchContextLength(repoId: string): Promise<number | null> {
  try {
    const res = await fetch(
      `${HF_BASE_URL}/${repoId}/resolve/main/config.json?download=true`,
      {
        headers: {
          ...(process.env.HUGGINGFACE_API_KEY ? { Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}` } : {}),
          "User-Agent": "ollama-admin/0.18",
        },
        signal: AbortSignal.timeout(DETAIL_TIMEOUT_MS),
      }
    );
    if (!res.ok) return null;
    const config = (await res.json()) as Record<string, unknown>;
    return extractContextFromConfig(config);
  } catch {
    return null;
  }
}

/** Resolve context length that may live in a nested sub-config (text_config). */
function extractContextFromConfig(value: unknown, depth = 0): number | null {
  if (depth > 4 || value == null || typeof value !== "object") return null;
  for (const [key, v] of Object.entries(value)) {
    const k = key.toLowerCase();
    if (["max_position_embeddings", "context_length", "max_seq_len", "n_positions", "max_length"].includes(k)
      && typeof v === "number" && v > 0) {
      return v;
    }
    if (typeof v === "object") {
      const found = extractContextFromConfig(v, depth + 1);
      if (found != null) return found;
    }
  }
  return null;
}

function formatSizeBytes(bytes: number): string {
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Enrich one HF search result (cached 7d in HuggingFaceModel) into a catalog entry. */
export async function hfModelToEntry(model: HuggingFaceModel) {
  const id = `hf.co/${model.id}`;
  const quantTag = tagFromSiblings(model);
  const familyTag = (model.tags ?? []).find((tg) => !tg.includes(":") && !["transformers", "safetensors", "conversational", "arxiv", "license", "endpoints_compatible", "eval-results"].some((p) => tg.startsWith(p))) ?? model.library_name ?? null;
  const baseModel = (model.tags ?? []).find((tg) => tg.startsWith("base_model:") && !tg.startsWith("base_model:finetune"))?.slice("base_model:".length) ?? null;

  // Cache hit: reuse enriched metadata if fresh.
  let cached = null;
  try {
    cached = await prisma.huggingFaceModel.findUnique({ where: { id: model.id } });
  } catch {
    // cache read is best-effort
  }
  const fresh = cached != null && Date.now() - (cached.cachedAt?.getTime() ?? 0) < HF_CACHE_TTL;

  let parameterSize: string | null = null;
  let quantizationLevel: string | null = null;
  let contextLength: number | null = null;
  let sizeBytes: number | null = null;
  let sizeLabel: string | null = null;
  if (cached != null) {
    if (fresh) {
      parameterSize = cached.parameterSize;
      quantizationLevel = cached.quantizationLevel;
      contextLength = cached.contextLength;
      sizeBytes = cached.sizeBytes != null ? Number(cached.sizeBytes) : null;
      sizeLabel = cached.sizeLabel;
    } else {
      // reuse family/parent metadata from the stale row as fallbacks
      parameterSize = cached.parameterSize;
      quantizationLevel = cached.quantizationLevel;
      contextLength = cached.contextLength;
      sizeBytes = cached.sizeBytes != null ? Number(cached.sizeBytes) : null;
      sizeLabel = cached.sizeLabel;
    }
  }

  if (!fresh) {
    try {
      const paramCount = await fetchParameterCount(model.id, model.siblings);
      const size = await fetchRepoSizeBytes(model.id);
      const ctx = await fetchContextLength(model.id);
      parameterSize = paramCount != null ? formatParameterSize(String(paramCount)) ?? null : null;
      quantizationLevel = quantTag || null;
      contextLength = ctx;
      sizeBytes = size;
      sizeLabel = size != null ? formatSizeBytes(size) : null;
      // Best-effort cache write (upsert keyed on repo id).
      try {
        await prisma.huggingFaceModel.upsert({
          where: { id: model.id },
          create: {
            id: model.id,
            family: familyTag,
            parentModel: baseModel,
            parameterSize,
            quantizationLevel,
            contextLength,
            sizeBytes: sizeBytes != null ? BigInt(sizeBytes) : null,
            sizeLabel,
            capabilities: capabilitiesFromPipeline(model.pipeline_tag, model.library_name).join(","),
            pulls: model.downloads != null ? String(model.downloads) : null,
            updated: formatRelativeTimeLocal(model.lastModified),
            cachedAt: new Date(),
          },
          update: {
            family: familyTag,
            parentModel: baseModel,
            parameterSize,
            quantizationLevel,
            contextLength,
            sizeBytes: sizeBytes != null ? BigInt(sizeBytes) : null,
            sizeLabel,
            capabilities: capabilitiesFromPipeline(model.pipeline_tag, model.library_name).join(","),
            pulls: model.downloads != null ? String(model.downloads) : null,
            cachedAt: new Date(),
          },
        });
      } catch {
        // cache write is best-effort
      }
    } catch {
      // enrichment is best-effort; fall through with search-list metadata
    }
  }

  return {
    id,
    name: model.id,
    tag: quantTag || "latest",
    description: "",
    capabilities: capabilitiesFromPipeline(model.pipeline_tag, model.library_name),
    sizes: [],
    pulls: model.downloads != null ? String(model.downloads) : "",
    updated: formatRelativeTimeLocal(model.lastModified),
    family: familyTag,
    parentModel: baseModel,
    parameterSize,
    quantizationLevel,
    contextLength,
    sizeBytes,
    sizeLabel,
    url: `${HF_BASE_URL}/${model.id}`,
    isCloud: false,
    isMLX: model.library_name === "mlx" || /-mlx/.test(model.id),
  };
}

// Local copy: avoids importing the ollama catalog module (and its server-only
// siblings) from the HF client.
function formatRelativeTimeLocal(iso: string | undefined): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  const units: [number, string][] = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [30, "day"],
    [12, "month"],
    [Number.POSITIVE_INFINITY, "year"],
  ];
  let value = seconds;
  for (const [factor, unit] of units) {
    if (value < factor) {
      const rounded = Math.max(1, Math.floor(value));
      return `${rounded} ${unit}${rounded === 1 ? "" : "s"} ago`;
    }
    value /= factor;
  }
  return "";
}
