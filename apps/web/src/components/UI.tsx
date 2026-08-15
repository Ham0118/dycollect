import { useEffect, useId, useRef, type ReactNode } from "react";
import { AlertTriangle, LoaderCircle, Trash2 } from "lucide-react";
import type { JobStatus, VideoStatus } from "@dycollect/shared";

const statusMap: Record<JobStatus | VideoStatus, { label: string; classes: string }> = {
  queued: { label: "排队中", classes: "bg-white/8 text-white/55" },
  running: { label: "运行中", classes: "bg-emerald-400/15 text-emerald-300" },
  waiting_verification: { label: "等待验证", classes: "bg-amber-400/15 text-amber-300" },
  completed: { label: "已完成", classes: "bg-emerald-400/15 text-emerald-300" },
  completed_partial: { label: "部分完成", classes: "bg-amber-400/15 text-amber-300" },
  cancelled: { label: "已取消", classes: "bg-white/8 text-white/45" },
  failed: { label: "失败", classes: "bg-red-500/15 text-red-300" },
  discovered: { label: "已发现", classes: "bg-blue-500/15 text-blue-300" },
  downloading: { label: "下载中", classes: "bg-blue-500/15 text-blue-300" },
  downloaded: { label: "待转录", classes: "bg-violet-500/15 text-violet-300" },
  transcribing: { label: "转录中", classes: "bg-violet-500/15 text-violet-300" },
};

export function StatusBadge({ status }: { status: JobStatus | VideoStatus }) {
  const item = statusMap[status];
  return <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium ${item.classes}`}><span className="size-1.5 rounded-full bg-current shadow-[0_0_8px_currentColor]" />{item.label}</span>;
}

export function FeishuSyncBadge({ synced }: { synced: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium ${synced ? "bg-emerald-400/15 text-emerald-300" : "bg-white/8 text-white/45"}`}>
      <span className="size-1.5 rounded-full bg-current" />
      {synced ? "已同步" : "未同步"}
    </span>
  );
}

export function PageTitle({ icon, title, description }: { icon: ReactNode; title: string; description?: string }) {
  return (
    <div className="mb-7 flex items-start gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-blue-500/20 text-[#5b9cff]">{icon}</span>
      <div><h1 className="text-[26px] font-semibold leading-tight tracking-tight">{title}</h1>{description && <p className="mt-2 text-sm text-white/40">{description}</p>}</div>
    </div>
  );
}

export function GlassCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`glass-card ${className}`}>{children}</section>;
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="grid min-h-44 place-items-center px-6 py-10 text-center"><div><p className="font-semibold text-white/80">{title}</p><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-white/40">{description}</p>{action && <div className="mt-5">{action}</div>}</div></div>;
}

export function DeleteConfirmationDialog({
  open,
  title,
  description,
  subject,
  loading,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  subject: string;
  loading: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

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

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-[28px] border border-white/12 bg-[#100d21]/96 p-0 text-white shadow-[0_24px_80px_rgba(0,0,0,.6)] backdrop:bg-[#03020b]/80 backdrop:backdrop-blur-sm"
      onCancel={(event) => {
        event.preventDefault();
        if (!loading) onCancel();
      }}
    >
      <div className="p-5 sm:p-6">
        <div className="flex items-start gap-4">
          <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-red-500/15 text-red-300">
            <AlertTriangle size={21} strokeWidth={1.5} />
          </span>
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
            <p className="mt-1 break-words text-sm font-medium text-white/75">{subject}</p>
            <p id={descriptionId} className="mt-3 text-sm leading-6 text-white/45">{description}</p>
          </div>
        </div>
        {error && <p role="alert" className="mt-5 rounded-2xl border border-red-400/15 bg-red-500/8 px-4 py-3 text-sm leading-5 text-red-200">{error}</p>}
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <button ref={cancelRef} type="button" className="ghost-button w-full" disabled={loading} onClick={onCancel}>取消</button>
          <button type="button" className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-red-400/20 bg-red-500/15 px-4 text-sm font-semibold text-red-200 transition-colors hover:bg-red-500/22 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-300 disabled:cursor-not-allowed disabled:opacity-40" disabled={loading} onClick={onConfirm}>
            {loading ? <LoaderCircle className="animate-spin" size={16} /> : <Trash2 size={16} />}
            {loading ? "正在删除" : "永久删除"}
          </button>
        </div>
      </div>
    </dialog>
  );
}

export function formatDate(value: string | null): string {
  if (!value) return "未知";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
