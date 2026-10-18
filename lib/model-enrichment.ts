import { extractContextLength, mapApiCapabilities } from "@/lib/catalog-cloud";
import { showModel } from "@/lib/ollama";
import { prisma } from "@/lib/prisma";

export interface ModelDetailsExtras {
  capabilities: string[];
  contextLength: number | null;
  url: string | null;
}

const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const SHOW_CONCURRENCY = 8;

// Per-server cache of /api/show enrichment. Avoids re-querying every model on
// each models-page load; entries expire after CACHE_TTL.
const cache = new Map<string, { value: ModelDetailsExtras; expiresAt: number }>();

function cacheKey(serverUrl: string, name: string): string {
  return `${serverUrl}::${name}`;
}

export function clearModelDetailsCache(): void {
  cache.clear();
}

export async function enrichModels(
  serverUrl: string,
  models: { name: string; capabilities?: string[] }[]
): Promise<Map<string, ModelDetailsExtras>> {
  const result = new Map<string, ModelDetailsExtras>();
  const pending: string[] = [];

  // Look up Ollama.com model page URLs from the cached catalog (base names).
  const catalogUrls = new Map<string, string>();
  try {
    const bases = Array.from(new Set(models.map((m) => m.name.split(":")[0].trim())));
    const catalogEntries = await prisma.catalogModel.findMany({
      where: { name: { in: bases } },
      select: { name: true, url: true },
    });
    for (const entry of catalogEntries) {
      if (entry.url) catalogUrls.set(entry.name, entry.url);
    }
  } catch {
    // Catalog lookup is best-effort; leave URLs empty on failure.
  }

  for (const model of models) {
    const key = cacheKey(serverUrl, model.name);
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      result.set(model.name, hit.value);
    } else {
      pending.push(model.name);
    }
  }

  let index = 0;
  async function worker() {
    while (index < pending.length) {
      const name = pending[index++];
      const tagsCaps = mapApiCapabilities(models.find((m) => m.name === name)?.capabilities);
      const base = name.split(":")[0].trim();
      const url = catalogUrls.get(base) ?? catalogUrls.get(name) ?? null;
      let value: ModelDetailsExtras;
      try {
        const show = await showModel(serverUrl, name);
        value = {
          capabilities: mapApiCapabilities(show.capabilities).length
            ? mapApiCapabilities(show.capabilities)
            : tagsCaps,
          contextLength: extractContextLength(show.model_info),
          url,
        };
      } catch {
        value = { capabilities: tagsCaps, contextLength: null, url };
      }
      cache.set(cacheKey(serverUrl, name), { value, expiresAt: Date.now() + CACHE_TTL });
      result.set(name, value);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(SHOW_CONCURRENCY, Math.max(1, pending.length)) }, worker)
  );
  return result;
}
