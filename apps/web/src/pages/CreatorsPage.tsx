import { useEffect, useState } from "react";
import { ArrowUpRight, Trash2, Users } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import type { Creator } from "@dycollect/shared";
import { deleteCreator, getCreators } from "../api";
import { DeleteConfirmationDialog, EmptyState, GlassCard, PageTitle, formatDate } from "../components/UI";

export function CreatorsPage() {
  const [creators, setCreators] = useState<Creator[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Creator | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    void getCreators()
      .then(setCreators)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "读取失败"))
      .finally(() => setLoading(false));
  }, []);

  const open = (secUid: string) => navigate(`/creators/${encodeURIComponent(secUid)}`);
  const creatorName = (creator: Creator) => creator.nickname || `用户 ${creator.secUid.slice(-8)}`;

  function requestDelete(creator: Creator) {
    setDeleteError(null);
    setDeleteTarget(creator);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteCreator(deleteTarget.secUid);
      setCreators((current) => current.filter((creator) => creator.secUid !== deleteTarget.secUid));
      setDeleteTarget(null);
    } catch (reason) {
      setDeleteError(reason instanceof Error ? reason.message : "删除人物失败");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div>
      <PageTitle icon={<Users size={20} strokeWidth={1.5} />} title="人物列表" description="查看已经采集的人物与文章完成情况。" />
      <GlassCard className="overflow-hidden">
        {loading ? <EmptyState title="正在读取人物" description="稍候，人物资料正在加载。" /> : error ? <EmptyState title="人物列表不可用" description={error} /> : creators.length === 0 ? <EmptyState title="还没有采集人物" description="返回任务面板提交第一个抖音人物主页，采集结果会出现在这里。" action={<Link className="primary-button inline-flex" to="/">创建任务</Link>} /> : <>
          <div className="hidden overflow-x-auto lg:block">
            <table className="data-table">
              <thead><tr><th>昵称</th><th>主页链接</th><th className="text-center">作品总数</th><th className="text-center">已完成</th><th className="text-right">最近采集</th><th className="w-20 text-right">操作</th></tr></thead>
              <tbody>{creators.map((creator) => <tr key={creator.secUid} tabIndex={0} role="link" onClick={() => open(creator.secUid)} onKeyDown={(event) => { if (event.target === event.currentTarget && event.key === "Enter") open(creator.secUid); }}>
                <td className="font-semibold text-white">{creatorName(creator)}</td>
                <td><span className="inline-flex max-w-[420px] items-center gap-1 truncate text-blue-300">{creator.profileUrl.replace("https://www.", "")}<ArrowUpRight className="shrink-0" size={13} /></span></td>
                <td className="text-center font-mono text-white/75">{creator.displayedPostCount ?? "—"}</td>
                <td className="text-center font-mono text-emerald-300">{creator.completedCount}</td>
                <td className="text-right font-mono text-xs text-white/40">{formatDate(creator.lastCrawledAt)}</td>
                <td className="text-right"><button type="button" className="focus-ring inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-red-300/70 transition-colors hover:bg-red-500/12 hover:text-red-200" aria-label={`删除人物 ${creatorName(creator)}`} onClick={(event) => { event.stopPropagation(); requestDelete(creator); }}><Trash2 size={16} /></button></td>
              </tr>)}</tbody>
            </table>
          </div>
          <div className="grid gap-3 p-4 lg:hidden">{creators.map((creator) => <div key={creator.secUid} className="overflow-hidden rounded-2xl border border-white/8 bg-white/3">
            <button type="button" className="focus-ring block w-full p-4 text-left" onClick={() => open(creator.secUid)}>
              <div className="flex items-start justify-between gap-3"><h2 className="font-semibold">{creatorName(creator)}</h2><ArrowUpRight className="text-blue-300" size={17} /></div>
              <p className="mt-2 truncate text-xs text-blue-300">{creator.profileUrl.replace("https://www.", "")}</p>
              <div className="mt-4 grid grid-cols-3 gap-2 text-xs"><Mini label="作品" value={creator.displayedPostCount ?? "—"} /><Mini label="已完成" value={creator.completedCount} tone="text-emerald-300" /><Mini label="最近采集" value={formatDate(creator.lastCrawledAt)} /></div>
            </button>
            <div className="flex justify-end border-t border-white/6 px-3 py-2"><button type="button" className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-xs font-medium text-red-300/75 hover:bg-red-500/12 hover:text-red-200" aria-label={`删除人物 ${creatorName(creator)}`} onClick={() => requestDelete(creator)}><Trash2 size={15} />删除人物</button></div>
          </div>)}</div>
        </>}
      </GlassCard>
      <DeleteConfirmationDialog
        open={Boolean(deleteTarget)}
        title="删除人物？"
        subject={deleteTarget ? creatorName(deleteTarget) : ""}
        description="此操作不可撤销，将删除该人物、全部作品、Markdown 和失败后保留的视频文件。历史任务记录会继续保留。"
        loading={deleting}
        error={deleteError}
        onCancel={() => { if (!deleting) setDeleteTarget(null); }}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}

function Mini({ label, value, tone = "text-white/65" }: { label: string; value: string | number; tone?: string }) {
  return <div><p className="text-[11px] text-white/30">{label}</p><p className={`mt-1 font-mono ${tone}`}>{value}</p></div>;
}
