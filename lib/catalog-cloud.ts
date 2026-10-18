export interface CloudTagsModel {
  name: string;
  model: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  details?: {
    parent_model?: string;
    format?: string;
    family?: string;
    families?: string[] | null;
    parameter_size?: string;
    quantization_level?: string;
  };
  capabilities?: string[];
}

export interface CloudShowResponse {
  capabilities?: string[];
  details?: {
    parent_model?: string;
    format?: string;
    family?: string;
    families?: string[] | null;
    parameter_size?: string;
    quantization_level?: string;
  };
  model_info?: Record<string, unknown>;
  modified_at?: string;
}

/** The Ollama.com API calls the chat capability "completion"; the UI calls it "text". */
export function mapApiCapabilities(caps: string[] | undefined): string[] {
  const mapped: string[] = [];
  for (const cap of caps ?? []) {
    const normalized = cap === "completion" ? "text" : cap;
    if (!mapped.includes(normalized)) mapped.push(normalized);
  }
  return mapped;
}

/** The cloud API reports parameter counts as raw strings ("32682372656"); format as "32.7B". */
export function formatParameterSize(value: string | undefined | null): string | null {
  if (!value) return null;
  if (/^\d+(\.\d+)?$/.test(value)) {
    const count = parseFloat(value);
    if (count >= 1e9) return `${(count / 1e9).toFixed(1)}B`;
    if (count >= 1e6) return `${(count / 1e6).toFixed(1)}B`;
    if (count >= 1e3) return `${(count / 1e3).toFixed(1)}K`;
    return `${count}`;
  }
  return value;
}

export function extractContextLength(modelInfo: Record<string, unknown> | undefined): number | null {
  if (!modelInfo) return null;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (/\.context_length$/.test(key) && typeof value === "number") return value;
  }
  if (typeof modelInfo.context_length === "number") return modelInfo.context_length;
  return null;
}

export function formatRelativeTime(iso: string | undefined): string {
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

export function catalogPageUrl(name: string): string | null {
  const base = name.split(":")[0].trim();
  if (!base) return null;
  return `https://ollama.com/library/${base}`;
}

export interface CloudModelDetails {
  capabilities: string[];
  family: string | null;
  parentModel: string | null;
  parameterSize: string | null;
  quantizationLevel: string | null;
  contextLength: number | null;
  modifiedAt: string | null;
}

