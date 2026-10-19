/**
 * Server-only HuggingFace model search client.
 *
 * When HUGGINGFACE_API_KEY is set, the Discover search also queries
 * HuggingFace live. HF results are intentionally NOT persisted into the
 * catalog cache — "Refresh catalog" never touches HF models that are not
 * installed.
 */

const HF_BASE_URL = "https://huggingface.co";
const SEARCH_TIMEOUT_MS = 15_000;
const DEFAULT_LIMIT = 20;

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

export function hfModelToEntry(model: HuggingFaceModel) {
  const id = `hf.co/${model.id}`;
  const quantTag = tagFromSiblings(model);
  const familyTag = (model.tags ?? []).find((tg) => !tg.includes(":") && !["transformers", "safetensors", "conversational", "arxiv", "license", "endpoints_compatible", "eval-results"].some((p) => tg.startsWith(p))) ?? model.library_name ?? null;
  const baseModel = (model.tags ?? []).find((tg) => tg.startsWith("base_model:") && !tg.startsWith("base_model:finetune"))?.slice("base_model:".length) ?? null;

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
    parameterSize: null,
    quantizationLevel: quantTag || null,
    contextLength: null,
    sizeBytes: null,
    sizeLabel: null,
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
