export interface OllamaModel {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  details: {
    parent_model: string;
    format: string;
    family: string;
    families: string[];
    parameter_size: string;
    quantization_level: string;
  };
  capabilities?: string[];
  context_length?: number | null;
  url?: string | null;
}

export interface OllamaRunningModel {
  name: string;
  model: string;
  size: number;
  digest: string;
  details: {
    parent_model: string;
    format: string;
    family: string;
    families: string[];
    parameter_size: string;
    quantization_level: string;
  };
  expires_at: string;
  size_vram: number;
}

export interface OllamaVersion {
  version: string;
}

export interface OllamaPullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
}

interface ErrorLike {
  cause?: unknown;
  code?: unknown;
  errors?: unknown;
  message?: unknown;
}

function collectErrorCodes(error: unknown): Set<string> {
  const codes = new Set<string>();
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;

    seen.add(current);
    const errorLike = current as ErrorLike;
    if (typeof errorLike.code === "string") codes.add(errorLike.code);
    if (errorLike.cause) pending.push(errorLike.cause);
    if (Array.isArray(errorLike.errors)) pending.push(...errorLike.errors);
  }

  return codes;
}

export function normalizeOllamaUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("URL is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid Ollama URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Ollama URL must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Ollama URL must not include embedded credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("Ollama URL must not include a query string or fragment");
  }

  return parsed.toString().replace(/\/$/, "");
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0.0.0.0" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

/**
 * Resolve a loopback URL to the Docker host in official container deployments.
 *
 * The public URL remains unchanged in the database and UI. Only the transport
 * target is rewritten, and only when DEFAULT_OLLAMA_URL explicitly selects the
 * host.docker.internal alias supplied by the official Compose configuration.
 */
export function resolveOllamaUrl(baseUrl: string): string {
  const normalizedBaseUrl = normalizeOllamaUrl(baseUrl);
  const parsed = new URL(normalizedBaseUrl);

  if (!isLoopbackHostname(parsed.hostname)) return normalizedBaseUrl;

  const configuredDefault = process.env.DEFAULT_OLLAMA_URL;
  if (!configuredDefault) return normalizedBaseUrl;

  try {
    const configuredUrl = new URL(normalizeOllamaUrl(configuredDefault));
    if (normalizeHostname(configuredUrl.hostname) !== "host.docker.internal") {
      return normalizedBaseUrl;
    }

    // Preserve the user-selected protocol, port and path. Only loopback has a
    // different meaning across the container boundary.
    parsed.hostname = configuredUrl.hostname;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return normalizedBaseUrl;
  }
}

export function redactOllamaUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "[invalid Ollama URL]";
  }
}

export function buildOllamaUrl(baseUrl: string, path: string): string {
  const normalizedBaseUrl = resolveOllamaUrl(baseUrl);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBaseUrl}${normalizedPath}`;
}

/** Turn low-level fetch failures into guidance that is useful from a container. */
export function formatOllamaConnectionError(
  baseUrl: string,
  error: unknown
): string {
  const message = error instanceof Error ? error.message : "Connection failed";

  // Ollama answered, so networking hints would be misleading.
  if (message.startsWith("Ollama API error:")) return message;

  let hostname = "";
  let displayUrl = baseUrl;
  try {
    const effectiveBaseUrl = resolveOllamaUrl(baseUrl);
    const parsed = new URL(effectiveBaseUrl);
    hostname = parsed.hostname.toLowerCase();
    displayUrl = redactOllamaUrl(effectiveBaseUrl);
  } catch {
    return `Invalid Ollama URL: ${redactOllamaUrl(baseUrl)}`;
  }

  const codes = collectErrorCodes(error);
  const codeSuffix = codes.size > 0 ? ` (${Array.from(codes).join(", ")})` : "";
  hostname = normalizeHostname(hostname);
  const isLoopback = isLoopbackHostname(hostname);

  if (isLoopback) {
    return `Could not reach Ollama at ${displayUrl}${codeSuffix}. From Docker, localhost points to the Ollama Admin container. Use http://host.docker.internal:11434 instead.`;
  }

  if (hostname === "host.docker.internal") {
    if (codes.has("ENOTFOUND") || codes.has("EAI_AGAIN")) {
      return `Could not resolve host.docker.internal${codeSuffix}. Add "host.docker.internal:host-gateway" to extra_hosts for the Ollama Admin service in Docker Compose.`;
    }

    if (codes.has("ECONNREFUSED")) {
      return `Ollama refused the connection at ${displayUrl}${codeSuffix}. Ollama listens on 127.0.0.1 by default. Configure OLLAMA_HOST=0.0.0.0:11434 in the Ollama service, restart it, and restrict port 11434 to trusted Docker networks.`;
    }

    return `Could not reach Ollama at ${displayUrl}${codeSuffix}. Ensure Docker Compose maps host.docker.internal to host-gateway and Ollama is listening on 0.0.0.0:11434.`;
  }

  if (codes.has("ECONNREFUSED")) {
    return `Ollama refused the connection at ${displayUrl}${codeSuffix}. Ensure Ollama is running and listening on an address reachable from Docker. Configure OLLAMA_HOST in the Ollama service rather than only in the current shell.`;
  }

  if (codes.has("ETIMEDOUT") || codes.has("UND_ERR_CONNECT_TIMEOUT")) {
    return `Connection to Ollama timed out at ${displayUrl}${codeSuffix}. Check the address, firewall, and Docker network routing.`;
  }

  return `Could not reach Ollama at ${displayUrl}${codeSuffix}. Check that Ollama is running and reachable from the container.`;
}

export interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[];
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream?: boolean;
  options?: Record<string, unknown>;
  keep_alive?: string;
}

export interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: OllamaChatMessage;
  done: boolean;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;
}

export interface OllamaShowResponse {
  modelfile: string;
  parameters: string;
  template: string;
  details: {
    parent_model: string;
    format: string;
    family: string;
    families: string[];
    parameter_size: string;
    quantization_level: string;
  };
  capabilities?: string[];
  model_info: Record<string, unknown>;
}

export async function ollamaFetch<T>(
  baseUrl: string,
  path: string,
  options?: RequestInit
): Promise<T> {
  const url = buildOllamaUrl(baseUrl, path);
  const res = await fetch(url, {
    ...options,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!res.ok) {
    throw new Error(`Ollama API error: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

export async function getVersion(baseUrl: string): Promise<OllamaVersion> {
  return ollamaFetch<OllamaVersion>(baseUrl, "/api/version");
}

export async function listModels(
  baseUrl: string
): Promise<{ models: OllamaModel[] }> {
  return ollamaFetch<{ models: OllamaModel[] }>(baseUrl, "/api/tags");
}

export async function listRunningModels(
  baseUrl: string
): Promise<{ models: OllamaRunningModel[] }> {
  return ollamaFetch<{ models: OllamaRunningModel[] }>(baseUrl, "/api/ps");
}

export async function showModel(
  baseUrl: string,
  name: string
): Promise<OllamaShowResponse> {
  return ollamaFetch<OllamaShowResponse>(baseUrl, "/api/show", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function deleteModel(
  baseUrl: string,
  name: string
): Promise<void> {
  await ollamaFetch(baseUrl, "/api/delete", {
    method: "DELETE",
    body: JSON.stringify({ name }),
  });
}

export async function copyModel(
  baseUrl: string,
  source: string,
  destination: string
): Promise<void> {
  await ollamaFetch(baseUrl, "/api/copy", {
    method: "POST",
    body: JSON.stringify({ source, destination }),
  });
}

export function pullModelStream(
  baseUrl: string,
  name: string
): ReadableStream<OllamaPullProgress> {
  const url = buildOllamaUrl(baseUrl, "/api/pull");

  return new ReadableStream({
    async start(controller) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, stream: true }),
      });

      if (!res.ok || !res.body) {
        controller.error(
          new Error(`Pull failed: ${res.status} ${res.statusText}`)
        );
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim()) {
            try {
              controller.enqueue(JSON.parse(line));
            } catch {
              // skip malformed lines
            }
          }
        }
      }

      controller.close();
    },
  });
}
