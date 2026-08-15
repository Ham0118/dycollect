import { useEffect, useRef, useState, type FormEvent } from "react";
import { Activity, AlertTriangle, ArrowDown, Bookmark, CheckCircle2, Clock3, Globe2, LayoutDashboard, Link2, LoaderCircle, Plus, RadioTower, RotateCcw, Square, UserRound, XCircle } from "lucide-react";
import type { CrawlJob, DebugBrowserStatus, DownloadProgress, FavoriteListenerState, JobLog, JobStage } from "@dycollect/shared";
import { cancelJob, createJob, openDebugBrowser, resumeFavoriteListener, resumeJob, startFavoriteListener, stopFavoriteListener } from "../api";
import { useDashboard } from "../hooks";
import { EmptyState, GlassCard, PageTitle, StatusBadge, formatDate } from "../components/UI";
import { useModelStatus } from "../model-status";

export function DashboardPage() {
  const { snapshot, loading, error, refresh } = useDashboard();
  const { unavailable: modelUnavailable } = useModelStatus();
  const [profileUrl, setProfileUrl] = useState("");
  const [targetCount, setTargetCount] = useState(10);
  const [retryPermanent, setRetryPermanent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [openingBrowser, setOpeningBrowser] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [mode, setMode] = useState<"creator" | "favorite">("creator");
  const [listenerBusy, setListenerBusy] = useState(false);
  const [listenerError, setListenerError] = useState<string | null>(null);
  const debugStatus = snapshot?.debugBrowser.status ?? "closed";
  const browserActive = debugStatus !== "closed" || openingBrowser;
  const creatorJobsPending = snapshot?.activeJob?.mode === "creator"
    || Boolean(snapshot?.queuedJobs.some((job) => job.mode === "creator"));
  const favoriteJobsPending = snapshot?.activeJob?.mode === "favorite"
    || Boolean(snapshot?.queuedJobs.some((job) => job.mode === "favorite"));
  const listenerEnabled = snapshot?.favoriteListener.enabled ?? false;
  const jobsPending = Boolean(snapshot?.activeJob)
    || Boolean(snapshot?.queuedJobs.length)
    || listenerEnabled;

  useEffect(() => {
    if (listenerEnabled || favoriteJobsPending) setMode("favorite");
  }, [listenerEnabled, favoriteJobsPending]);

  async function openBrowser() {
    setOpeningBrowser(true); setBrowserError(null);
    try {
      await openDebugBrowser();
      await refresh();
    } catch (reason) {
      setBrowserError(reason instanceof Error ? reason.message : "无法打开抖音浏览器");
    } finally { setOpeningBrowser(false); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true); setFormError(null);
    try {
      await createJob({ profileUrl, targetCount, retryPermanent });
      setProfileUrl("");
      await refresh();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : "提交失败");
    } finally { setSubmitting(false); }
  }

  async function listenerAction(action: "start" | "stop" | "resume") {
    setListenerBusy(true);
    setListenerError(null);
    try {
      if (action === "start") await startFavoriteListener();
      else if (action === "stop") await stopFavoriteListener();
      else await resumeFavoriteListener();
      await refresh();
    } catch (reason) {
      setListenerError(reason instanceof Error ? reason.message : "收藏监听操作失败");
    } finally {
      setListenerBusy(false);
    }
  }

  return (
    <div>
      <PageTitle icon={<LayoutDashboard size={20} strokeWidth={1.5} />} title="任务面板" description="人物主页采集与收藏监听共用同一条串行处理队列。" />
      <GlassCard className="p-5 md:p-6">
        <DebugBrowserControl
          status={debugStatus}
          opening={openingBrowser}
          jobsPending={jobsPending}
          loading={loading}
          error={browserError}
          onOpen={() => void openBrowser()}
        />
        <div className="mb-5 grid gap-2 rounded-2xl bg-white/3 p-1.5 sm:grid-cols-2" role="tablist" aria-label="任务模式">
          <button type="button" role="tab" aria-selected={mode === "creator"} className={`focus-ring flex min-h-12 items-center justify-center gap-2 rounded-xl text-sm font-medium transition ${mode === "creator" ? "bg-blue-500/20 text-blue-200" : "text-white/45 hover:bg-white/4 hover:text-white/70"}`} onClick={() => setMode("creator")}><UserRound size={17} />人物主页采集</button>
          <button type="button" role="tab" aria-selected={mode === "favorite"} className={`focus-ring flex min-h-12 items-center justify-center gap-2 rounded-xl text-sm font-medium transition ${mode === "favorite" ? "bg-pink-500/16 text-pink-200" : "text-white/45 hover:bg-white/4 hover:text-white/70"}`} onClick={() => setMode("favorite")}><Bookmark size={17} />收藏监听</button>
        </div>
        {mode === "creator" ? (
          <>
            <form onSubmit={submit} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_140px_auto] lg:items-end">
              <label className="block"><span className="field-label">人物主页 URL</span><span className="relative block"><Link2 className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" size={16} /><input className="input pl-10" value={profileUrl} onChange={(event) => setProfileUrl(event.target.value)} placeholder="输入人物主页 URL" required /></span></label>
              <label className="block"><span className="field-label">目标数</span><input className="input font-mono" type="number" min="1" max="10000" value={targetCount} onChange={(event) => setTargetCount(Number(event.target.value))} required /></label>
              <button className="primary-button" disabled={submitting || loading || browserActive || listenerEnabled || favoriteJobsPending || modelUnavailable}>{submitting ? <LoaderCircle className="animate-spin" size={17} /> : <Plus size={17} />}提交任务</button>
              <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-white/50 lg:col-span-3"><input className="size-4 accent-blue-500" type="checkbox" checked={retryPermanent} onChange={(event) => setRetryPermanent(event.target.checked)} />重试无匹配视频、无音轨等永久失败记录</label>
            </form>
            {(listenerEnabled || favoriteJobsPending) && <p className="mt-3 text-sm text-amber-200/75">收藏监听或收藏任务仍在运行，人物任务暂不可提交。</p>}
            {modelUnavailable && <p className="mt-3 text-sm text-amber-200/75">Qwen3-ASR 模型不可用，请先按照 README 完成初始化。</p>}
            {formError && <p className="mt-3 text-sm text-red-300">{formError}</p>}
          </>
        ) : (
          <FavoriteListenerControl
            state={snapshot?.favoriteListener ?? null}
            loading={loading}
            busy={listenerBusy}
            browserActive={browserActive}
            creatorJobsPending={creatorJobsPending}
            favoriteJobsPending={favoriteJobsPending}
            modelUnavailable={modelUnavailable}
            error={listenerError}
            onAction={(action) => void listenerAction(action)}
          />
        )}
      </GlassCard>

      <div className="mt-6">
        {loading ? <GlassCard><EmptyState title="正在读取任务" description="稍候，任务队列正在同步。" /></GlassCard> : snapshot?.activeJob ? <ActiveJob job={snapshot.activeJob} onRefresh={refresh} modelUnavailable={modelUnavailable} /> : <GlassCard><EmptyState title="当前没有运行中的任务" description={listenerEnabled ? "收藏监听正在等待新作品，发现新增收藏后会自动创建单视频任务。" : "提交人物主页或启动收藏监听后，处理进度会在这里实时显示。"} /></GlassCard>}
      </div>
      {error && <p className="mt-3 text-sm text-amber-300">{error}</p>}

      <TaskLogPanel
        activeJobId={snapshot?.activeJob?.id ?? null}
        jobId={snapshot?.logJobId ?? null}
        logs={snapshot?.jobLogs ?? []}
        downloadProgress={snapshot?.downloadProgress ?? null}
        loading={loading}
      />

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <JobList title="等待队列" jobs={snapshot?.queuedJobs ?? []} empty="暂无排队任务" />
        <JobList title="最近任务" jobs={snapshot?.recentJobs ?? []} empty="暂无历史任务" />
      </div>
    </div>
  );
}

export function FavoriteListenerControl({
  state,
  loading,
  busy,
  browserActive,
  creatorJobsPending,
  favoriteJobsPending,
  modelUnavailable = false,
  error,
  onAction,
}: {
  state: FavoriteListenerState | null;
  loading: boolean;
  busy: boolean;
  browserActive: boolean;
  creatorJobsPending: boolean;
  favoriteJobsPending: boolean;
  modelUnavailable?: boolean;
  error: string | null;
  onAction: (action: "start" | "stop" | "resume") => void;
}) {
  const status = state?.status ?? "stopped";
  const running = Boolean(state?.enabled);
  const statusText = status === "initializing"
    ? "监听正在初始化"
    : status === "listening"
      ? "监听中"
      : status === "waiting_verification"
        ? "等待人工验证"
        : status === "error"
          ? "监听已暂停"
          : status === "stopping"
            ? "正在停止"
            : "监听未启动";
  const statusTone = status === "listening"
    ? "text-emerald-200"
    : status === "initializing"
      ? "text-blue-200"
      : ["error", "waiting_verification"].includes(status)
        ? "text-amber-200"
        : "text-white/55";
  return (
    <div className="rounded-2xl border border-white/8 bg-white/2 p-4 md:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className={`flex items-center gap-2 text-sm font-semibold ${statusTone}`}>
            {["initializing", "stopping"].includes(status) || busy ? <LoaderCircle className="animate-spin" size={17} /> : <RadioTower size={17} />}
            {statusText}
          </div>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-white/40">
            首次打开收藏页只记录当前最新作品作为基线，不采集已有收藏；初始化完成后每 3~7 秒检查一次，新收藏会各自创建一个单视频任务。
          </p>
          {state?.baselineAwemeId && <p className="mt-2 break-all font-mono text-[11px] text-white/25">本次基线：{state.baselineAwemeId}</p>}
          {state?.lastCheckedAt && <p className="mt-1 text-[11px] text-white/25">最近检查：{formatDate(state.lastCheckedAt)}</p>}
          {!running && favoriteJobsPending && <p className="mt-2 text-xs leading-5 text-amber-200/70">监听已停止，已创建的收藏任务仍会继续串行处理；全部结束后才能提交人物任务。</p>}
          {creatorJobsPending && !running && <p className="mt-2 text-xs leading-5 text-amber-200/70">当前有人物采集任务，任务结束或取消后才能启动收藏监听。</p>}
          {state?.errorMessage && <p role="alert" className="mt-3 break-words text-sm leading-5 text-red-200/80">{state.errorMessage}</p>}
          {error && <p role="alert" className="mt-3 break-words text-sm leading-5 text-red-200/80">{error}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {!running ? (
            <button type="button" className="primary-button" disabled={loading || busy || browserActive || creatorJobsPending || modelUnavailable} onClick={() => onAction("start")}>{busy ? <LoaderCircle className="animate-spin" size={16} /> : <RadioTower size={16} />}启动监听</button>
          ) : (
            <>
              {["waiting_verification", "error"].includes(status) && <button type="button" className="ghost-button" disabled={busy || modelUnavailable} onClick={() => onAction("resume")}><RotateCcw size={16} />恢复监听</button>}
              <button type="button" className="ghost-button text-red-200/80" disabled={busy || status === "stopping"} onClick={() => onAction("stop")}><Square size={15} />停止监听</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function DebugBrowserControl({
  status,
  opening,
  jobsPending,
  loading,
  error,
  onOpen,
}: {
  status: DebugBrowserStatus;
  opening: boolean;
  jobsPending: boolean;
  loading: boolean;
  error: string | null;
  onOpen: () => void;
}) {
  const active = status !== "closed" || opening;
  return <>
    <div className="mb-5 flex flex-col gap-4 border-b border-white/8 pb-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-white">登录检查</h2>
        <p id="debug-browser-help" className="mt-1 text-xs leading-5 text-white/38">
          {status === "open"
            ? "浏览器已在采集主机打开。确认登录后，请直接关闭浏览器窗口。"
            : jobsPending
              ? "存在运行中或排队任务，任务结束后才能打开调试浏览器。"
              : "浏览器会打开在运行 听录机 的主机上，只访问首页，不执行其他操作。"}
        </p>
      </div>
      <button
        type="button"
        className="ghost-button w-full shrink-0 sm:w-auto"
        disabled={loading || jobsPending || active}
        aria-describedby="debug-browser-help"
        onClick={onOpen}
      >
        {opening || status === "opening"
          ? <><LoaderCircle className="animate-spin" size={16} />正在打开</>
          : status === "open"
            ? <><CheckCircle2 className="text-emerald-300" size={16} />浏览器已打开</>
            : <><Globe2 size={16} />打开抖音浏览器</>}
      </button>
    </div>
    {error && <p className="mb-4 text-sm text-red-300">{error}</p>}
  </>;
}

export function ActiveJob({ job, onRefresh, modelUnavailable = false }: { job: CrawlJob; onRefresh: () => Promise<void>; modelUnavailable?: boolean }) {
  const progress = Math.min(100, Math.round(job.processedCount / Math.max(job.targetCount, 1) * 100));
  const waiting = job.status === "waiting_verification";
  async function action(type: "cancel" | "resume") {
    if (type === "cancel") await cancelJob(job.id); else await resumeJob(job.id);
    await onRefresh();
  }
  return (
    <GlassCard className="overflow-hidden p-5 md:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><div className="flex flex-wrap items-center gap-3"><StatusBadge status={job.status} /><span className={`rounded-lg px-2 py-1 text-[10px] font-semibold ${job.mode === "favorite" ? "bg-pink-400/10 text-pink-200" : "bg-blue-400/10 text-blue-200"}`}>{job.mode === "favorite" ? "收藏监听" : "人物采集"}</span><span className="text-sm text-white/45">任务 #{job.id}</span></div><h2 className="mt-3 text-lg font-semibold">{job.mode === "favorite" ? "我的收藏" : job.creatorNickname ?? `用户 ${job.secUid.slice(-8)}`}</h2><p className="mt-1 text-xs text-white/35">当前作品：{job.currentAwemeId ?? "等待发现"}</p></div>
        <button className="ghost-button" onClick={() => void action("cancel")}><XCircle size={16} />取消任务</button>
      </div>
      {job.errorMessage && !waiting && <JobErrorMessage message={job.errorMessage} className="mt-5" />}
      {waiting ? <div className="mt-6 rounded-2xl border border-amber-300/15 bg-amber-400/8 p-5"><div className="flex gap-3"><AlertTriangle className="mt-0.5 shrink-0 text-amber-300" size={20} /><div><h3 className="font-semibold text-amber-200">需要在采集主机完成抖音验证</h3><p className="mt-1 text-sm leading-6 text-white/45">请在自动打开的浏览器中完成登录或人机验证，然后返回这里继续任务。</p>{job.errorMessage && <p role="alert" className="mt-3 break-words text-sm leading-6 text-amber-100/75">失败原因：{job.errorMessage}</p>}<button disabled={modelUnavailable} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-2xl bg-amber-400/15 px-4 text-sm font-semibold text-amber-200 hover:bg-amber-400/20 disabled:cursor-not-allowed disabled:opacity-40" onClick={() => void action("resume")}><RotateCcw size={16} />已完成验证，继续</button></div></div></div> : <>
        <div className="mt-6 flex items-end justify-between gap-4"><p className="text-sm text-white/45">已处理 <span className="font-mono font-semibold text-white">{job.processedCount}</span> / {job.targetCount}</p><span className="font-mono text-sm text-blue-300">{progress}%</span></div>
        <progress className="job-progress mt-3 block h-1.5 w-full" value={job.processedCount} max={Math.max(job.targetCount, 1)} aria-label={`任务进度 ${progress}%`} />
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4"><Metric label="发现" value={job.discoveredCount} tone="text-blue-300" /><Metric label="重复" value={job.duplicateCount} tone="text-amber-300" /><Metric label="成功" value={job.completedCount} tone="text-emerald-300" /><Metric label="失败" value={job.failedCount} tone="text-red-300" /></div>
      </>}
      <Stages active={job.stage} waitingVerification={waiting} />
    </GlassCard>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) { return <div className="rounded-2xl bg-white/3 px-4 py-3"><p className={`font-mono text-lg font-semibold ${tone}`}>{value}</p><p className="mt-1 text-xs text-white/35">{label}</p></div>; }

export function formatBytes(bytes: number): string {
  const safeBytes = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (safeBytes < 1_024) return `${Math.round(safeBytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = safeBytes / 1_024;
  let unitIndex = 0;
  while (value >= 1_024 && unitIndex < units.length - 1) {
    value /= 1_024;
    unitIndex += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

const stages: Array<{ stage: JobStage; label: string }> = [{ stage: "discovering", label: "发现" }, { stage: "downloading", label: "下载" }, { stage: "transcribing", label: "转录" }, { stage: "finalizing", label: "完成" }];
export function Stages({ active, waitingVerification = false }: { active: JobStage; waitingVerification?: boolean }) {
  const index = stages.findIndex((item) => item.stage === active);
  return <div className="mt-6 border-t border-white/8 pt-5">
    <p className="mb-4 text-[11px] font-medium text-white/35">当前处理阶段</p>
    {active === "waiting"
      ? <div className="flex items-center justify-center gap-2 text-xs font-semibold text-blue-300"><span className="size-2 rounded-full bg-blue-400 shadow-[0_0_10px_#5b9cff]" />{waitingVerification ? "等待人工验证" : "随机间隔等待（20–30 秒）"}</div>
      : <div className="grid grid-cols-4 gap-2">{stages.map((item, itemIndex) => <div key={item.stage} className={`flex items-center justify-center gap-2 text-xs ${itemIndex < index ? "text-emerald-300" : itemIndex === index ? "font-semibold text-blue-300" : "text-white/25"}`}><span className={`size-2 rounded-full ${itemIndex < index ? "bg-emerald-300" : itemIndex === index ? "bg-blue-400 shadow-[0_0_10px_#5b9cff]" : "bg-white/15"}`} />{item.label}</div>)}</div>}
  </div>;
}

const logStageMeta: Record<JobLog["stage"], { label: string; tone: string }> = {
  task: { label: "任务", tone: "border-violet-300/15 bg-violet-400/10 text-violet-200" },
  discovering: { label: "发现", tone: "border-blue-300/15 bg-blue-400/10 text-blue-200" },
  waiting: { label: "等待", tone: "border-slate-300/15 bg-slate-400/10 text-slate-200" },
  downloading: { label: "下载", tone: "border-cyan-300/15 bg-cyan-400/10 text-cyan-200" },
  extracting_audio: { label: "音频", tone: "border-fuchsia-300/15 bg-fuchsia-400/10 text-fuchsia-200" },
  transcribing: { label: "转录", tone: "border-indigo-300/15 bg-indigo-400/10 text-indigo-200" },
  skipped: { label: "跳过", tone: "border-amber-300/15 bg-amber-400/10 text-amber-200" },
  verification: { label: "验证", tone: "border-orange-300/15 bg-orange-400/10 text-orange-200" },
  completed: { label: "结果", tone: "border-emerald-300/15 bg-emerald-400/10 text-emerald-200" },
};

const logLevelTone: Record<JobLog["level"], string> = {
  info: "text-white/65",
  success: "text-emerald-100/80",
  warning: "text-amber-100/80",
  error: "text-red-200/85",
};

export function TaskLogPanel({
  activeJobId,
  jobId,
  logs,
  downloadProgress = null,
  loading = false,
}: {
  activeJobId: number | null;
  jobId: number | null;
  logs: JobLog[];
  downloadProgress?: DownloadProgress | null;
  loading?: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [autoFollow, setAutoFollow] = useState(true);
  const lastLogId = logs.at(-1)?.id ?? null;
  const activeDownload = downloadProgress?.jobId === jobId ? downloadProgress : null;
  const hasEntries = logs.length > 0 || activeDownload !== null;

  function scrollToBottom(behavior: ScrollBehavior = "auto") {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior });
  }

  useEffect(() => {
    setAutoFollow(true);
  }, [jobId]);

  useEffect(() => {
    if (autoFollow) scrollToBottom();
  }, [autoFollow, lastLogId, activeDownload?.updatedAt]);

  function handleScroll() {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setAutoFollow(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 28);
  }

  const title = jobId === null
    ? "任务日志"
    : activeJobId === jobId
      ? `任务 #${jobId} 的实时日志`
      : `最近任务 #${jobId} 的日志`;

  return <GlassCard className="mt-6 overflow-hidden">
    <div className="flex items-center justify-between gap-4 border-b border-white/8 px-5 py-4 md:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-blue-400/10 text-blue-300"><Activity size={17} /></span>
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-white">{title}</h2>
          <p className="mt-0.5 text-xs text-white/32">记录每个视频的下载、音频提取、转录和跳过情况</p>
        </div>
      </div>
      {!autoFollow && hasEntries && <button type="button" className="ghost-button min-h-9 shrink-0 px-3" onClick={() => { setAutoFollow(true); scrollToBottom("smooth"); }}><ArrowDown size={14} />回到底部</button>}
    </div>
    <div
      ref={viewportRef}
      role="log"
      aria-live="polite"
      aria-label={title}
      onScroll={handleScroll}
      className="max-h-96 min-h-36 overflow-x-hidden overflow-y-auto px-5 py-4 md:px-6"
    >
      {loading
        ? <p className="flex min-h-28 items-center justify-center gap-2 text-sm text-white/35"><LoaderCircle className="animate-spin" size={16} />正在读取日志</p>
        : jobId === null
          ? <p className="flex min-h-28 items-center justify-center text-sm text-white/30">暂无任务日志</p>
          : !hasEntries
            ? <p className="flex min-h-28 items-center justify-center text-sm text-white/30">任务已经建立，等待第一条日志</p>
            : <ol className="space-y-2.5">
                {logs.map((log) => {
                  const meta = logStageMeta[log.stage];
                  return <li key={log.id} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-2xl bg-white/3 px-3.5 py-3 sm:grid-cols-[74px_auto_minmax(0,1fr)] sm:items-start">
                    <time className="flex items-center gap-1.5 font-mono text-[11px] text-white/28" dateTime={log.createdAt}><Clock3 size={12} />{formatLogTime(log.createdAt)}</time>
                    <span className={`w-fit rounded-lg border px-2 py-0.5 text-[10px] font-semibold ${meta.tone}`}>{meta.label}</span>
                    <p className={`col-span-2 min-w-0 whitespace-normal break-words text-xs leading-5 [overflow-wrap:anywhere] sm:col-span-1 ${logLevelTone[log.level]}`}>{log.message}</p>
                  </li>;
                })}
                {activeDownload && <DownloadProgressLogItem key="download-progress" progress={activeDownload} />}
              </ol>}
    </div>
  </GlassCard>;
}

export function DownloadProgressLogItem({ progress }: { progress: DownloadProgress }) {
  const connecting = progress.receivedBytes === 0;
  const determinate = progress.totalBytes !== null;
  const percent = determinate
    ? progress.percent ?? Math.min(100, (progress.receivedBytes / progress.totalBytes!) * 100)
    : null;
  const work = progress.title
    ? `作品《${progress.title}》（${progress.awemeId}）`
    : `作品 ${progress.awemeId}`;
  const message = connecting
    ? `${work}正在连接媒体服务器`
    : determinate
      ? `${work}下载中 ${percent!.toFixed(1)}%（${formatBytes(progress.receivedBytes)} / ${formatBytes(progress.totalBytes!)}）`
      : `${work}下载中（已下载 ${formatBytes(progress.receivedBytes)} · 总大小未知）`;
  const meta = logStageMeta.downloading;

  return <li data-transient-download="true" className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-2xl border border-cyan-300/10 bg-cyan-400/6 px-3.5 py-3 sm:grid-cols-[74px_auto_minmax(0,1fr)] sm:items-start">
    <time className="flex items-center gap-1.5 font-mono text-[11px] text-white/28" dateTime={progress.updatedAt}><Clock3 size={12} />{formatLogTime(progress.updatedAt)}</time>
    <span className={`w-fit rounded-lg border px-2 py-0.5 text-[10px] font-semibold ${meta.tone}`}>{meta.label}</span>
    <div className="col-span-2 min-w-0 sm:col-span-1">
      <p className="whitespace-normal break-words text-xs leading-5 text-cyan-100/80 [overflow-wrap:anywhere]">{message}</p>
      {connecting || !determinate
        ? <div
            className="download-progress-indeterminate mt-2 h-1 overflow-hidden rounded-full bg-white/8"
            role="progressbar"
            aria-label="视频下载进度"
            aria-valuetext={message}
          />
        : <progress
            className="job-progress mt-2 block h-1 w-full"
            value={Math.min(progress.receivedBytes, progress.totalBytes!)}
            max={progress.totalBytes!}
            aria-label={`视频下载进度 ${percent!.toFixed(1)}%`}
          />}
    </div>
  </li>;
}

function formatLogTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function JobErrorMessage({ message, className = "" }: { message: string; className?: string }) {
  return <p role="alert" className={`flex items-start gap-2 break-words rounded-2xl border border-red-400/15 bg-red-500/8 px-4 py-3 text-sm leading-5 text-red-200/80 ${className}`}><AlertTriangle className="mt-0.5 shrink-0" size={15} /> <span>失败原因：{message}</span></p>;
}

export function JobList({ title, jobs, empty }: { title: string; jobs: CrawlJob[]; empty: string }) {
  return <GlassCard className="p-5 md:p-6"><h2 className="text-base font-semibold">{title}</h2>{jobs.length ? <div className="mt-4 space-y-2">{jobs.map((job) => <div key={job.id} className="rounded-2xl bg-white/3 px-4 py-3"><div className="flex items-center justify-between gap-3"><div className="min-w-0"><div className="flex min-w-0 items-center gap-2"><span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[9px] font-semibold ${job.mode === "favorite" ? "bg-pink-400/10 text-pink-200" : "bg-blue-400/10 text-blue-200"}`}>{job.mode === "favorite" ? "收藏" : "人物"}</span><p className="truncate text-sm font-medium">{job.mode === "favorite" ? "我的收藏" : job.creatorNickname ?? job.secUid.slice(-10)}</p></div><p className="mt-1 text-xs text-white/30">#{job.id} · {formatDate(job.updatedAt)}</p></div><div className="flex shrink-0 items-center gap-3"><span className="font-mono text-xs text-white/45">{job.processedCount}/{job.targetCount}</span><StatusBadge status={job.status} /></div></div>{job.errorMessage && <JobErrorMessage message={job.errorMessage} className="mt-3" />}</div>)}</div> : <p className="mt-5 text-sm text-white/30">{empty}</p>}</GlassCard>;
}
