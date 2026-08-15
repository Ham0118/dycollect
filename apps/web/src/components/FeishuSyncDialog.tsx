import { useEffect, useId, useRef, useState } from "react";
import { CheckCircle2, CloudUpload, ExternalLink, LoaderCircle, XCircle } from "lucide-react";
import { Link } from "react-router-dom";
import type {
  FeishuSpace,
  FeishuSyncResult,
  FeishuSyncSource,
  VideoRecord,
} from "@dycollect/shared";
import { ApiRequestError, getFeishuSpaces, syncFeishuArticles } from "../api";

type FeishuArticleSummary = Pick<VideoRecord, "awemeId" | "title">;
type FeishuSyncableRecord = Pick<VideoRecord, "status" | "markdownPath">;
type FeishuSyncableDetail = FeishuSyncableRecord & { articleAvailable: boolean };

export function canSyncVideo(video: FeishuSyncableRecord): boolean {
  return video.status === "completed" && Boolean(video.markdownPath);
}

export function canSyncArticleDetail(article: FeishuSyncableDetail): boolean {
  return canSyncVideo(article) && article.articleAvailable;
}

export function articleSyncUnavailableReason(article: FeishuSyncableDetail): string | null {
  if (article.status !== "completed" || !article.markdownPath) {
    return "文章尚未生成，暂时无法同步飞书。";
  }
  if (!article.articleAvailable) {
    return "Markdown 文件不可用，暂时无法同步飞书。";
  }
  return null;
}

export function FeishuSyncDialog({
  open,
  source,
  articles,
  onCancel,
  onComplete,
}: {
  open: boolean;
  source: FeishuSyncSource;
  articles: FeishuArticleSummary[];
  onCancel: () => void;
  onComplete: (result: FeishuSyncResult) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [spaces, setSpaces] = useState<FeishuSpace[] | null>(null);
  const [spaceId, setSpaceId] = useState("");
  const [loadingSpaces, setLoadingSpaces] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsSettings, setNeedsSettings] = useState(false);
  const [result, setResult] = useState<FeishuSyncResult | null>(null);
  const articleCount = result?.total ?? articles.length;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      cancelRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setSpaces(null);
    setSpaceId("");
    setError(null);
    setNeedsSettings(false);
    setResult(null);
    setLoadingSpaces(true);
    void getFeishuSpaces()
      .then((value) => {
        if (!active) return;
        setSpaces(value);
        if (value.length === 1) setSpaceId(value[0].spaceId);
      })
      .catch((reason) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "读取飞书知识库失败");
        setNeedsSettings(reason instanceof ApiRequestError && reason.code === "feishu_not_configured");
      })
      .finally(() => { if (active) setLoadingSpaces(false); });
    return () => { active = false; };
  }, [open]);

  async function confirm() {
    if (!spaceId || articles.length === 0) return;
    setSyncing(true);
    setError(null);
    try {
      const value = await syncFeishuArticles({
        source,
        spaceId,
        awemeIds: articles.map((article) => article.awemeId),
      });
      setResult(value);
      onComplete(value);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "同步飞书失败");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="m-auto max-h-[min(760px,calc(100vh-2rem))] w-[calc(100%-2rem)] max-w-xl overflow-hidden rounded-[28px] border border-white/12 bg-[#100d21]/98 p-0 text-white shadow-[0_24px_80px_rgba(0,0,0,.6)] backdrop:bg-[#03020b]/80 backdrop:backdrop-blur-sm"
      onCancel={(event) => {
        event.preventDefault();
        if (!syncing) onCancel();
      }}
    >
      <div className="flex max-h-[min(760px,calc(100vh-2rem))] flex-col">
        <div className="flex items-start gap-4 border-b border-white/8 p-5 sm:p-6">
          <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-blue-500/15 text-blue-300"><CloudUpload size={21} strokeWidth={1.5} /></span>
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold">同步到飞书知识库</h2>
            <p id={descriptionId} className="mt-1 text-sm leading-6 text-white/42">已选择 {articleCount} 篇文章。请选择目标知识库后开始同步。</p>
          </div>
        </div>

        <div className="min-h-48 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-5 sm:p-6">
          {result ? <SyncResultView result={result} /> : loadingSpaces ? (
            <div className="grid min-h-44 place-items-center text-sm text-white/45"><span className="flex items-center gap-2"><LoaderCircle className="animate-spin" size={17} />正在读取知识库</span></div>
          ) : error && !spaces ? (
            <div className="grid min-h-44 place-items-center text-center">
              <div><p className="font-medium text-red-200">无法读取知识库</p><p role="alert" className="mt-2 max-w-sm text-sm leading-6 text-white/42">{error}</p>{needsSettings && <Link className="primary-button mt-5" to="/settings"><ExternalLink size={15} />前往设置</Link>}</div>
            </div>
          ) : spaces?.length === 0 ? (
            <div className="grid min-h-44 place-items-center text-center"><div><p className="font-medium text-white/80">没有可用的知识库</p><p className="mt-2 text-sm leading-6 text-white/42">请确认应用已经开通知识库权限，并被添加到目标知识库。</p></div></div>
          ) : (
            <fieldset className="min-w-0" disabled={syncing}>
              <legend className="mb-3 text-xs font-medium text-white/45">目标知识库</legend>
              <div className="grid gap-2">
                {spaces?.map((space) => (
                  <label key={space.spaceId} className={`focus-within:ring-2 focus-within:ring-blue-400/70 flex cursor-pointer items-start gap-3 rounded-2xl border px-4 py-3 transition ${spaceId === space.spaceId ? "border-blue-400/35 bg-blue-500/12" : "border-white/8 bg-white/3 hover:bg-white/6"}`}>
                    <input className="mt-1 size-4 accent-[#5b9cff]" type="radio" name="feishu-space" value={space.spaceId} checked={spaceId === space.spaceId} onChange={() => setSpaceId(space.spaceId)} />
                    <span className="min-w-0 flex-1"><span className="block break-words text-sm font-medium text-white/85 [overflow-wrap:anywhere]">{space.name}</span>{space.description && <span className="mt-1 block line-clamp-2 break-words text-xs leading-5 text-white/38 [overflow-wrap:anywhere]">{space.description}</span>}</span>
                  </label>
                ))}
              </div>
              {error && <p role="alert" className="mt-4 rounded-2xl border border-red-400/15 bg-red-500/8 px-4 py-3 text-sm text-red-200">{error}</p>}
            </fieldset>
          )}
        </div>

        <div className="grid gap-3 border-t border-white/8 p-5 sm:grid-cols-2 sm:p-6">
          {result ? (
            <button ref={cancelRef} type="button" className="ghost-button sm:col-span-2" onClick={onCancel}>关闭</button>
          ) : <>
            <button ref={cancelRef} type="button" className="ghost-button w-full" disabled={syncing} onClick={onCancel}>取消</button>
            <button type="button" className="primary-button w-full" disabled={syncing || loadingSpaces || !spaceId || articles.length === 0} onClick={() => void confirm()}>
              {syncing ? <LoaderCircle className="animate-spin" size={16} /> : <CloudUpload size={16} />}
              {syncing ? `正在同步 ${articles.length} 篇` : "确认同步"}
            </button>
          </>}
        </div>
      </div>
    </dialog>
  );
}

function SyncResultView({ result }: { result: FeishuSyncResult }) {
  return (
    <div className="min-w-0">
      <div className="grid grid-cols-3 gap-2 text-center">
        <ResultCount label="成功" value={result.synced} classes="text-emerald-300" />
        <ResultCount label="跳过" value={result.skipped} classes="text-blue-300" />
        <ResultCount label="失败" value={result.failed} classes="text-red-300" />
      </div>
      <div className="mt-5 grid gap-2">
        {result.items.map((item) => (
          <div key={item.awemeId} className="flex min-w-0 max-w-full items-start gap-3 rounded-2xl border border-white/7 bg-white/3 px-4 py-3">
            {item.status === "failed" ? <XCircle className="mt-0.5 shrink-0 text-red-300" size={16} /> : <CheckCircle2 className={`mt-0.5 shrink-0 ${item.status === "skipped" ? "text-blue-300" : "text-emerald-300"}`} size={16} />}
            <div className="min-w-0 flex-1"><p className="break-words text-sm leading-6 text-white/78 [overflow-wrap:anywhere]">{item.title}</p><p className="mt-1 break-words text-xs leading-5 text-white/38 [overflow-wrap:anywhere]">{item.message}</p></div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ResultCount({ label, value, classes }: { label: string; value: number; classes: string }) {
  return <div className="rounded-2xl border border-white/7 bg-white/3 p-3"><p className={`font-mono text-xl font-semibold ${classes}`}>{value}</p><p className="mt-1 text-[11px] text-white/38">{label}</p></div>;
}
