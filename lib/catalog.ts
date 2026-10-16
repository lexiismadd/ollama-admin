import * as cheerio from "cheerio";
import { ProxyAgent } from "undici";

export interface ScrapedModel {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  sizes: string[];
  pulls: string;
  updated: string;
}

export const CATALOG_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const MAX_PAGES = 100;

export let catalogCache: { data: ScrapedModel[]; timestamp: number } | null = null;

const KNOWN_CAPABILITIES = ["tools", "vision", "embedding", "thinking", "cloud", "text"];
// Parameter-count tags like "3b", "7b", "0.5b", "1m" (size badges on ollama.com cards)
const SIZE_TAG_RE = /^\d+(\.\d+)?[bm]$/;
// Pull/download counts like "11.9K", "2.1M"
const PULL_COUNT_RE = /^[\d.]+[KM]$/;

function parseModelsFromHtml(html: string): ScrapedModel[] {
  const $ = cheerio.load(html);
  const models: ScrapedModel[] = [];

  $('a[href^="/library/"]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr("href") || "";
    const id = href.replace("/library/", "");
    if (!id || id.includes("/")) return;

    const heading = $el.find("h2").first().text().trim();
    const description = $el.find("p").first().text().trim();

    const capabilities: string[] = [];
    const sizes: string[] = [];
    let pulls = "";
    let updated = "";

    // Classify every span in the card by its text. ollama.com no longer
    // renders x-test-* attributes; capability badges and size tags are
    // plain spans, pull counts sit inside a .tabular-nums wrapper.
    $el.find("span").each((_, span) => {
      const text = $(span).text().trim();
      if (!text) return;
      const lower = text.toLowerCase();

      if (KNOWN_CAPABILITIES.includes(lower) && !capabilities.includes(lower)) {
        capabilities.push(lower);
      } else if (SIZE_TAG_RE.test(lower) && !sizes.includes(lower)) {
        sizes.push(lower);
      } else if (!pulls && PULL_COUNT_RE.test(text)) {
        pulls = text;
      } else if (!updated && text.length < 40) {
        const agoMatch = text.toLowerCase().match(/(\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago)/);
        if (agoMatch) updated = agoMatch[1];
      }
    });

    models.push({ id, name: heading || id, description, capabilities, sizes, pulls, updated });
  });

  return models;
}

function getProxyDispatcher(): ProxyAgent | undefined {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
  if (!proxyUrl) return undefined;
  return new ProxyAgent(proxyUrl);
}

async function fetchPage(url: string): Promise<string> {
  const dispatcher = getProxyDispatcher();
  const options: RequestInit & { dispatcher?: ProxyAgent } = {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  };
  if (dispatcher) options.dispatcher = dispatcher;
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.text();
}

export function clearCatalogCache(): void {
  catalogCache = null;
}

export function isCatalogCacheStale(): boolean {
  return catalogCache ? Date.now() - catalogCache.timestamp >= CATALOG_CACHE_TTL : true;
}

export async function scrapeAllModels(forceRefresh = false): Promise<ScrapedModel[]> {
  if (!forceRefresh && catalogCache && Date.now() - catalogCache.timestamp < CATALOG_CACHE_TTL) {
    return catalogCache.data;
  }

  const modelMap = new Map<string, ScrapedModel>();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = page === 1
      ? "https://ollama.com/search"
      : `https://ollama.com/search?page=${page}`;
    try {
      const html = await fetchPage(url);
      const models = parseModelsFromHtml(html);
      if (models.length === 0) break;
      for (const model of models) {
        if (!modelMap.has(model.id)) {
          modelMap.set(model.id, model);
        }
      }
    } catch {
      break;
    }
  }

  const models = Array.from(modelMap.values()).filter((m) => {
    if (m.capabilities.length === 1 && m.capabilities[0] === "cloud") return false;
    return m.sizes.length > 0 || m.capabilities.length > 0;
  });

  // Never poison the cache with an empty scrape (e.g. markup changes on
  // ollama.com or a transient network failure). Serve the last good data;
  // only throw when there is nothing cached to fall back on.
  if (models.length === 0) {
    if (catalogCache && catalogCache.data.length > 0) {
      return catalogCache.data;
    }
    throw new Error("Catalog scrape returned no models");
  }

  for (const model of models) {
    model.capabilities = model.capabilities.filter((c) => c !== "cloud");
    if (!model.capabilities.includes("embedding")) {
      model.capabilities.unshift("text");
    }
  }

  models.sort((a, b) => {
    const parseCount = (s: string) => {
      if (!s) return 0;
      const num = parseFloat(s);
      if (s.includes("M")) return num * 1_000_000;
      if (s.includes("K")) return num * 1_000;
      return num;
    };
    return parseCount(b.pulls) - parseCount(a.pulls);
  });

  catalogCache = { data: models, timestamp: Date.now() };
  return models;
}
