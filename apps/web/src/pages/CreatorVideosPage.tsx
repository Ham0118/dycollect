import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, CloudUpload, Files, Trash2 } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { Creator, PaginatedVideos, VideoRecord } from "@dycollect/shared";
import { deleteVideo, getCreator, getVideos } from "../api";
import { canSyncVideo, FeishuSyncDialog } from "../components/FeishuSyncDialog";
import { DeleteConfirmationDialog, EmptyState, FeishuSyncBadge, GlassCard, PageTitle, StatusBadge, formatDate } from "../components/UI";

export function CreatorVideosPage() {
  const { secUid = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const page = Math.max(1, Number.parseInt(searchParams.get("page") ?? "1", 10) || 1);
  const [creator, setCreator] = useState<Creator | null>(null);
  const [videos, setVideos] = useState<PaginatedVideos | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VideoRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [syncOpen, setSyncOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    setError(null);
    void Promise.all([getCreator(secUid), getVideos(secUid, page)])
      .then(([creatorValue, videosValue]) => { setCreator(creatorValue); setVideos(videosValue); })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "读取失败"));
  }, [secUid, page]);

  useEffect(() => {
    setSelectedIds(new Set());
    setSyncOpen(false);
  }, [secUid, page]);

  const open = (id: string) => navigate(`/articles/${id}`);
  const nickname = creator?.nickname || "人物作品";
  const videoTitle = (video: VideoRecord) => video.title || `无标题 ${video.awemeId}`;
  const eligibleVideos = videos?.items.filter(canSyncVideo) ?? [];
  const selectedVideos = videos?.items.filter((video) => selectedIds.has(video.awemeId) && canSyncVideo(video)) ?? [];
  const allEligibleSelected = eligibleVideos.length > 0 && eligibleVideos.every((video) => selectedIds.has(video.awemeId));

  function toggleVideo(awemeId: string, selected: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) next.add(awemeId);
      else next.delete(awemeId);
      return next;
    });
  }

  function toggleAll(selected: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const video of eligibleVideos) {
        if (selected) next.add(video.awemeId);
        else next.delete(video.awemeId);
      }
      return next;
    });
  }

  function requestDelete(video: VideoRecord) {
    setDeleteError(null);
    setDeleteTarget(video);
  }

  async function confirmDelete() {
    if (!deleteTarget || !videos) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteVideo(deleteTarget.awemeId);
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(deleteTarget.awemeId);
        return next;
      });
      const deletedCompleted = deleteTarget.status === "completed";
      setCreator((current) => current && deletedCompleted
        ? { ...current, completedCount: Math.max(0, current.completedCount - 1) }
        : current);
      setDeleteTarget(null);
      const destinationPage = pageAfterVideoDeletion(page, videos.items.length);
      if (destinationPage !== page) {
        setSearchParams({ page: String(destinationPage) });
      } else {
        setVideos((current) => current ? {
          ...current,
          items: current.items.filter((video) => video.awemeId !== deleteTarget.awemeId),
          total: Math.max(0, current.total - 1),
          totalPages: Math.max(1, Math.ceil(Math.max(0, current.total - 1) / current.pageSize)),
        } : current);
      }
    } catch (reason) {
      setDeleteError(reason instanceof Error ? reason.message : "删除作品失败");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div>
      <nav className="mb-5 flex items-center gap-2 text-xs text-white/35"><Link className="hover:text-blue-300" to="/creators">人物列表</Link><span>/</span><span className="text-white/65">{nickname}</span></nav>
      <PageTitle icon={<Files size={20} strokeWidth={1.5} />} title={`${nickname} · 作品列表`} description={videos ? `共 ${videos.total} 条记录，按发布时间倒序` : "读取作品记录中"} />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-white/35">仅已生成 Markdown 的文章可以同步</p>
        <button type="button" className="primary-button" disabled={selectedVideos.length === 0} onClick={() => setSyncOpen(true)}><CloudUpload size={16} />同步飞书{selectedVideos.length > 0 ? `（${selectedVideos.length}）` : ""}</button>
      </div>
      <GlassCard className="overflow-hidden">
        {error ? <EmptyState title="作品列表不可用" description={error} /> : !videos ? <EmptyState title="正在读取作品" description="稍候，作品状态正在加载。" /> : videos.items.length === 0 ? <EmptyState title="还没有作品记录" description="为这个人物提交采集任务后，处理记录会显示在这里。" /> : <>
          <div className="hidden overflow-x-auto lg:block">
            <table className="data-table">
              <thead><tr><th className="w-14"><input type="checkbox" className="size-4 accent-[#5b9cff]" aria-label="全选当前页可同步文章" checked={allEligibleSelected} disabled={eligibleVideos.length === 0} onChange={(event) => toggleAll(event.target.checked)} /></th><th>标题</th><th className="w-44">发布时间</th><th className="w-28">状态</th><th className="w-28">飞书同步</th><th className="w-56 text-right">失败原因</th><th className="w-20 text-right">操作</th></tr></thead>
              <tbody>{videos.items.map((video) => <tr key={video.awemeId} tabIndex={0} role="link" onClick={() => open(video.awemeId)} onKeyDown={(event) => { if (event.target === event.currentTarget && event.key === "Enter") open(video.awemeId); }}>
                <td onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}><input type="checkbox" className="size-4 accent-[#5b9cff]" aria-label={`选择文章 ${videoTitle(video)}`} title={canSyncVideo(video) ? "选择同步" : "文章尚未生成，不能同步"} checked={selectedIds.has(video.awemeId)} disabled={!canSyncVideo(video)} onChange={(event) => toggleVideo(video.awemeId, event.target.checked)} /></td>
                <td className="max-w-0"><p className="truncate font-medium text-white/85">{videoTitle(video)}</p></td>
                <td className="font-mono text-xs text-white/40">{formatDate(video.publishedAt)}</td>
                <td><StatusBadge status={video.status} /></td>
                <td><FeishuSyncBadge synced={video.feishuSynced} /></td>
                <td className="text-right text-xs leading-5 text-red-200/65">{video.failureReason ?? ""}</td>
                <td className="text-right"><button type="button" className="focus-ring inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-red-300/70 transition-colors hover:bg-red-500/12 hover:text-red-200" aria-label={`删除作品 ${videoTitle(video)}`} onClick={(event) => { event.stopPropagation(); requestDelete(video); }}><Trash2 size={16} /></button></td>
              </tr>)}</tbody>
            </table>
          </div>
          <div className="grid gap-3 p-4 lg:hidden">{videos.items.map((video) => <div key={video.awemeId} className="overflow-hidden rounded-2xl border border-white/8 bg-white/3">
            <div className="flex items-start">
              <label className="grid min-h-14 w-12 shrink-0 place-items-center pl-2 pt-2" title={canSyncVideo(video) ? "选择同步" : "文章尚未生成，不能同步"}><input type="checkbox" className="size-4 accent-[#5b9cff]" aria-label={`选择文章 ${videoTitle(video)}`} checked={selectedIds.has(video.awemeId)} disabled={!canSyncVideo(video)} onChange={(event) => toggleVideo(video.awemeId, event.target.checked)} /></label>
              <button type="button" className="focus-ring block min-w-0 flex-1 p-4 pl-2 text-left" onClick={() => open(video.awemeId)}>
                <div className="flex items-start justify-between gap-4"><h2 className="line-clamp-2 text-sm font-semibold leading-6">{videoTitle(video)}</h2><div className="flex shrink-0 flex-col items-end gap-1.5"><StatusBadge status={video.status} /><FeishuSyncBadge synced={video.feishuSynced} /></div></div>
                <p className="mt-3 font-mono text-xs text-white/35">{formatDate(video.publishedAt)}</p>
                {video.failureReason && <p className="mt-3 text-xs leading-5 text-red-200/65">{video.failureReason}</p>}
              </button>
            </div>
            <div className="flex justify-end border-t border-white/6 px-3 py-2"><button type="button" className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-xs font-medium text-red-300/75 hover:bg-red-500/12 hover:text-red-200" aria-label={`删除作品 ${videoTitle(video)}`} onClick={() => requestDelete(video)}><Trash2 size={15} />删除作品</button></div>
          </div>)}</div>
        </>}
      </GlassCard>
      {videos && videos.totalPages > 1 && <div className="mt-5 flex items-center justify-center gap-3"><button className="pagination-button" disabled={page <= 1} onClick={() => setSearchParams({ page: String(page - 1) })}><ChevronLeft size={15} />上一页</button><span className="font-mono text-xs text-white/40">第 {page}/{videos.totalPages} 页</span><button className="pagination-button" disabled={page >= videos.totalPages} onClick={() => setSearchParams({ page: String(page + 1) })}>下一页<ChevronRight size={15} /></button></div>}
      <DeleteConfirmationDialog
        open={Boolean(deleteTarget)}
        title="删除作品？"
        subject={deleteTarget ? videoTitle(deleteTarget) : ""}
        description="此操作不可撤销，将删除该作品记录、Markdown 和失败后保留的视频文件。之后重新采集时可以再次生成。"
        loading={deleting}
        error={deleteError}
        onCancel={() => { if (!deleting) setDeleteTarget(null); }}
        onConfirm={() => void confirmDelete()}
      />
      <FeishuSyncDialog
        open={syncOpen}
        source="creator"
        articles={selectedVideos}
        onCancel={() => setSyncOpen(false)}
        onComplete={(result) => {
          const failed = new Set(result.items.filter((item) => item.status === "failed").map((item) => item.awemeId));
          setSelectedIds(failed);
          void getVideos(secUid, page)
            .then(setVideos)
            .catch((reason) => setError(reason instanceof Error ? reason.message : "刷新作品列表失败"));
        }}
      />
    </div>
  );
}

export function pageAfterVideoDeletion(page: number, itemsOnPage: number): number {
  return itemsOnPage === 1 && page > 1 ? page - 1 : page;
}
