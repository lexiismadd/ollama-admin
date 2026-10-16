import * as cheerio from "cheerio";
import { ProxyAgent, } from "undici";
import { prisma } from "@/lib/prisma";
import {
  catalogPageUrl,
  fetchCloudCatalog,
  fetchCloudModelDetails,
  formatRelativeTime,
  isCloudCatalogEnabled,
} from "@/lib/catalog-cloud";

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  sizes: string[];
  pulls: string;
  updated: string;
  family: string | null;
  parentModel: string | null;
  parameterSize: string | null;
  quantizationLevel: string | null;
  contextLength: number | null;
  sizeBytes: number | null;
  url: string | null;
}

export interface ScrapedModel {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  sizes: string[];
  pulls: string;
  updated: string;
}

export const CATALOG_DB_TTL = 24 * 60 * 60 * 1000; // 24 hours
const MAX_PAGES = 100;

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

export async function scrapeAllModels(): Promise<ScrapedModel[]> {
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

  if (models.length === 0) {
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

  return models;
}

type CatalogRow = {
  id: string;
  name: string;
  description: string | null;
  family: string | null;
  parentModel: string | null;
  parameterSize: string | null;
  quantizationLevel: string | null;
  contextLength: number | null;
  sizeBytes: bigint | null;
  url: string | null;
  capabilities: string;
  sizes: string;
  pullCount: string | null;
  lastUpdated: string | null;
};

function splitList(value: string): string[] {
  return value ? value.split(",").filter(Boolean) : [];
}

function rowToEntry(row: CatalogRow): CatalogEntry {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    capabilities: splitList(row.capabilities),
    sizes: splitList(row.sizes),
    pulls: row.pullCount ?? "",
    updated: row.lastUpdated ?? "",
    family: row.family,
    parentModel: row.parentModel,
    parameterSize: row.parameterSize,
    quantizationLevel: row.quantizationLevel,
    contextLength: row.contextLength,
    // BigInt from the DB is not JSON-serializable; catalog sizes fit a double.
    sizeBytes: row.sizeBytes == null ? null : Number(row.sizeBytes),
    url: row.url,
  };
}

function scrapedToEntry(model: ScrapedModel): CatalogEntry {
  return {
    id: model.id,
    name: model.name,
    description: model.description,
    capabilities: model.capabilities,
    sizes: model.sizes,
    pulls: model.pulls,
    updated: model.updated,
    family: null,
    parentModel: null,
    parameterSize: null,
    quantizationLevel: null,
    contextLength: null,
    sizeBytes: null,
    url: catalogPageUrl(model.id),
  };
}

export async function fetchCloudEntries(): Promise<CatalogEntry[]> {
  const tagsModels = await fetchCloudCatalog();
  const results: CatalogEntry[] = [];
  let index = 0;

  async function worker() {
    while (index < tagsModels.length) {
      const tagsModel = tagsModels[index++];
      const details = await fetchCloudModelDetails(tagsModel.model || tagsModel.name, tagsModel);
      const name = tagsModel.name;
      const tag = name.includes(":") ? name.slice(name.indexOf(":") + 1) : "latest";
      results.push({
        id: name,
        name,
        description: "",
        capabilities: details.capabilities,
        sizes: [tag],
        pulls: "",
        updated: formatRelativeTime(details.modifiedAt ?? undefined),
        family: details.family,
        parentModel: details.parentModel,
        parameterSize: details.parameterSize,
        quantizationLevel: details.quantizationLevel,
        contextLength: details.contextLength,
        sizeBytes: tagsModel.size || null,
        url: catalogPageUrl(name),
      });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(8, Math.max(1, tagsModels.length)) }, worker)
  );
  return results;
}

async function fetchScrapedEntries(): Promise<CatalogEntry[]> {
  return (await scrapeAllModels()).map(scrapedToEntry);
}

async function persistCatalog(entries: CatalogEntry[]): Promise<void> {
  await prisma.$transaction([
    prisma.catalogModel.deleteMany(),
    prisma.catalogModel.createMany({
      data: entries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        description: entry.description || null,
        family: entry.family,
        parentModel: entry.parentModel,
        parameterSize: entry.parameterSize,
        quantizationLevel: entry.quantizationLevel,
        contextLength: entry.contextLength,
        sizeBytes: entry.sizeBytes == null ? null : BigInt(entry.sizeBytes),
        url: entry.url,
        capabilities: entry.capabilities.join(","),
        sizes: entry.sizes.join(","),
        pullCount: entry.pulls || null,
        lastUpdated: entry.updated || null,
        cachedAt: new Date(),
      })),
    }),
  ]);
}

export interface CatalogResult {
  entries: CatalogEntry[];
  /** True when the fetch failed and rows from an older refresh are being served. */
  stale: boolean;
  source: "cloud" | "scrape";
}

export async function getCatalog(forceRefresh = false): Promise<CatalogResult> {
  const rows = await prisma.catalogModel.findMany();
  const freshest = rows.reduce(
    (max, row) => Math.max(max, row.cachedAt?.getTime() ?? 0),
    0
  );
  const fresh = rows.length > 0 && Date.now() - freshest < CATALOG_DB_TTL;

  if (!forceRefresh && fresh) {
    return { entries: rows.map(rowToEntry), stale: false, source: isCloudCatalogEnabled() ? "cloud" : "scrape" };
  }

  const useCloud = isCloudCatalogEnabled();
  try {
    const entries = useCloud ? await fetchCloudEntries() : await fetchScrapedEntries();
    if (entries.length === 0) throw new Error("Catalog fetch returned no models");
    await persistCatalog(entries);
    return { entries, stale: false, source: useCloud ? "cloud" : "scrape" };
  } catch (err) {
    // Cloud fetch failed: fall back to scraping once before serving stale data.
    if (useCloud) {
      try {
        const entries = await fetchScrapedEntries();
        await persistCatalog(entries);
        return { entries, stale: false, source: "scrape" };
      } catch {
        // ignore — stale DB rows may still be available below
      }
    }
    if (rows.length > 0) {
      return { entries: rows.map(rowToEntry), stale: true, source: useCloud ? "cloud" : "scrape" };
    }
    throw err instanceof Error ? err : new Error("Failed to fetch catalog");
  }
}
