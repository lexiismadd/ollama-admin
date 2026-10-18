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
  /** Variant tag without the model prefix (e.g. "e2b-mlx"); "latest" when untagged. */
  tag: string;
  description: string;
  capabilities: string[];
  /** Legacy: parameter-size tags from the search card ("7b", "e2b"). Empty for granular rows. */
  sizes: string[];
  pulls: string;
  updated: string;
  family: string | null;
  parentModel: string | null;
  parameterSize: string | null;
  quantizationLevel: string | null;
  contextLength: number | null;
  sizeBytes: number | null;
  /** Raw size string from ollama.com ("4.6GB - 7.5GB") shown when present. */
  sizeLabel: string | null;
  url: string | null;
  isCloud: boolean;
  isMLX: boolean;
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
const TAGS_CONCURRENCY = 8;
const TAGS_TIMEOUT_MS = 10_000;

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
    return m.sizes.length > 0 || m.capabilities.length > 0;
  });

  if (models.length === 0) {
    throw new Error("Catalog scrape returned no models");
  }

  for (const model of models) {
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

/** One granular catalog row: a single (model, tag) variant. */
export interface TagRow {
  tag: string;
  sizeBytes: number | null;
  sizeLabel: string | null;
  contextLength: number | null;
  capabilities: string[];
  isMLX: boolean;
  updated: string;
}

function parseSize(text: string): { bytes: number | null; label: string | null } {
  const m = text.match(/(\d+(?:\.\d+)?)(GB|MB)(?:\s*-\s*(\d+(?:\.\d+)?)(GB|MB))?/);
  if (!m) return { bytes: null, label: null };
  const unit = (u: string, v: string) => parseFloat(v) * (u === "GB" ? 1024 ** 3 : 1024 ** 2);
  const first = unit(m[2], m[1]);
  const second = m[3] !== undefined ? unit(m[4], m[3]) : null;
  return {
    bytes: second !== null ? Math.max(first, second) : first,
    label: m[0],
  };
}

function parseContext(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)(K|M|B)?\s*context window/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const mult = m[2]?.toUpperCase() === "M" ? 1024 ** 2 : m[2]?.toUpperCase() === "B" ? 1024 ** 3 : 1024;
  return Math.round(n * mult);
}

/** Capability tokens rendered on tag rows ("Text, Image input", "Tools", ...). */
const TAG_CAP_TOKENS: Array<[RegExp, string]> = [
  [/image input/i, "vision"],
  [/\btext\b/i, "text"],
  [/\btools\b/i, "tools"],
  [/\bthinking\b/i, "thinking"],
  [/\bembedding\b/i, "embedding"],
];

export function parseTagRows(html: string): TagRow[] {
  const $ = cheerio.load(html);
  const rows = new Map<string, TagRow>();

  // Each variant renders twice (mobile + desktop blocks) inside a div.group.
  $("div.group").each((_, el) => {
    const anchor = $(el).find('a[href^="/library/"]').first();
    const href = anchor.attr("href") || "";
    const ref = href.replace("/library/", "");
    if (!ref || !ref.includes(":")) return;

    const text = $(el).text();
    const tag = ref.slice(ref.indexOf(":") + 1);

    // Skip the parameter-size "showing tags for" chips — they duplicate tag names
    // without a digest/size/context metadata line.
    if (!/\bcontext window\b/i.test(text)) return;

    const size = parseSize(text);
    const capabilities: string[] = [];
    for (const [re, cap] of TAG_CAP_TOKENS) {
      if (re.test(text) && !capabilities.includes(cap)) capabilities.push(cap);
    }

    const agoMatch = text.match(/(\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago)/i);

    rows.set(ref, {
      tag,
      sizeBytes: size.bytes,
      sizeLabel: size.label,
      contextLength: parseContext(text),
      capabilities: capabilities.length > 0 ? capabilities : ["text"],
      isMLX: /(^|\s)MLX(\s|$)/.test(text) || /-mlx/.test(tag),
      updated: agoMatch ? agoMatch[1] : "",
    });
  });

  return Array.from(rows.values());
}

/** Scrape the per-variant tag rows of a library model's tags page. */
async function scrapeModelTags(modelId: string): Promise<TagRow[]> {
  const dispatcher = getProxyDispatcher();
  const options: RequestInit & { dispatcher?: ProxyAgent } = {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    signal: AbortSignal.timeout(TAGS_TIMEOUT_MS),
  };
  if (dispatcher) options.dispatcher = dispatcher;
  const res = await fetch(`https://ollama.com/library/${modelId}/tags`, options);
  if (!res.ok) throw new Error(`Failed to fetch tags for ${modelId}: ${res.status}`);
  return parseTagRows(await res.text());
}

/** Fallback row for a model whose tags page could not be scraped. */
function fallbackTagRows(model: ScrapedModel): TagRow[] {
  const sizes = model.sizes.length > 0 ? model.sizes : ["latest"];
  return sizes.map((tag) => ({
    tag,
    sizeBytes: null,
    sizeLabel: null,
    contextLength: null,
    capabilities: model.capabilities,
    isMLX: false,
    updated: model.updated,
  }));
}

function cardEntry(model: ScrapedModel): CatalogEntry {
  return {
    id: model.id,
    name: model.name,
    tag: model.id.includes(":") ? model.id.slice(model.id.indexOf(":") + 1) : "latest",
    description: model.description,
    capabilities: model.capabilities.filter((c) => c !== "cloud"),
    sizes: model.sizes,
    pulls: model.pulls,
    updated: model.updated,
    family: null,
    parentModel: null,
    parameterSize: null,
    quantizationLevel: null,
    contextLength: null,
    sizeBytes: null,
    sizeLabel: null,
    url: catalogPageUrl(model.id),
    isCloud: model.capabilities.includes("cloud") || model.id.endsWith(":cloud"),
    isMLX: false,
  };
}

/** Build granular per-variant entries from the search cards + per-model tags pages. */
export async function scrapeCatalogGranular(): Promise<CatalogEntry[]> {
  const cards = await scrapeAllModels();
  const entries: CatalogEntry[] = [];
  let index = 0;

  async function worker() {
    while (index < cards.length) {
      const card = cards[index++];
      const modelId = card.id.includes(":") ? card.id.slice(0, card.id.indexOf(":")) : card.id;
      let tagRows: TagRow[];
      try {
        tagRows = await scrapeModelTags(modelId);
      } catch {
        tagRows = fallbackTagRows(card);
      }

      for (const row of tagRows) {
        const entry = cardEntry(card);
        entry.id = `${modelId}:${row.tag}`;
        entry.tag = row.tag;
        entry.capabilities = row.capabilities.filter((c) => c !== "cloud");
        entry.updated = row.updated || card.updated;
        entry.contextLength = row.contextLength;
        entry.sizeBytes = row.sizeBytes;
        entry.sizeLabel = row.sizeLabel;
        entry.isMLX = row.isMLX;
        entry.isCloud = entry.isCloud || row.tag === "cloud";
        // The ":cloud" variant itself is cloud-only; real download rows are local.
        if (entry.isCloud) entry.capabilities = [];
        entries.push(entry);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(TAGS_CONCURRENCY, Math.max(1, cards.length)) }, worker)
  );
  return entries;
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
  sizeLabel: string | null;
  url: string | null;
  isCloud: boolean;
  isMLX: boolean;
  capabilities: string;
  sizes: string;
  pullCount: string | null;
  lastUpdated: string | null;
};

function splitList(value: string): string[] {
  return value ? value.split(",").filter(Boolean) : [];
}

export function tagOf(id: string): string {
  return id.includes(":") ? id.slice(id.indexOf(":") + 1) : "latest";
}

function rowToEntry(row: CatalogRow): CatalogEntry {
  return {
    id: row.id,
    name: row.name,
    tag: tagOf(row.id),
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
    sizeLabel: row.sizeLabel,
    url: row.url,
    isCloud: row.isCloud,
    isMLX: row.isMLX,
  };
}

function scrapedToEntry(model: ScrapedModel): CatalogEntry {
  return {
    id: model.id,
    name: model.name,
    tag: tagOf(model.id),
    description: model.description,
    capabilities: model.capabilities.filter((c) => c !== "cloud"),
    sizes: model.sizes,
    pulls: model.pulls,
    updated: model.updated,
    family: null,
    parentModel: null,
    parameterSize: null,
    quantizationLevel: null,
    contextLength: null,
    sizeBytes: null,
    sizeLabel: null,
    url: catalogPageUrl(model.id),
    isCloud: model.capabilities.includes("cloud") || model.id.endsWith(":cloud"),
    isMLX: false,
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
      results.push({
        id: name,
        name,
        tag: tagOf(name),
        description: "",
        capabilities: details.capabilities,
        sizes: [tagOf(name)],
        pulls: "",
        updated: formatRelativeTime(details.modifiedAt ?? undefined),
        family: details.family,
        parentModel: details.parentModel,
        parameterSize: details.parameterSize,
        quantizationLevel: details.quantizationLevel,
        contextLength: details.contextLength,
        sizeBytes: tagsModel.size || null,
        sizeLabel: null,
        url: catalogPageUrl(name),
        isCloud: true,
        isMLX: /-mlx/.test(tagOf(name)),
      });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(8, Math.max(1, tagsModels.length)) }, worker)
  );
  return results;
}

/**
 * Merge cloud API entries with the scraped library catalog. Cloud rows win on
 * id conflicts (they carry API-enriched params/quant/context).
 */
function mergeCatalog(primary: CatalogEntry[], secondary: CatalogEntry[]): CatalogEntry[] {
  const byId = new Map<string, CatalogEntry>();
  for (const entry of secondary) byId.set(entry.id, entry);
  for (const entry of primary) byId.set(entry.id, entry);
  return Array.from(byId.values());
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
        sizeLabel: entry.sizeLabel,
        url: entry.url,
        isCloud: entry.isCloud,
        isMLX: entry.isMLX,
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
    let entries: CatalogEntry[];
    if (useCloud) {
      // OLLAMA_API_KEY is set: the cloud API REPLACES scraping entirely.
      entries = await fetchCloudEntries();
    } else {
      entries = await scrapeCatalogGranular();
    }
    if (entries.length === 0) throw new Error("Catalog fetch returned no models");
    await persistCatalog(entries);
    return { entries, stale: false, source: useCloud ? "cloud" : "scrape" };
  } catch (err) {
    // Cloud fetch failed: fall back to scraping once before serving stale data.
    if (useCloud) {
      try {
        const entries = await scrapeCatalogGranular();
        if (entries.length > 0) {
          await persistCatalog(entries);
          return { entries, stale: false, source: "scrape" };
        }
      } catch {
        // fall through to stale rows
      }
    }
    if (rows.length > 0) {
      return { entries: rows.map(rowToEntry), stale: true, source: useCloud ? "cloud" : "scrape" };
    }
    throw err instanceof Error ? err : new Error("Failed to fetch catalog");
  }
}
