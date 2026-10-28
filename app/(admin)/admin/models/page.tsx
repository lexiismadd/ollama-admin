"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState, useCallback, useRef } from "react";
import type { OllamaModel, OllamaRunningModel, OllamaShowResponse } from "@/lib/ollama";
import { Package, Search, Cpu, Eye, Trash2, AlertTriangle, Upload, ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { CapabilityIcons } from "@/components/ui/capability-icons";
import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { useServers } from "@/lib/hooks/use-servers";
import { useUnloadModel } from "@/lib/hooks/use-unload-model";
import { extractContextLength } from "@/lib/catalog-cloud";

function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatContextLength(length: number | null | undefined): string | null {
  if (length == null) return null;
  if (length >= 1024) return `${Math.round(length / 1024)}k`;
  return `${length}`;
}

// Australian regional format (dd/mm/yyyy, 24hr time) per the recognised
// regional settings — never the browser's locale, which may differ.
function formatDateTimeRegional(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-AU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatDateRegional(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function displayName(family: string | undefined, parentModel: string | undefined, name: string): string {
  if (parentModel && parentModel !== name) return parentModel;
  return family || "—";
}

export default function ModelsPage() {
  const t = useTranslations("admin.models");
  const tc = useTranslations("common");
  const { toast } = useToast();
  const { servers, selectedServer, setSelectedServer } = useServers();
  const unloadModel = useUnloadModel(tc);
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [running, setRunning] = useState<OllamaRunningModel[]>([]);
  const [updatingRefs, setUpdatingRefsState] = useState<Set<string>>(new Set());
  const [updatingAll, setUpdatingAll] = useState(false);
  const updatingRefsRef = useRef<Set<string>>(new Set());
  const updatingAllRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const setUpdatingRefs = (next: Set<string>) => {
    updatingRefsRef.current = next;
    setUpdatingRefsState(next);
  };
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState(false);
  const [search, setSearch] = useState("");
  const [inspecting, setInspecting] = useState<OllamaShowResponse | null>(null);
  const [inspectName, setInspectName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const fetchModels = useCallback(async () => {
    if (!selectedServer) return;
    setLoading(true);
    setConnectionError(false);
    try {
      const [modelsRes, runningRes] = await Promise.all([
        fetch(`/api/admin/models?serverId=${selectedServer}`),
        fetch(`/api/admin/models/running?serverId=${selectedServer}`),
      ]);
      if (!modelsRes.ok) {
        setConnectionError(true);
        setModels([]);
        setRunning([]);
        return;
      }
      const modelsData = await modelsRes.json();
      const runningData = runningRes.ok ? await runningRes.json() : { models: [] };
      setModels(modelsData.models || []);
      setRunning(runningData.models || []);
    } catch {
      setConnectionError(true);
      setModels([]);
      setRunning([]);
    } finally {
      setLoading(false);
    }
  }, [selectedServer]);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") fetchModels();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [fetchModels]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await fetch("/api/admin/models/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: selectedServer, name: deleteTarget }),
      });
      toast(t("deleteSuccess", { model: deleteTarget }), "success");
      fetchModels();
    } catch {
      toast(t("deleteError"), "error");
    }
    setDeleteTarget(null);
  };

  const handleInspect = async (name: string) => {
    const res = await fetch("/api/admin/models/show", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId: selectedServer, name }),
    });
    const data = await res.json();
    setInspecting(data);
    setInspectName(name);
  };

  const handleUnload = async (name: string) => {
    await unloadModel(name, selectedServer);
    fetchModels();
  };

  // "Update" = re-pull the model ref; Ollama fetches newer layers when the
  // upstream (ollama.com, hf.co/...) has published an update.
  const handleUpdate = async (name: string) => {
    if (!selectedServer || updatingRefsRef.current.has(name)) return;
    const next = new Set(updatingRefsRef.current).add(name);
    setUpdatingRefs(next);
    try {
      const res = await fetch("/api/admin/models/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: selectedServer, name }),
      });
      if (!res.ok) {
        toast(t("updateError"), "error");
        const done = new Set(updatingRefsRef.current); done.delete(name);
        setUpdatingRefs(done);
      } else {
        toast(t("updateStarted", { model: name }), "success");
      }
    } catch {
      toast(t("updateError"), "error");
      const done = new Set(updatingRefsRef.current); done.delete(name);
      setUpdatingRefs(done);
    }
  };

  // Re-pull every installed model, including refs from non-ollama.com
  // sources (hf.co/...). Staggered to avoid hammering the server.
  const handleUpdateAll = async () => {
    if (!selectedServer || updatingAll || models.length === 0) return;
    setUpdatingAll(true);
    updatingAllRef.current = true;
    toast(t("updateAllStarted", { n: models.length }), "success");
    for (const model of models) {
      if (updatingRefsRef.current.has(model.name)) continue;
      const next = new Set(updatingRefsRef.current).add(model.name);
      setUpdatingRefs(next);
      try {
        await fetch("/api/admin/models/pull", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serverId: selectedServer, name: model.name }),
        });
      } catch {
        // per-model failure is surfaced by the status poll
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  // Poll pull-job status; completes tracked updates and refreshes the list.
  useEffect(() => {
    if (updatingRefs.size === 0) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    if (pollRef.current) return;

    pollRef.current = setInterval(async () => {
      if (!selectedServer) return;
      try {
        const res = await fetch(`/api/admin/models/pull/status?serverId=${selectedServer}`);
        if (!res.ok) return;
        const jobs: { model: string; tag: string; status: string; error?: string }[] = await res.json();
        const refOf = (j: { model: string; tag: string }) => (j.tag ? `${j.model}:${j.tag}` : j.model);
        const finished = jobs.filter(
          (j) => (j.status === "done" || j.status === "error") && updatingRefsRef.current.has(refOf(j))
        );
        if (finished.length === 0) return;

        const next = new Set(updatingRefsRef.current);
        for (const job of finished) next.delete(refOf(job));
        setUpdatingRefs(next);

        for (const job of finished) {
          if (job.status === "error") {
            toast(job.error ? `${t("updateError")}: ${job.error}` : t("updateError"), "error");
          } else {
            toast(t("updateComplete", { model: refOf(job) }), "success");
          }
        }
        fetchModels();

        if (updatingAllRef.current && next.size === 0) {
          updatingAllRef.current = false;
          setUpdatingAll(false);
          toast(t("updateAllComplete"), "success");
        }
      } catch { /* ignore polling errors */ }
    }, 4000);

    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [updatingRefs.size, selectedServer, t, toast, fetchModels]);

  const isRunning = (name: string) =>
    running.some((r) => r.name === name || r.model === name);

  const getVram = (name: string) => {
    const r = running.find((r) => r.name === name || r.model === name);
    return r ? formatBytes(r.size_vram) : null;
  };

  const filtered = models.filter((m) =>
    m.name.toLowerCase().includes(search.toLowerCase())
  );

  if (loading && models.length === 0) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} variant="card" />
          ))}
        </div>
      </div>
    );
  }

  if (connectionError && !loading) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        {servers.length > 1 && (
          <Select value={selectedServer} onChange={(e) => setSelectedServer(e.target.value)} className="mt-4 w-auto">
            {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        )}
        <EmptyState
          icon={AlertTriangle}
          title={tc("connectionError")}
          description={tc("connectionErrorDescription")}
          action={<Button onClick={fetchModels}>{tc("retry")}</Button>}
        />
      </div>
    );
  }

  if (models.length === 0 && !loading) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        {servers.length > 1 && (
          <Select value={selectedServer} onChange={(e) => setSelectedServer(e.target.value)} className="mt-4 w-auto">
            {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        )}
        <EmptyState
          icon={Package}
          title={t("emptyTitle")}
          description={t("emptyDescription")}
          action={<a href="/discover"><Button>{t("emptyAction")}</Button></a>}
        />
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleUpdateAll}
            disabled={!selectedServer || updatingAll || models.length === 0}
            title={t("updateAll")}
          >
            <RefreshCw className={`h-4 w-4 ${updatingAll ? "animate-spin" : ""}`} />
            <span className="hidden lg:inline">{updatingAll ? t("updating") : t("updateAll")}</span>
          </Button>
          {servers.length > 1 && (
            <Select value={selectedServer} onChange={(e) => setSelectedServer(e.target.value)} className="w-auto">
              {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          )}
        </div>
      </div>

      <div className="mt-4">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("searchPlaceholder")} />
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={Search} title={t("noResults")} description={t("noResultsDescription")} />
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border border-[hsl(var(--border))]">
          {/* Column headers */}
          <div className="flex items-center gap-4 border-b border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.6)] px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
            <span className="flex-1">{t("name")}</span>
            <span className="w-28 shrink-0 hidden lg:block">{t("family")}</span>
            <span className="w-16 shrink-0 hidden lg:block text-right">{t("params")}</span>
            <span className="w-20 shrink-0 hidden xl:block">{t("quantization")}</span>
            <span className="w-20 shrink-0 hidden md:block text-right">{t("context")}</span>
            <span className="w-24 shrink-0 text-right">{t("size")}</span>
            <span className="w-24 shrink-0 hidden sm:block text-right">{t("modified")}</span>
            <span className="w-32 shrink-0 hidden xl:block text-right">{t("lastUsed")}</span>
            <span className="w-36 shrink-0 text-right">{t("actions")}</span>
          </div>

          {filtered.map((model, idx) => {
            const runningVram = getVram(model.name);
            const isLast = idx === filtered.length - 1;
            return (
              <div
                key={model.name}
                className={`flex items-center gap-4 px-4 py-3 text-sm ${!isLast ? "border-b border-[hsl(var(--border))]" : ""}`}
              >
                {/* Name + capabilities + running badge */}
                <div className="min-w-0 flex-1 flex items-center gap-2">
                  <span className="font-semibold truncate" title={model.name}>{model.name}</span>
                  {model.url && (
                    <a
                      href={model.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex shrink-0 items-center gap-1 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))] transition-colors"
                      title="Ollama.com"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                  {model.capabilities && (
                    <span className="flex shrink-0 items-center gap-1">
                      <CapabilityIcons capabilities={model.capabilities} />
                    </span>
                  )}
                  {isRunning(model.name) && (
                    <Badge variant="success" className="shrink-0">
                      <Cpu className="mr-1 h-3 w-3" />
                      {runningVram ? `${t("loaded")} · ${runningVram}` : t("loaded")}
                    </Badge>
                  )}
                </div>

                {/* Parent model / family */}
                <span className="w-28 shrink-0 hidden lg:block text-xs text-[hsl(var(--muted-foreground))] truncate" title={model.details?.parent_model || model.details?.family || ""}>
                  {displayName(model.details?.family, model.details?.parent_model, model.name)}
                </span>

                {/* Parameter size */}
                <span className="w-16 shrink-0 hidden lg:block text-right text-xs tabular-nums text-[hsl(var(--muted-foreground))]">
                  {model.details?.parameter_size || "—"}
                </span>

                {/* Quantization level */}
                <span className="w-20 shrink-0 hidden xl:block text-xs font-mono text-[hsl(var(--muted-foreground))]">
                  {model.details?.quantization_level || "—"}
                </span>

                {/* Context length */}
                <span className="w-20 shrink-0 hidden md:block text-right text-xs tabular-nums text-[hsl(var(--muted-foreground))]">
                  {formatContextLength(model.context_length) || "—"}
                </span>

                {/* Disk size — cloud-only models (no local files) show "cloud" */}
                <span className="w-24 shrink-0 text-right text-xs tabular-nums">
                  {model.size > 0
                    ? formatBytes(model.size)
                    : <span className="text-[10px] text-[hsl(var(--muted-foreground))]">{t("cloud")}</span>}
                </span>

                {/* Modified */}
                <span className="w-24 shrink-0 hidden sm:block text-right text-xs text-[hsl(var(--muted-foreground))]">
                  {formatDateRegional(model.modified_at)}
                </span>

                {/* Last used */}
                <span className="w-32 shrink-0 hidden xl:block text-right text-xs tabular-nums text-[hsl(var(--muted-foreground))]">
                  {formatDateTimeRegional(model.last_used)}
                </span>

                {/* Actions */}
                <div className="w-36 shrink-0 flex items-center justify-end gap-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleUpdate(model.name)}
                    disabled={updatingRefs.has(model.name)}
                    title={t("update")}
                  >
                    <RefreshCw className={`h-4 w-4 ${updatingRefs.has(model.name) ? "animate-spin" : ""}`} />
                  </Button>
                  {isRunning(model.name) && (
                    <Button variant="secondary" size="sm" onClick={() => handleUnload(model.name)} title={t("unload")}>
                      <Upload className="h-4 w-4" />
                      <span className="hidden lg:inline">{t("unload")}</span>
                    </Button>
                  )}
                  <Button variant="secondary" size="sm" onClick={() => handleInspect(model.name)} title={t("inspect")}>
                    <Eye className="h-4 w-4" />
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => setDeleteTarget(model.name)} title={tc("delete")}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal open={!!inspecting} onClose={() => setInspecting(null)} title={inspectName}>
        {inspecting && (
          <div className="space-y-3 text-sm">
            <div><span className="font-medium">{t("family")}:</span> {inspecting.details?.family || "—"}</div>
            <div><span className="font-medium">{t("parentModel")}:</span> {inspecting.details?.parent_model || "—"}</div>
            <div><span className="font-medium">{t("params")}:</span> {inspecting.details?.parameter_size || "—"}</div>
            <div><span className="font-medium">{t("quantization")}:</span> {inspecting.details?.quantization_level || "—"}</div>
            <div><span className="font-medium">{t("context")}:</span> {formatContextLength(extractContextLength(inspecting.model_info)) || "—"}</div>
            <div><span className="font-medium">Format:</span> {inspecting.details?.format || "—"}</div>
            {inspecting.capabilities && (
              <div className="flex items-center gap-2">
                <span className="font-medium">{t("capabilities")}:</span>
                <CapabilityIcons capabilities={inspecting.capabilities} />
              </div>
            )}
            {inspecting.parameters && (
              <div>
                <span className="font-medium">Parameters:</span>
                <pre className="mt-1 overflow-auto rounded-md bg-[hsl(var(--muted))] p-3 text-xs">{inspecting.parameters}</pre>
              </div>
            )}
            {inspecting.template && (
              <div>
                <span className="font-medium">Template:</span>
                <pre className="mt-1 overflow-auto rounded-md bg-[hsl(var(--muted))] p-3 text-xs">{inspecting.template}</pre>
              </div>
            )}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        title={t("deleteTitle")}
        description={t("deleteDescription", { model: deleteTarget || "" })}
        confirmLabel={tc("delete")}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
