import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ListTodo, Trash2 } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import type { CrawlJob, JobStatus, PaginatedJobs } from "@dycollect/shared";
import { deleteJob, getJobs } from "../api";
import { DeleteConfirmationDialog, EmptyState, GlassCard, PageTitle, StatusBadge, formatDate } from "../components/UI";

const DELETABLE_STATUSES = new Set<JobStatus>(["completed", "completed_partial", "cancelled", "failed"]);

export function JobsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const parsedPage = Number.parseInt(searchParams.get("page") ?? "1", 10);
  const page = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const [jobs, setJobs] = useState<PaginatedJobs | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [realtimeWarning, setRealtimeWarning] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CrawlJob | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const requestId = useRef(0);
  const jobsRef = useRef<PaginatedJobs | null>(null);

  useEffect(() => {
    if (searchParams.get("page") !== String(page)) {
      setSearchParams({ page: String(page) }, { replace: true });
    }
  }, [page, searchParams, setSearchParams]);

  const loadJobs = useCallback(async (silent = false) => {
    const currentRequest = ++requestId.current;
    try {
      const value = await getJobs(page);
      if (currentRequest !== requestId.current) return;
      if (page > value.totalPages) {
        setSearchParams({ page: String(value.totalPages) }, { replace: true });
        return;
      }
      jobsRef.current = value;
      setJobs(value);
      setLoadError(null);
      setRealtimeWarning(null);
    } catch (reason) {
      if (currentRequest !== requestId.current) return;
      const message = reason instanceof Error ? reason.message : "读取任务列表失败";
      if (silent && jobsRef.current) setRealtimeWarning("实时连接正在重试，任务状态可能稍有延迟");
      else setLoadError(message);
    }
  }, [page, setSearchParams]);

  useEffect(() => {
    jobsRef.current = null;
    setJobs(null);
    setLoadError(null);
    void loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    const stream = new EventSource("/events");
    const refresh = () => void loadJobs(true);
    stream.addEventListener("snapshot", refresh);
    stream.onopen = () => setRealtimeWarning(null);
    stream.onerror = () => setRealtimeWarning("实时连接正在重试，任务状态可能稍有延迟");
    return () => stream.close();
  }, [loadJobs]);

  function requestDelete(job: CrawlJob) {
    if (!canDeleteJob(job)) return;
    setDeleteError(null);
    setDeleteTarget(job);
  }

  async function confirmDelete() {
    if (!deleteTarget || !jobs) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteJob(deleteTarget.id);
      setDeleteTarget(null);
      const destinationPage = pageAfterJobDeletion(page, jobs.items.length);
      if (destinationPage !== page) {
        setSearchParams({ page: String(destinationPage) });
      } else {
        await loadJobs();
      }
    } catch (reason) {
      setDeleteError(reason instanceof Error ? reason.message : "删除任务失败");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div>
      <PageTitle
        icon={<ListTodo size={20} strokeWidth={1.5} />}
        title="任务列表"
        description={jobs ? `共 ${jobs.total} 条任务记录，按创建时间倒序` : "查看全部采集任务与处理结果。"}
      />
      {realtimeWarning && <p className="mb-4 text-sm text-amber-300">{realtimeWarning}</p>}
      <GlassCard className="overflow-hidden">
        {!jobs && !loadError ? (
          <EmptyState title="正在读取任务" description="稍候，任务记录正在加载。" />
        ) : loadError ? (
          <EmptyState title="任务列表不可用" description={loadError} />
        ) : jobs?.items.length === 0 ? (
          <EmptyState title="还没有任务记录" description="返回任务面板提交第一个采集任务。" action={<Link className="primary-button inline-flex" to="/">创建任务</Link>} />
        ) : jobs ? <>
          <div className="hidden overflow-x-auto lg:block">
            <table className="data-table">
              <thead><tr><th>任务</th><th className="w-44">创建时间</th><th className="w-24 text-center">进度</th><th className="w-32">状态</th><th className="w-44">最近更新</th><th className="w-64">失败原因</th><th className="w-20 text-right">操作</th></tr></thead>
              <tbody>{jobs.items.map((job) => <tr key={job.id}>
                <td><p className="font-semibold text-white">{jobName(job)}</p><p className="mt-1 font-mono text-xs text-white/30">任务 #{job.id}</p></td>
                <td className="font-mono text-xs text-white/40">{formatDate(job.createdAt)}</td>
                <td className="text-center font-mono text-xs text-white/65">{job.processedCount}/{job.targetCount}</td>
                <td><StatusBadge status={job.status} /></td>
                <td className="font-mono text-xs text-white/40">{formatDate(job.updatedAt)}</td>
                <td className="max-w-64 break-words text-xs leading-5 text-red-200/65">{job.errorMessage ?? ""}</td>
                <td className="text-right"><DeleteJobButton job={job} onDelete={requestDelete} /></td>
              </tr>)}</tbody>
            </table>
          </div>
          <div className="grid gap-3 p-4 lg:hidden">{jobs.items.map((job) => <div key={job.id} className="overflow-hidden rounded-2xl border border-white/8 bg-white/3">
            <div className="p-4">
              <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="break-words text-sm font-semibold">{jobName(job)}</h2><p className="mt-1 font-mono text-xs text-white/30">任务 #{job.id}</p></div><StatusBadge status={job.status} /></div>
              <div className="mt-4 grid grid-cols-3 gap-3 text-xs"><JobMeta label="创建时间" value={formatDate(job.createdAt)} /><JobMeta label="进度" value={`${job.processedCount}/${job.targetCount}`} /><JobMeta label="最近更新" value={formatDate(job.updatedAt)} /></div>
              {job.errorMessage && <p className="mt-4 break-words rounded-xl border border-red-400/12 bg-red-500/7 px-3 py-2 text-xs leading-5 text-red-200/70">失败原因：{job.errorMessage}</p>}
            </div>
            <div className="flex justify-end border-t border-white/6 px-3 py-2"><DeleteJobButton job={job} onDelete={requestDelete} labelled /></div>
          </div>)}</div>
        </> : null}
      </GlassCard>

      {jobs && jobs.totalPages > 1 && <div className="mt-5 flex items-center justify-center gap-3">
        <button className="pagination-button" disabled={page <= 1} onClick={() => setSearchParams({ page: String(page - 1) })}><ChevronLeft size={15} />上一页</button>
        <span className="font-mono text-xs text-white/40">第 {page}/{jobs.totalPages} 页</span>
        <button className="pagination-button" disabled={page >= jobs.totalPages} onClick={() => setSearchParams({ page: String(page + 1) })}>下一页<ChevronRight size={15} /></button>
      </div>}

      <DeleteConfirmationDialog
        open={Boolean(deleteTarget)}
        title="删除任务？"
        subject={deleteTarget ? `任务 #${deleteTarget.id} · ${jobName(deleteTarget)}` : ""}
        description="此操作不可撤销，只会删除任务记录和任务处理明细，不会删除人物、作品、Markdown 或飞书同步记录。"
        loading={deleting}
        error={deleteError}
        onCancel={() => { if (!deleting) setDeleteTarget(null); }}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}

function DeleteJobButton({ job, onDelete, labelled = false }: { job: CrawlJob; onDelete: (job: CrawlJob) => void; labelled?: boolean }) {
  const deletable = canDeleteJob(job);
  const title = deletable ? "删除任务" : "请先取消任务并等待任务结束后再删除";
  return <span className="inline-flex" title={title}>
    <button
      type="button"
      className={`focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-xl text-red-300/70 transition-colors enabled:hover:bg-red-500/12 enabled:hover:text-red-200 disabled:cursor-not-allowed disabled:text-white/20 ${labelled ? "px-3 text-xs font-medium" : "min-w-11"}`}
      aria-label={`${title} ${jobName(job)}`}
      disabled={!deletable}
      onClick={() => onDelete(job)}
    >
      <Trash2 size={labelled ? 15 : 16} />{labelled && "删除任务"}
    </button>
  </span>;
}

function JobMeta({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[11px] text-white/30">{label}</p><p className="mt-1 break-words font-mono text-white/60">{value}</p></div>;
}

function jobName(job: CrawlJob): string {
  return job.mode === "favorite"
    ? `我的收藏 · ${job.sourceAwemeId ?? "等待作品"}`
    : job.creatorNickname || `用户 ${job.secUid.slice(-8)}`;
}

export function canDeleteJob(job: Pick<CrawlJob, "status">): boolean {
  return DELETABLE_STATUSES.has(job.status);
}

export function pageAfterJobDeletion(page: number, itemsOnPage: number): number {
  return itemsOnPage === 1 && page > 1 ? page - 1 : page;
}
