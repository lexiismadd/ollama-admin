/**
 * Server-only Ollama.com cloud API client (tags + show).
 *
 * Split from lib/catalog-cloud.ts: that module is imported by client
 * components for its pure helpers, and `undici` (a Node-only dependency used
 * here for proxy support) crashes the browser bundle when it is evaluated
 * client-side. Keep every network/env-dependent export in this file.
 */
import { ProxyAgent } from "undici";
import {
  extractContextLength,
  formatParameterSize,
  mapApiCapabilities,
  type CloudModelDetails,
  type CloudShowResponse,
  type CloudTagsModel,
} from "./catalog-cloud";

const CLOUD_BASE_URL = "https://ollama.com";
const SHOW_TIMEOUT_MS = 10_000;

function getProxyDispatcher(): ProxyAgent | undefined {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
  if (!proxyUrl) return undefined;
  return new ProxyAgent(proxyUrl);
}

async function cloudFetch(path: string, init?: RequestInit): Promise<Response> {
  const dispatcher = getProxyDispatcher();
  const options: RequestInit & { dispatcher?: ProxyAgent } = {
    ...init,
    headers: {
      ...(process.env.OLLAMA_API_KEY ? { Authorization: `Bearer ${process.env.OLLAMA_API_KEY}` } : {}),
      ...init?.headers,
    },
  };
  if (dispatcher) options.dispatcher = dispatcher;
  const res = await fetch(`${CLOUD_BASE_URL}${path}`, options);
  if (!res.ok) throw new Error(`Ollama.com API error: ${res.status} ${res.statusText}`);
  return res;
}

export function isCloudCatalogEnabled(): boolean {
  return Boolean(process.env.OLLAMA_API_KEY);
}

/** Enrich one catalog entry with /api/show; every failure degrades to the tags data. */
export async function fetchCloudModelDetails(model: string, tagsModel: CloudTagsModel): Promise<CloudModelDetails> {
  const details = tagsModel.details ?? {};
  const base: CloudModelDetails = {
    capabilities: mapApiCapabilities(tagsModel.capabilities),
    family: details.family || null,
    parentModel: details.parent_model || null,
    parameterSize: formatParameterSize(details.parameter_size),
    quantizationLevel: details.quantization_level || null,
    contextLength: null,
    modifiedAt: tagsModel.modified_at ?? null,
  };

  try {
    const res = await cloudFetch("/api/show", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(SHOW_TIMEOUT_MS),
    });
    const show = (await res.json()) as CloudShowResponse;
    const showParent = show.details?.parent_model || "";
    const parent = showParent && showParent !== model ? showParent : null;
    return {
      capabilities: mapApiCapabilities(show.capabilities?.length ? show.capabilities : tagsModel.capabilities),
      family: show.details?.family || base.family,
      parentModel: parent ?? (base.parentModel && base.parentModel !== model ? base.parentModel : null),
      parameterSize: formatParameterSize(show.details?.parameter_size) ?? base.parameterSize,
      quantizationLevel: show.details?.quantization_level || base.quantizationLevel,
      contextLength: extractContextLength(show.model_info),
      modifiedAt: show.modified_at || base.modifiedAt,
    };
  } catch {
    return base;
  }
}

export async function fetchCloudCatalog(): Promise<CloudTagsModel[]> {
  const res = await cloudFetch("/api/tags");
  const data = (await res.json()) as { models?: CloudTagsModel[] };
  return data.models ?? [];
}
