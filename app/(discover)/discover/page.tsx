"use client";

import { useTranslations } from "next-intl";
import { useSession } from "next-auth/react";
import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import { Search, Check, Download, Loader2, RefreshCw, ExternalLink } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { useServers } from "@/lib/hooks/use-servers";
import { scoreModel, gradeColor, gradeBg, type Grade } from "@/lib/model-scoring";
import { CapabilityIcons, CAP_ICONS, CAP_COLORS } from "@/components/ui/capability-icons";

interface CatalogModel {
  id: string;
  name: string;
  tag: string;
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
  sizeLabel: string | null;
  url: string | null;
  isCloud: boolean;
  isMLX: boolean;
}

interface GpuSpecs {
  gpuName: string;
  vramGB: number;
  bandwidthGBs: number | null;
}

const CAPABILITY_OPTIONS = ["text", "tools", "vision", "embedding", "thinking"];

type SortKey = "model" | "updated" | "params" | "quant" | "context" | "size" | "family" | "grade";

type FilterType = "all" | "local" | "cloud" | "mlx";

const CTX_SLIDER_MAX = 1048576;

const GRADE_LABELS: Record<Grade, string> = {
  S: "≥50 t/s", A: "≥30 t/s", B: "≥15 t/s", C: "≥8 t/s", D: "≥3 t/s", F: "no fit",
};

// Clickable column header with a direction arrow. "updated" sorts most-recent-first
// by default (arrow ↓); every other column sorts ascending (arrow ↑).
function SortHeader({
  label, k, sortBy, sortDir, onClick, className, alignRight,
}: {
  label: string;
  k: SortKey;
  sortBy: SortKey;
  sortDir: 1 | -1;
  onClick: () => void;
  className: string;
  alignRight?: boolean;
}) {
  const active = sortBy === k;
  const arrow = !active
    ? <span className="opacity-30">↕</span>
    : sortDir === (k === "updated" ? 1 : -1)
      ? <span>{k === "updated" ? "↓" : "↑"}</span>
      : <span>{k === "updated" ? "↑" : "↓"}</span>;
  return (
    <button
      onClick={onClick}
      title={label}
      className={`shrink-0 flex items-center gap-0.5 transition-colors hover:text-[hsl(var(--foreground))] ${active ? "text-[hsl(var(--foreground))]" : "text-[hsl(var(--muted-foreground))]"
        } ${alignRight ? "justify-end" : ""} ${className}`}
    >
      {label} {arrow}
    </button>
  );
}


// Estimate model size in GB from a tag like "7b", "13b", "70b" using Q4 approximation.
function parseTagToSizeGB(tag: string): number | null {
  // Normalize: MoE "8x7b" → "7b", e-series "e2b" → "2b"
  const t = tag.toLowerCase().replace(/^\d+x/, "").replace(/^e(\d)/, "$1");
  const bMatch = t.match(/^(\d+(?:\.\d+)?)b$/);
  if (bMatch) return parseFloat(bMatch[1]) * 0.55;
  const mMatch = t.match(/^(\d+(?:\.\d+)?)m$/);
  if (mMatch) return (parseFloat(mMatch[1]) / 1000) * 0.55;
  return null;
}

function parseRelativeTime(text: string): number {
  const match = text.toLowerCase().match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/);
  if (!match) return 0;
  const n = parseInt(match[1]);
  const ms: Record<string, number> = { second: 1e3, minute: 6e4, hour: 3.6e6, day: 86.4e6, week: 6.048e8, month: 2.628e9, year: 3.154e10 };
  return Date.now() - n * (ms[match[2]] ?? 0);
}

function vramStyle(memPct: number): React.CSSProperties {
  if (memPct >= 100) return { color: "hsl(var(--muted-foreground))", background: "hsl(var(--muted))" };
  if (memPct >= 80)  return { color: "hsl(0 84% 60%)",    background: "hsl(0 84% 60% / 0.15)" };
  if (memPct >= 60)  return { color: "hsl(38 92% 50%)",   background: "hsl(38 92% 50% / 0.15)" };
  return               { color: "hsl(142 71% 45%)",  background: "hsl(142 71% 45% / 0.15)" };
}

function formatContextLength(length: number | null): string | null {
  if (length == null) return null;
  if (length >= 1024) return `${Math.round(length / 1024)}k`;
  return `${length}`;
}

function formatSizeBytes(bytes: number): string {
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

// Parse "32.7B" / "756.2B" style parameter labels into billions for sorting.
function parseParamB(label: string | null): number | null {
  if (!label) return null;
  const m = label.match(/^(\d+(?:\.\d+)?)([BMK])$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  switch (m[2].toUpperCase()) {
    case "K": return n / 1000;
    case "B": return n;
    case "M": return n / 1000;
    default: return n;
  }
}

// Best-effort row size in GB: exact sizeBytes when known, else the Q4 tag estimate.
function rowSizeGB(row: CatalogModel): number | null {
  if (row.sizeBytes) return row.sizeBytes / 1024 ** 3;
  return parseTagToSizeGB(row.tag);
}

function cmpNullable<T>(a: T | null, b: T | null, cmp: (x: T, y: T) => number): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1; // nulls sort last regardless of direction
  if (b == null) return -1;
  return cmp(a, b);
}

export default function DiscoverPage() {
  const t = useTranslations("discover");
  const tc = useTranslations("common");
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "admin";
  const { toast } = useToast();
  const { servers, selectedServer, setSelectedServer } = useServers();
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [search, setSearch] = useState("");
  const [selectedCaps, setSelectedCaps] = useState<string[]>(["text"]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [downloadedModels, setDownloadedModels] = useState<Set<string>>(new Set());
  const [downloadingRefs, setDownloadingRefs] = useState<Set<string>>(new Set());
  const [gpuSpecs, setGpuSpecs] = useState<GpuSpecs | null>(null);
  const [fitsGpuOnly, setFitsGpuOnly] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey>("updated");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [filterType, setFilterType] = useState<FilterType>("all");
  const [selectedQuants, setSelectedQuants] = useState<string[]>([]);
  const [ctxMin, setCtxMin] = useState(0);
  const [ctxMax, setCtxMax] = useState(CTX_SLIDER_MAX);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualRef, setManualRef] = useState("");
  const [manualBusy, setManualBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!selectedServer) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/models?serverId=${selectedServer}`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (data.models && !cancelled) {
          setDownloadedModels(new Set(data.models.map((m: { name: string }) => m.name)));
        }
      } catch {
        // ignore
      }
    })();
    return () => { cancelled = true; };
  }, [selectedServer]);

  useEffect(() => {
    if (!selectedServer) return;
    fetch(`/api/gpu/specs?serverId=${selectedServer}`)
      .then((r) => r.json())
      .then((data: GpuSpecs | null) => setGpuSpecs(data))
      .catch(() => {});
  }, [selectedServer]);

  // Poll for download status
  useEffect(() => {
    if (downloadingRefs.size === 0) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    if (pollRef.current) return;

    pollRef.current = setInterval(async () => {
      if (!selectedServer) return;
      try {
        const [statusRes, modelsRes] = await Promise.all([
          fetch(`/api/admin/models/pull/status?serverId=${selectedServer}`),
          fetch(`/api/admin/models?serverId=${selectedServer}`),
        ]);

        if (statusRes.ok) {
          const jobs: { model: string; tag: string; status: string; error?: string }[] = await statusRes.json();
          for (const job of jobs) {
            const ref = job.tag ? `${job.model}:${job.tag}` : job.model;
            if (job.status === "error") {
              setDownloadingRefs((prev) => {
                if (!prev.has(ref)) return prev;
                const next = new Set(prev); next.delete(ref);
                toast(job.error ? `${t("pullError", { name: ref })}: ${job.error}` : t("pullError", { name: ref }), "error");
                return next;
              });
            }
          }
        }

        if (modelsRes.ok) {
          const data = await modelsRes.json();
          if (data.models) {
            const names = new Set<string>(data.models.map((m: { name: string }) => m.name));
            setDownloadedModels(names);
            setDownloadingRefs((prev) => {
              const next = new Set(prev); let changed = false;
              for (const ref of prev) {
                if (names.has(ref) || [...names].some((n) => n.startsWith(`${ref}-`))) {
                  next.delete(ref); changed = true;
                  toast(t("pullComplete", { name: ref }), "success");
                }
              }
              return changed ? next : prev;
            });
          }
        }
      } catch { /* ignore polling errors */ }
    }, 5000);

    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [downloadingRefs.size, selectedServer, t, toast]);

  const loadCatalog = useCallback(
    async (opts?: { force?: boolean }) => {
      const params = new URLSearchParams();
      if (search) params.set("q", search);
      if (selectedCaps.length > 0) params.set("c", selectedCaps.join(","));
      if (opts?.force) params.set("refresh", "1");
      try {
        const r = await fetch(`/api/catalog?${params}`);
        if (!r.ok) {
          toast(t("refreshError"), "error");
          return;
        }
        const data = await r.json();
        if (Array.isArray(data)) setModels(data);
        else toast(t("refreshError"), "error");
      } catch {
        toast(t("refreshError"), "error");
      } finally {
        setLoading(false);
      }
    },
    [search, selectedCaps, toast, t]
  );

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const seedRes = await fetch("/api/catalog/seed", { method: "POST" });
      if (!seedRes.ok) {
        // Seed endpoint is admin-only; force-refresh via GET instead.
        await loadCatalog({ force: true });
      } else {
        await loadCatalog();
      }
      toast(t("refreshSuccess"), "success");
    } catch {
      toast(t("refreshError"), "error");
    } finally {
      setRefreshing(false);
    }
  };

  const toggleCap = (cap: string) => {
    setSelectedCaps((prev) => prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap]);
  };

  const handlePull = async (modelName: string, tag?: string) => {
    if (!selectedServer) return;
    const ref = tag ? `${modelName}:${tag}` : modelName;
    if (downloadingRefs.has(ref)) return;
    setDownloadingRefs((prev) => new Set(prev).add(ref));
    try {
      const res = await fetch("/api/admin/models/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: selectedServer, name: ref }),
      });
      if (!res.ok) {
        toast(t("pullError", { name: ref }), "error");
        setDownloadingRefs((prev) => { const next = new Set(prev); next.delete(ref); return next; });
        return;
      }
      toast(t("pullStarted", { name: ref }), "success");
    } catch {
      toast(t("pullError", { name: ref }), "error");
      setDownloadingRefs((prev) => { const next = new Set(prev); next.delete(ref); return next; });
    }
  };

  // Manual install: pull an arbitrary model ref from any source Ollama can
  // fetch from (ollama.com, hf.co/user/repo:quant, ...).
  const handleManualInstall = async () => {
    const ref = manualRef.trim();
    if (!ref || !selectedServer || manualBusy) return;
    setManualBusy(true);
    try {
      const res = await fetch("/api/admin/models/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: selectedServer, name: ref }),
      });
      if (!res.ok) {
        toast(t("pullError", { name: ref }), "error");
        return;
      }
      setDownloadingRefs((prev) => new Set(prev).add(ref));
      toast(t("installStarted", { name: ref }), "success");
      setManualOpen(false);
      setManualRef("");
    } catch {
      toast(t("pullError", { name: ref }), "error");
    } finally {
      setManualBusy(false);
    }
  };

  const isModelTagDownloaded = (modelName: string, tag: string) => {
    const ref = `${modelName}:${tag}`;
    for (const name of downloadedModels) {
      if (name === ref || name.startsWith(`${ref}-`)) return true;
    }
    return false;
  };

  const isDownloading = (modelName: string, tag: string) =>
    downloadingRefs.has(`${modelName}:${tag}`);

  const getTagScore = (tag: string) => {
    if (!gpuSpecs) return null;
    const sizeGB = parseTagToSizeGB(tag);
    if (sizeGB === null) return null;
    return scoreModel(sizeGB, gpuSpecs.vramGB, gpuSpecs.bandwidthGBs ?? undefined);
  };

  // Rows arrive granular (one per model tag variant); apply type/quant/context/GPU
  // filters, then sort. Null metadata always sorts last.
  const filteredRows = useMemo(() => {
    const GRADE_ORDER: Record<string, number> = { S: 0, A: 1, B: 2, C: 3, D: 4, F: 5 };

    const rows = models.filter((row) => {
      if (filterType === "cloud" && !row.isCloud) return false;
      if (filterType === "mlx" && !row.isMLX) return false;
      if (filterType === "local" && (row.isCloud || row.isMLX)) return false;
      if (selectedQuants.length > 0 && !selectedQuants.includes(row.quantizationLevel ?? "")) return false;
      if (row.contextLength != null && (row.contextLength < ctxMin || row.contextLength > ctxMax)) return false;
      if (fitsGpuOnly && gpuSpecs) {
        const sizeGB = rowSizeGB(row);
        if (sizeGB !== null && sizeGB > gpuSpecs.vramGB) return false;
      }
      return true;
    });

    const cmp = (a: CatalogModel, b: CatalogModel): number => {
      switch (sortBy) {
        case "model":
          return a.id.localeCompare(b.id);
        case "params":
          return cmpNullable(parseParamB(a.parameterSize), parseParamB(b.parameterSize), (x, y) => x - y);
        case "quant":
          return cmpNullable(a.quantizationLevel, b.quantizationLevel, (x, y) => x.localeCompare(y));
        case "context":
          return cmpNullable(a.contextLength, b.contextLength, (x, y) => x - y);
        case "size":
          return cmpNullable(rowSizeGB(a), rowSizeGB(b), (x, y) => x - y);
        case "family":
          return cmpNullable(a.family ?? a.parentModel, b.family ?? b.parentModel, (x, y) => x.localeCompare(y));
        case "grade": {
          if (!gpuSpecs) return 0;
          const scoreA = getTagScore(a.tag);
          const scoreB = getTagScore(b.tag);
          const ga = scoreA ? GRADE_ORDER[scoreA.grade] ?? 6 : 6;
          const gb = scoreB ? GRADE_ORDER[scoreB.grade] ?? 6 : 6;
          if (ga !== gb) return ga - gb;
          return (scoreB?.tps ?? 0) - (scoreA?.tps ?? 0);
        }
        case "updated":
        default:
          return parseRelativeTime(b.updated) - parseRelativeTime(a.updated);
      }
    };

    return [...rows].sort((a, b) => cmp(a, b) * sortDir);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, filterType, selectedQuants, ctxMin, ctxMax, fitsGpuOnly, gpuSpecs, sortBy, sortDir]);

  // Reset to the first page whenever the row set changes.
  useEffect(() => {
    setPage(1);
  }, [filterType, selectedQuants, ctxMin, ctxMax, sortBy, sortDir, pageSize, search, selectedCaps]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = useMemo(
    () => filteredRows.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filteredRows, safePage, pageSize]
  );

  const quantOptions = useMemo(
    () =>
      Array.from(
        new Set(models.map((m) => m.quantizationLevel).filter((q): q is string => Boolean(q)))
      ).sort(),
    [models]
  );

  const gpuLabel = gpuSpecs
    ? `${gpuSpecs.gpuName.replace(/NVIDIA GeForce /i, "").replace(/NVIDIA /i, "")} · ${Math.round(gpuSpecs.vramGB)}GB`
    : null;

  const handleSort = (k: SortKey) => {
    if (sortBy === k) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortBy(k);
      setSortDir(1);
    }
  };

  const toggleQuant = (q: string) => {
    setSelectedQuants((prev) => prev.includes(q) ? prev.filter((x) => x !== q) : [...prev, q]);
  };

  // Context slider bounds track the widest context in the catalog/search data.
  const ctxBounds = useMemo(() => {
    const lengths = models.map((m) => m.contextLength).filter((l): l is number => l != null);
    return { min: 0, max: Math.max(CTX_SLIDER_MAX, ...lengths, 0) };
  }, [models]);

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <div className="flex flex-wrap items-center gap-3">
          {gpuLabel && (
            <span className="rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--muted))] px-2.5 py-0.5 text-xs text-[hsl(var(--muted-foreground))]">
              {gpuLabel}
            </span>
          )}
          {isAdmin && (
            <button
              onClick={() => setManualOpen(true)}
              disabled={!selectedServer}
              title={t("manualInstallDescription")}
              className="flex items-center gap-1.5 rounded-lg border border-[hsl(var(--border))] px-3 py-1.5 text-xs transition-colors hover:bg-[hsl(var(--accent))] disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" />
              {t("manualInstall")}
            </button>
          )}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-1.5 rounded-lg border border-[hsl(var(--border))] px-3 py-1.5 text-xs transition-colors hover:bg-[hsl(var(--accent))] disabled:opacity-50"
          >
            {refreshing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {refreshing ? t("refreshing") : t("refreshCatalog")}
          </button>
        </div>
      </div>

      {/* Search + Server */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("searchModels")} className="flex-1" />
        {servers.length > 1 && (
          <Select value={selectedServer} onChange={(e) => setSelectedServer(e.target.value)} className="w-auto">
            {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        )}
      </div>

      {/* Capability filters + Fits GPU */}
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Filter by capability">
        {CAPABILITY_OPTIONS.map((cap) => (
          <button
            key={cap}
            onClick={() => toggleCap(cap)}
            aria-pressed={selectedCaps.includes(cap)}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
              selectedCaps.includes(cap)
                ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                : "border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]"
            }`}
          >
            {t(`capabilities.${cap}`)}
          </button>
        ))}
        {gpuSpecs && (
          <button
            onClick={() => setFitsGpuOnly((v) => !v)}
            aria-pressed={fitsGpuOnly}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
              fitsGpuOnly
                ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                : "border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]"
            }`}
          >
            {t("fitsGpu")}
          </button>
        )}
      </div>

      {/* Type filter (Local / Cloud / MLX) */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label={t("filterType")}>
          {(["all", "local", "cloud", "mlx"] as FilterType[]).map((ft) => (
            <button
              key={ft}
              onClick={() => setFilterType(ft)}
              aria-pressed={filterType === ft}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                filterType === ft
                  ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                  : "border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]"
              }`}
            >
              {t(`type_${ft}`)}
            </button>
          ))}
        </div>
      </div>

      {/* Quant chips + context range sliders — same row */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("quant")}>
          <button
            onClick={() => setSelectedQuants([])}
            aria-pressed={selectedQuants.length === 0}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
              selectedQuants.length === 0
                ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                : "border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]"
            }`}
          >
            {t("allQuants")}
          </button>
          {quantOptions.map((q) => (
            <button
              key={q}
              onClick={() => toggleQuant(q)}
              aria-pressed={selectedQuants.includes(q)}
              className={`rounded-full border px-3 py-1 text-xs font-mono transition-colors ${
                selectedQuants.includes(q)
                  ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                  : "border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]"
              }`}
            >
              {q}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            <input
              type="range"
              min={0}
              max={ctxBounds.max}
              step={4096}
              value={ctxMin}
              onChange={(e) => { const v = Number(e.target.value); setCtxMin(v); if (v > ctxMax) setCtxMax(v); }}
              aria-label={t("contextMin")}
              className="w-28 accent-[hsl(var(--primary))]"
            />
            <span className="w-14 text-right text-xs tabular-nums text-[hsl(var(--muted-foreground))]">{formatContextLength(ctxMin)}</span>
          </div>
          <span className="text-xs text-[hsl(var(--muted-foreground))]">–</span>
          <div className="flex items-center gap-1.5">
            <input
              type="range"
              min={0}
              max={ctxBounds.max}
              step={4096}
              value={ctxMax}
              onChange={(e) => { const v = Number(e.target.value); setCtxMax(v); if (v < ctxMin) setCtxMin(v); }}
              aria-label={t("contextMax")}
              className="w-28 accent-[hsl(var(--primary))]"
            />
            <span className="w-14 text-left text-xs tabular-nums text-[hsl(var(--muted-foreground))]">{formatContextLength(ctxMax)}</span>
          </div>
        </div>
      </div>

      {/* GPU grade legend */}
      {gpuSpecs && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.4)] px-3 py-2 text-xs text-[hsl(var(--muted-foreground))]">
          <span className="font-semibold text-[hsl(var(--foreground))]">GPU:</span>
          {(["S", "A", "B", "C", "D", "F"] as Grade[]).map((g) => (
            <span key={g} className="flex items-center gap-1.5">
              <span className="rounded px-1.5 py-0.5 text-[10px] font-bold" style={{ color: gradeColor(g), background: gradeBg(g) }}>
                {g}
              </span>
              <span>{GRADE_LABELS[g]}</span>
            </span>
          ))}
        </div>
      )}

      {/* Model list */}
      {loading ? (
        <div className="mt-4 overflow-hidden rounded-lg border border-[hsl(var(--border))]">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <div key={i} className="flex items-center gap-6 border-b border-[hsl(var(--border))] px-4 py-3 last:border-0">
              <div className="h-4 w-40 animate-pulse rounded bg-[hsl(var(--muted))]" />
              <div className="h-4 flex-1 animate-pulse rounded bg-[hsl(var(--muted))] opacity-30" />
              <div className="h-4 w-20 animate-pulse rounded bg-[hsl(var(--muted))]" />
              <div className="h-6 w-6 animate-pulse rounded bg-[hsl(var(--muted))]" />
            </div>
          ))}
        </div>
      ) : filteredRows.length === 0 ? (
        <EmptyState icon={Search} title={t("emptyTitle")} description={t("emptyDescription")} />
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border border-[hsl(var(--border))]">
          {/* Column headers */}
          <div className="flex items-center gap-4 border-b border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.4)] px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
            <SortHeader label={t("model")} k="model" sortBy={sortBy} sortDir={sortDir} onClick={() => handleSort("model")} className="flex-1" />
            <SortHeader label={t("lastUpdated")} k="updated" sortBy={sortBy} sortDir={sortDir} onClick={() => handleSort("updated")} className="w-24 hidden sm:flex" alignRight />
            <SortHeader label={t("family")} k="family" sortBy={sortBy} sortDir={sortDir} onClick={() => handleSort("family")} className="w-28 hidden lg:flex" />
            <SortHeader label={t("params")} k="params" sortBy={sortBy} sortDir={sortDir} onClick={() => handleSort("params")} className="w-16 hidden lg:flex" alignRight />
            <SortHeader label={t("quant")} k="quant" sortBy={sortBy} sortDir={sortDir} onClick={() => handleSort("quant")} className="w-20 hidden xl:flex" />
            <SortHeader label={t("context")} k="context" sortBy={sortBy} sortDir={sortDir} onClick={() => handleSort("context")} className="w-20 hidden md:flex" alignRight />
            <SortHeader label={t("size")} k="size" sortBy={sortBy} sortDir={sortDir} onClick={() => handleSort("size")} className="w-28" alignRight />
            {gpuSpecs && <span className="w-24 shrink-0 text-right hidden md:block">{t("speed")}</span>}
            {gpuSpecs && (
              <SortHeader label={t("grade")} k="grade" sortBy={sortBy} sortDir={sortDir} onClick={() => handleSort("grade")} className="w-16 justify-center" />
            )}
            <span className="w-8 shrink-0" />
            <span className="w-8 shrink-0" />
          </div>

          {pageRows.map((row, idx) => {
            const baseName = row.id.includes(":") ? row.id.slice(0, row.id.indexOf(":")) : row.id;
            const downloaded = isModelTagDownloaded(baseName, row.tag);
            const pulling = isDownloading(baseName, row.tag);
            const score = getTagScore(row.tag);
            const sizeGB = rowSizeGB(row);
            const gbLabel = sizeGB != null
              ? sizeGB < 10 ? `${sizeGB.toFixed(1)} GB` : `${Math.round(sizeGB)} GB`
              : null;
            const sizeText = row.sizeLabel || (row.sizeBytes ? formatSizeBytes(row.sizeBytes) : gbLabel || "—");
            // Cloud-only rows without a download size show "cloud" instead of a dash.
            const cloudOnlySize = row.isCloud && !row.sizeBytes && !row.sizeLabel;
            const noFit = score && !score.fits;
            const isLast = idx === pageRows.length - 1;

            const rowInner = (
              <div className={[
                "flex items-center gap-4 px-4 py-3 text-sm",
                noFit ? "opacity-40" : "",
                !isLast ? "border-b border-[hsl(var(--border))]" : "",
              ].join(" ")}>
                {/* Name + variant tag + type badges + capability icons */}
                <div className="min-w-0 flex-1 flex items-center gap-3">
                  <div className="min-w-0 flex items-center gap-2 flex-wrap">
                    <span className="font-semibold truncate">{row.name}</span>
                    <span className="shrink-0 rounded bg-[hsl(var(--muted))] px-1.5 py-0.5 font-mono text-[11px] text-[hsl(var(--muted-foreground))]">
                      :{row.tag}
                    </span>
                    {row.isCloud && (
                      <span
                        title={t("cloudBadge")}
                        className="shrink-0 rounded-full border border-[hsl(217 91% 60%)] px-1.5 py-px text-[10px] font-medium text-[hsl(217 91% 60%)]"
                      >
                        {t("cloudBadge")}
                      </span>
                    )}
                    {row.isMLX && (
                      <span
                        title={t("mlxBadge")}
                        className="shrink-0 rounded-full border border-[hsl(262 83% 58%)] px-1.5 py-px text-[10px] font-medium text-[hsl(262 83% 58%)]"
                      >
                        {t("mlxBadge")}
                      </span>
                    )}
                    {row.id.startsWith("hf.co/") && (
                      <span
                        title={t("hfBadge")}
                        className="shrink-0 rounded-full border border-[hsl(142 71% 45%)] px-1.5 py-px text-[10px] font-medium text-[hsl(142 71% 45%)]"
                      >
                        {t("hfBadge")}
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {row.capabilities.map((cap) => (
                      <span key={cap} title={cap} style={{ color: CAP_COLORS[cap] ?? "hsl(var(--muted-foreground))" }}>
                        {CAP_ICONS[cap] ?? null}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Updated */}
                <span className="w-24 shrink-0 text-right text-xs text-[hsl(var(--muted-foreground))] hidden sm:block">
                  {row.updated}
                </span>

                {/* Parent model / family */}
                <span className="w-28 shrink-0 hidden lg:block text-xs text-[hsl(var(--muted-foreground))] truncate" title={row.parentModel || row.family || ""}>
                  {row.parentModel || row.family || "—"}
                </span>

                {/* Parameter size */}
                <span className="w-16 shrink-0 hidden lg:block text-right text-xs tabular-nums text-[hsl(var(--muted-foreground))]">
                  {row.parameterSize || "—"}
                </span>

                {/* Quantization level */}
                <span className="w-20 shrink-0 hidden xl:block text-xs font-mono text-[hsl(var(--muted-foreground))]">
                  {row.quantizationLevel || "—"}
                </span>

                {/* Context length */}
                <span className="w-20 shrink-0 hidden md:block text-right text-xs tabular-nums text-[hsl(var(--muted-foreground))]">
                  {formatContextLength(row.contextLength) || "—"}
                </span>

                {/* Download size (per-variant when known) + VRAM% */}
                <div className="w-28 shrink-0 flex items-center justify-end gap-1.5" title={row.sizeLabel ?? undefined}>
                  {cloudOnlySize ? (
                    <span className="text-[10px] text-[hsl(var(--muted-foreground))]">{t("cloudBadge")}</span>
                  ) : (
                    <span className="tabular-nums truncate max-w-24">{sizeText}</span>
                  )}
                  {score && gpuSpecs && (
                    <span className="rounded px-1.5 py-0.5 text-[11px] font-bold tabular-nums" style={vramStyle(score.memPct)}>
                      {Math.round(score.memPct)}%
                    </span>
                  )}
                </div>

                {/* Speed */}
                {gpuSpecs && (
                  <div className="w-24 shrink-0 text-right text-sm tabular-nums hidden md:block">
                    {score?.fits && score.tps > 0 ? (
                      <span style={{ color: gradeColor(score.grade) }}>~{Math.round(score.tps)} t/s</span>
                    ) : (
                      <span className="text-[hsl(var(--muted-foreground))]">—</span>
                    )}
                  </div>
                )}

                {/* Grade */}
                {gpuSpecs && (
                  <div className="w-16 shrink-0 flex justify-center">
                    {score ? (
                      <span className="text-xl font-bold leading-none" style={{ color: gradeColor(score.grade) }}>
                        {score.grade}
                      </span>
                    ) : (
                      <span className="text-[hsl(var(--muted-foreground))]">—</span>
                    )}
                  </div>
                )}

                {/* Ollama.com link */}
                <div className="w-8 shrink-0 flex justify-end">
                  {row.url && (
                    <a
                      href={row.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`${t("viewOnOllama")} ${row.name}`}
                      title={t("viewOnOllama")}
                      className="rounded p-1 text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))]"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  )}
                </div>

                {/* Action */}
                <div className="w-8 shrink-0 flex justify-end">
                  {downloaded ? (
                    <Check className="h-4 w-4 text-[hsl(142_71%_45%)]" />
                  ) : pulling ? (
                    <Loader2 className="h-4 w-4 animate-spin text-[hsl(var(--muted-foreground))]" />
                  ) : isAdmin ? (
                    <button
                      onClick={() => handlePull(baseName, row.tag !== "latest" ? row.tag : undefined)}
                      disabled={!selectedServer}
                      aria-label={`${t("pullModel")} ${baseName}:${row.tag}`}
                      className="rounded p-1 text-[hsl(var(--muted-foreground))] transition-colors hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))] disabled:opacity-50"
                    >
                      <Download className="h-4 w-4" />
                    </button>
                  ) : null}
                </div>
              </div>
            );

            return <div key={row.id}>{rowInner}</div>;
          })}

          {/* Pagination footer */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[hsl(var(--border))] px-4 py-2 text-xs text-[hsl(var(--muted-foreground))]">
            <span>
              {t("showing", {
                from: (safePage - 1) * pageSize + 1,
                to: Math.min(safePage * pageSize, filteredRows.length),
                total: filteredRows.length,
              })}
            </span>
            <div className="flex items-center gap-2">
              <Select
                value={String(pageSize)}
                onChange={(e) => setPageSize(Number(e.target.value))}
                className="w-auto"
                aria-label={t("pageSizeLabel")}
              >
                {[25, 50, 100].map((n) => (
                  <option key={n} value={n}>{t("pageSizeOption", { n })}</option>
                ))}
              </Select>
              <button
                onClick={() => setPage(Math.max(1, safePage - 1))}
                disabled={safePage <= 1}
                aria-label={t("prevPage")}
                className="rounded border border-[hsl(var(--border))] px-2 py-1 transition-colors hover:bg-[hsl(var(--accent))] disabled:opacity-40"
              >
                ‹
              </button>
              <span className="tabular-nums">{t("pageOf", { page: safePage, total: totalPages })}</span>
              <button
                onClick={() => setPage(Math.min(totalPages, safePage + 1))}
                disabled={safePage >= totalPages}
                aria-label={t("nextPage")}
                className="rounded border border-[hsl(var(--border))] px-2 py-1 transition-colors hover:bg-[hsl(var(--accent))] disabled:opacity-40"
              >
                ›
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Manual install modal */}
      <Modal open={manualOpen} onClose={() => setManualOpen(false)} title={t("manualInstall")}>
        <form
          onSubmit={(e) => { e.preventDefault(); void handleManualInstall(); }}
          className="space-y-3 text-sm"
        >
          <p className="text-xs text-[hsl(var(--muted-foreground))]">{t("manualInstallDescription")}</p>
          <Input
            value={manualRef}
            onChange={(e) => setManualRef(e.target.value)}
            placeholder={t("modelRefPlaceholder")}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setManualOpen(false)}
              className="rounded-lg border border-[hsl(var(--border))] px-3 py-1.5 text-xs transition-colors hover:bg-[hsl(var(--accent))]"
            >
              {tc("cancel")}
            </button>
            <button
              type="submit"
              disabled={manualBusy || !manualRef.trim() || !selectedServer}
              className="flex items-center gap-1.5 rounded-lg bg-[hsl(var(--primary))] px-3 py-1.5 text-xs text-[hsl(var(--primary-foreground))] transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {manualBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t("install")}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
