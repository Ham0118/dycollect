import { useEffect, useMemo, useState } from "react";
import DOMPurify from "dompurify";
import { ArrowLeft, ArrowUpRight, CloudUpload, FileText } from "lucide-react";
import { marked } from "marked";
import { Link, useParams } from "react-router-dom";
import type { ArticleDetail } from "@dycollect/shared";
import { getArticle } from "../api";
import {
  articleSyncUnavailableReason,
  canSyncArticleDetail,
  FeishuSyncDialog,
} from "../components/FeishuSyncDialog";
import { EmptyState, GlassCard, StatusBadge, formatDate } from "../components/UI";

export function ArticlePage() {
  const { awemeId = "" } = useParams();
  const [article, setArticle] = useState<ArticleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  useEffect(() => {
    let active = true;
    setArticle(null);
    setError(null);
    setSyncOpen(false);
    void getArticle(awemeId)
      .then((value) => { if (active) setArticle(value); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "读取失败"); });
    return () => { active = false; };
  }, [awemeId]);
  const html = useMemo(() => {
    if (!article?.markdown) return "";
    return DOMPurify.sanitize(marked.parse(article.markdown, { async: false }) as string, { USE_PROFILES: { html: true } });
  }, [article?.markdown]);
  if (error) return <GlassCard><EmptyState title="文章不可用" description={error} /></GlassCard>;
  if (!article) return <GlassCard><EmptyState title="正在读取文章" description="稍候，文章信息正在加载。" /></GlassCard>;
  return <ArticleDetailView article={article} html={html} syncOpen={syncOpen} onSyncOpenChange={setSyncOpen} />;
}

export function ArticleDetailView({
  article,
  html,
  syncOpen,
  onSyncOpenChange,
}: {
  article: ArticleDetail;
  html: string;
  syncOpen: boolean;
  onSyncOpenChange: (open: boolean) => void;
}) {
  const syncUnavailableReason = articleSyncUnavailableReason(article);
  const syncable = canSyncArticleDetail(article);
  return (
    <div className="mx-auto max-w-6xl">
      <nav className="mb-5 flex flex-wrap items-center gap-2 text-xs text-white/35"><Link className="hover:text-blue-300" to="/creators">人物列表</Link><span>/</span><Link className="hover:text-blue-300" to={`/creators/${encodeURIComponent(article.secUid)}`}>{article.author || "人物作品"}</Link><span>/</span><span className="text-white/65">文章详情</span></nav>
      <GlassCard className="p-5 md:p-8">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <Link className="focus-ring inline-flex min-h-11 items-center gap-2 rounded-2xl px-3 text-sm text-white/45 hover:bg-white/5 hover:text-white" to={`/creators/${encodeURIComponent(article.secUid)}`}><ArrowLeft size={16} />返回作品列表</Link>
          <div className="flex w-full flex-col items-stretch gap-1.5 sm:w-auto sm:items-end">
            <button
              type="button"
              className="primary-button w-full sm:w-auto"
              data-article-feishu-sync="true"
              disabled={!syncable}
              aria-label={syncUnavailableReason ?? "同步当前文章到飞书知识库"}
              onClick={() => onSyncOpenChange(true)}
            >
              <CloudUpload size={16} />
              同步飞书
            </button>
            {syncUnavailableReason && <p className="text-xs leading-5 text-white/38">{syncUnavailableReason}</p>}
          </div>
        </div>
        <div className="flex items-start gap-3"><span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-blue-500/20 text-blue-300"><FileText size={19} strokeWidth={1.5} /></span><h1 className="text-2xl font-semibold leading-tight tracking-tight md:text-[28px]">{article.title || `无标题 ${article.awemeId}`}</h1></div>
        <dl className="mt-7 grid gap-x-10 gap-y-4 border-b border-white/8 pb-7 text-sm md:grid-cols-2"><Meta label="作者" value={article.author || "未知"} /><Meta label="发布时间" value={formatDate(article.publishedAt)} mono /><div className="grid grid-cols-[80px_1fr] items-start gap-3"><dt className="text-white/35">原视频</dt><dd><a className="inline-flex items-center gap-1 break-all text-blue-300 hover:text-blue-200" href={article.sourceUrl} target="_blank" rel="noopener noreferrer">打开抖音作品<ArrowUpRight size={14} /></a></dd></div><div className="grid grid-cols-[80px_1fr] items-start gap-3"><dt className="text-white/35">当前状态</dt><dd><StatusBadge status={article.status} /></dd></div></dl>
        {article.status === "completed" ? article.articleAvailable && html ? <article className="markdown-body mx-auto mt-8 max-w-[820px]" dangerouslySetInnerHTML={{ __html: html }} /> : <EmptyState title="文章文件不可用" description="数据库记录已完成，但磁盘上的 Markdown 文件不存在或无法读取。" /> : <EmptyState title={article.status === "failed" ? "这条作品处理失败" : "文章尚未生成"} description={article.failureReason ?? "转录完成后，正文会显示在这里。"} />}
      </GlassCard>
      <FeishuSyncDialog
        open={syncOpen}
        source="creator"
        articles={[article]}
        onCancel={() => onSyncOpenChange(false)}
        onComplete={() => undefined}
      />
    </div>
  );
}

function Meta({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div className="grid grid-cols-[80px_1fr] items-start gap-3"><dt className="text-white/35">{label}</dt><dd className={mono ? "font-mono text-xs text-white/75" : "text-white/75"}>{value}</dd></div>; }
