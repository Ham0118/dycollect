import { useEffect, useState } from "react";
import { Bookmark, ChevronLeft, ChevronRight, CloudUpload, Trash2 } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { FavoriteVideoRecord, PaginatedFavorites } from "@dycollect/shared";
import { deleteFavoriteVideo, getFavorites } from "../api";
import { canSyncVideo, FeishuSyncDialog } from "../components/FeishuSyncDialog";
import { DeleteConfirmationDialog, EmptyState, FeishuSyncBadge, GlassCard, PageTitle, StatusBadge, formatDate } from "../components/UI";

export function FavoritesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const parsedPage = Number.parseInt(searchParams.get("page") ?? "1", 10);
  const page = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const [favorites, setFavorites] = useState<PaginatedFavorites | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [syncOpen, setSyncOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<FavoriteVideoRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (searchParams.get("page") !== String(page)) {
      setSearchParams({ page: String(page) }, { replace: true });
    }
  }, [page, searchParams, setSearchParams]);

  useEffect(() => {
    let active = true;
    setFavorites(null);
    setError(null);
    void getFavorites(page)
      .then((value) => {
        if (!active) return;
        if (page > value.totalPages) {
          setSearchParams({ page: String(value.totalPages) }, { replace: true });
          return;
        }
        setFavorites(value);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "读取收藏列表失败");
      });
    return () => { active = false; };
  }, [page, setSearchParams]);

  useEffect(() => {
    setSelectedIds(new Set());
    setSyncOpen(false);
  }, [page]);

  const open = (awemeId: string) => navigate(`/favorites/${awemeId}`);
  const favoriteTitle = (favorite: FavoriteVideoRecord) =>
    favorite.title || `无标题 ${favorite.awemeId}`;
  const eligibleFavorites = favorites?.items.filter(canSyncVideo) ?? [];
  const selectedFavorites = favorites?.items.filter(
    (favorite) => selectedIds.has(favorite.awemeId) && canSyncVideo(favorite),
  ) ?? [];
  const allEligibleSelected = eligibleFavorites.length > 0
    && eligibleFavorites.every((favorite) => selectedIds.has(favorite.awemeId));

  function toggleFavorite(awemeId: string, selected: boolean) {
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
      for (const favorite of eligibleFavorites) {
        if (selected) next.add(favorite.awemeId);
        else next.delete(favorite.awemeId);
      }
      return next;
    });
  }

  function requestDelete(favorite: FavoriteVideoRecord) {
    setDeleteError(null);
    setDeleteTarget(favorite);
  }

  async function confirmDelete() {
    if (!deleteTarget || !favorites) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteFavoriteVideo(deleteTarget.awemeId);
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(deleteTarget.awemeId);
        return next;
      });
      setDeleteTarget(null);
      const destinationPage = pageAfterFavoriteDeletion(page, favorites.items.length);
      if (destinationPage !== page) {
        setSearchParams({ page: String(destinationPage) });
      } else {
        const refreshed = await getFavorites(page);
        if (page > refreshed.totalPages) {
          setSearchParams({ page: String(refreshed.totalPages) }, { replace: true });
        } else {
          setFavorites(refreshed);
        }
      }
    } catch (reason) {
      setDeleteError(reason instanceof Error ? reason.message : "删除收藏作品失败");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div>
      <PageTitle
        icon={<Bookmark size={20} strokeWidth={1.5} />}
        title="我的收藏"
        description={favorites
          ? `共 ${favorites.total} 条监听到的新收藏，与人物采集数据相互独立`
          : "查看收藏监听模式生成的文章。"}
      />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-white/35">仅已生成 Markdown 的收藏文章可以同步</p>
        <button
          type="button"
          className="primary-button"
          disabled={selectedFavorites.length === 0}
          onClick={() => setSyncOpen(true)}
        >
          <CloudUpload size={16} />
          同步飞书{selectedFavorites.length > 0 ? `（${selectedFavorites.length}）` : ""}
        </button>
      </div>
      <GlassCard className="overflow-hidden">
        {error ? (
          <EmptyState title="收藏列表不可用" description={error} />
        ) : !favorites ? (
          <EmptyState title="正在读取收藏" description="稍候，收藏文章状态正在加载。" />
        ) : favorites.items.length === 0 ? (
          <EmptyState title="还没有新增收藏" description="启动收藏监听后，初始化完成之后新增的作品会显示在这里。" />
        ) : (
          <>
            <div className="hidden overflow-x-auto lg:block">
              <table className="data-table">
                <thead><tr><th className="w-14"><input type="checkbox" className="size-4 accent-[#5b9cff]" aria-label="全选当前页可同步收藏文章" checked={allEligibleSelected} disabled={eligibleFavorites.length === 0} onChange={(event) => toggleAll(event.target.checked)} /></th><th>标题</th><th className="w-36">作者</th><th className="w-44">发布时间</th><th className="w-28">状态</th><th className="w-28">飞书同步</th><th className="w-56 text-right">失败原因</th><th className="w-20 text-right">操作</th></tr></thead>
                <tbody>{favorites.items.map((favorite) => (
                  <tr
                    key={favorite.awemeId}
                    tabIndex={0}
                    role="link"
                    onClick={() => open(favorite.awemeId)}
                    onKeyDown={(event) => {
                      if (event.target === event.currentTarget && event.key === "Enter") open(favorite.awemeId);
                    }}
                  >
                    <td onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}><input type="checkbox" className="size-4 accent-[#5b9cff]" aria-label={`选择收藏文章 ${favoriteTitle(favorite)}`} title={canSyncVideo(favorite) ? "选择同步" : "文章尚未生成，不能同步"} checked={selectedIds.has(favorite.awemeId)} disabled={!canSyncVideo(favorite)} onChange={(event) => toggleFavorite(favorite.awemeId, event.target.checked)} /></td>
                    <td className="max-w-0"><p className="truncate font-medium text-white/85">{favoriteTitle(favorite)}</p><p className="mt-1 font-mono text-xs text-white/25">{favorite.awemeId}</p></td>
                    <td className="max-w-36 truncate text-sm text-white/50">{favorite.author || "未知"}</td>
                    <td className="font-mono text-xs text-white/40">{formatDate(favorite.publishedAt)}</td>
                    <td><StatusBadge status={favorite.status} /></td>
                    <td><FeishuSyncBadge synced={favorite.feishuSynced} /></td>
                    <td className="break-words text-right text-xs leading-5 text-red-200/65">{favorite.failureReason ?? ""}</td>
                    <td className="text-right"><button type="button" className="focus-ring inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-red-300/70 transition-colors hover:bg-red-500/12 hover:text-red-200" aria-label={`删除收藏 ${favoriteTitle(favorite)}`} onClick={(event) => { event.stopPropagation(); requestDelete(favorite); }}><Trash2 size={16} /></button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="grid gap-3 p-4 lg:hidden">{favorites.items.map((favorite) => (
              <div key={favorite.awemeId} className="overflow-hidden rounded-2xl border border-white/8 bg-white/3">
                <div className="flex items-start">
                  <label className="grid min-h-14 w-12 shrink-0 place-items-center pl-2 pt-2" title={canSyncVideo(favorite) ? "选择同步" : "文章尚未生成，不能同步"}><input type="checkbox" className="size-4 accent-[#5b9cff]" aria-label={`选择收藏文章 ${favoriteTitle(favorite)}`} checked={selectedIds.has(favorite.awemeId)} disabled={!canSyncVideo(favorite)} onChange={(event) => toggleFavorite(favorite.awemeId, event.target.checked)} /></label>
                  <button type="button" className="focus-ring min-w-0 flex-1 p-4 pl-2 text-left" onClick={() => open(favorite.awemeId)}>
                    <div className="flex items-start justify-between gap-4"><h2 className="line-clamp-2 text-sm font-semibold leading-6">{favoriteTitle(favorite)}</h2><div className="flex shrink-0 flex-col items-end gap-1.5"><StatusBadge status={favorite.status} /><FeishuSyncBadge synced={favorite.feishuSynced} /></div></div>
                    <p className="mt-3 text-xs text-white/40">{favorite.author || "作者未知"} · <span className="font-mono">{formatDate(favorite.publishedAt)}</span></p>
                    <p className="mt-2 break-all font-mono text-[11px] text-white/25">{favorite.awemeId}</p>
                    {favorite.failureReason && <p className="mt-3 break-words text-xs leading-5 text-red-200/65">{favorite.failureReason}</p>}
                  </button>
                </div>
                <div className="flex justify-end border-t border-white/6 px-3 py-2"><button type="button" className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-xs font-medium text-red-300/75 hover:bg-red-500/12 hover:text-red-200" aria-label={`删除收藏 ${favoriteTitle(favorite)}`} onClick={() => requestDelete(favorite)}><Trash2 size={15} />删除收藏</button></div>
              </div>
            ))}</div>
          </>
        )}
      </GlassCard>
      {favorites && favorites.totalPages > 1 && (
        <div className="mt-5 flex items-center justify-center gap-3">
          <button className="pagination-button" disabled={page <= 1} onClick={() => setSearchParams({ page: String(page - 1) })}><ChevronLeft size={15} />上一页</button>
          <span className="font-mono text-xs text-white/40">第 {page}/{favorites.totalPages} 页</span>
          <button className="pagination-button" disabled={page >= favorites.totalPages} onClick={() => setSearchParams({ page: String(page + 1) })}>下一页<ChevronRight size={15} /></button>
        </div>
      )}
      <DeleteConfirmationDialog
        open={Boolean(deleteTarget)}
        title="删除收藏？"
        subject={deleteTarget ? favoriteTitle(deleteTarget) : ""}
        description="此操作不可撤销，将删除本地收藏记录、Markdown、残留媒体文件和飞书同步记录，但不会取消抖音收藏或删除飞书远端文档。以后重新收藏时可以再次采集。"
        loading={deleting}
        error={deleteError}
        onCancel={() => { if (!deleting) setDeleteTarget(null); }}
        onConfirm={() => void confirmDelete()}
      />
      <FeishuSyncDialog
        open={syncOpen}
        source="favorite"
        articles={selectedFavorites}
        onCancel={() => setSyncOpen(false)}
        onComplete={(result) => {
          const failed = new Set(
            result.items
              .filter((item) => item.status === "failed")
              .map((item) => item.awemeId),
          );
          setSelectedIds(failed);
          void getFavorites(page)
            .then(setFavorites)
            .catch((reason) => setError(reason instanceof Error ? reason.message : "刷新收藏列表失败"));
        }}
      />
    </div>
  );
}

export function pageAfterFavoriteDeletion(page: number, itemsOnPage: number): number {
  return itemsOnPage === 1 && page > 1 ? page - 1 : page;
}
