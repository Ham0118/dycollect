import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Bookmark, Boxes, ListTodo, LoaderCircle, Menu, RefreshCw, Settings2, Users, X } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import type { ModelAvailability } from "@dycollect/shared";
import { useModelStatus } from "../model-status";

const navigation = [
  { to: "/", label: "任务面板", icon: Boxes, end: true },
  { to: "/jobs", label: "任务列表", icon: ListTodo, end: false },
  { to: "/creators", label: "人物列表", icon: Users, end: false },
  { to: "/favorites", label: "我的收藏", icon: Bookmark, end: false },
  { to: "/settings", label: "设置", icon: Settings2, end: false },
];

export function AppShell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [modelDialogOpen, setModelDialogOpen] = useState(true);
  const { status, checking, error, unavailable, refresh } = useModelStatus();
  useEffect(() => {
    if (!unavailable) setModelDialogOpen(true);
  }, [unavailable]);
  return (
    <div className="min-h-screen bg-canvas text-white">
      <header className="sticky top-0 z-40 flex h-16 items-center justify-between border-b border-white/8 bg-[#0a0820]/85 px-4 backdrop-blur-2xl md:hidden">
        <Brand />
        <button className="focus-ring grid size-11 place-items-center rounded-2xl border border-white/10 bg-white/6" onClick={() => setMenuOpen((open) => !open)} aria-label={menuOpen ? "关闭导航" : "打开导航"}>
          {menuOpen ? <X size={21} strokeWidth={1.5} /> : <Menu size={21} strokeWidth={1.5} />}
        </button>
      </header>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-20 border-r border-black/10 bg-white/6 px-3 py-7 backdrop-blur-3xl md:flex md:flex-col xl:w-64 xl:px-6">
        <Brand />
        <nav className="mt-10 flex flex-col gap-2" aria-label="主导航">
          {navigation.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} title={label} className={({ isActive }) => `focus-ring flex h-11 items-center justify-center gap-3 rounded-[14px] px-3 text-sm transition xl:justify-start ${isActive ? "bg-blue-500/25 font-semibold text-[#5b9cff]" : "text-white/50 hover:bg-white/5 hover:text-white/80"}`}>
              <Icon size={20} strokeWidth={1.5} aria-hidden="true" />
              <span className="hidden xl:inline">{label}</span>
            </NavLink>
          ))}
        </nav>
        <p className="mt-auto hidden text-xs leading-5 text-white/25 xl:block">本地运行 · 数据仅保存在当前主机</p>
      </aside>

      {menuOpen && (
        <div className="fixed inset-x-3 top-19 z-50 rounded-3xl border border-white/10 bg-[#12102d]/95 p-3 shadow-2xl backdrop-blur-3xl md:hidden">
          {navigation.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} onClick={() => setMenuOpen(false)} className={({ isActive }) => `focus-ring flex min-h-12 items-center gap-3 rounded-2xl px-4 text-sm ${isActive ? "bg-blue-500/25 font-semibold text-[#5b9cff]" : "text-white/60"}`}>
              <Icon size={20} strokeWidth={1.5} />{label}
            </NavLink>
          ))}
        </div>
      )}

      <main className="min-h-screen px-4 py-6 md:ml-20 md:px-7 md:py-8 xl:ml-64 xl:px-10">
        <div className="mx-auto w-full max-w-[1440px]">
          {unavailable && (
            <div role="status" className="mb-5 flex flex-col gap-3 rounded-2xl border border-amber-400/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100/85 sm:flex-row sm:items-center sm:justify-between">
              <span className="flex items-center gap-2"><AlertTriangle size={17} />Qwen3-ASR 模型不可用，新的处理任务已暂停。</span>
              <button type="button" className="ghost-button shrink-0" onClick={() => setModelDialogOpen(true)}>查看初始化说明</button>
            </div>
          )}
          {error && !status && <p className="mb-5 text-sm text-amber-200/80">模型状态检查失败：{error}</p>}
          <Outlet />
        </div>
      </main>
      <ModelSetupDialog
        open={unavailable && modelDialogOpen}
        status={status}
        checking={checking}
        onRefresh={() => void refresh()}
        onClose={() => setModelDialogOpen(false)}
      />
    </div>
  );
}

export function ModelSetupDialog({
  open,
  status,
  checking,
  onRefresh,
  onClose,
}: {
  open: boolean;
  status: ModelAvailability | null;
  checking: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      closeRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);
  const incomplete = status?.state === "incomplete";
  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-[28px] border border-white/12 bg-[#100d21]/98 p-0 text-white shadow-[0_24px_80px_rgba(0,0,0,.6)] backdrop:bg-[#03020b]/80 backdrop:backdrop-blur-sm"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
    >
      <div className="p-5 sm:p-6">
        <div className="flex items-start gap-4">
          <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-amber-500/15 text-amber-200"><AlertTriangle size={21} /></span>
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold">{incomplete ? "Qwen3-ASR 模型文件不完整" : "未检测到 Qwen3-ASR 模型"}</h2>
            <p id={descriptionId} className="mt-2 text-sm leading-6 text-white/50">模型不会提交到代码仓库。请在运行 DyCollect 的主机上打开终端，进入项目根目录后执行 README 中的初始化命令：</p>
          </div>
        </div>
        <pre className="mt-5 overflow-x-auto rounded-2xl border border-white/8 bg-black/25 px-4 py-3 font-mono text-sm text-blue-200"><code>{status?.setupCommand ?? "npm run setup:model"}</code></pre>
        {status?.missingFiles.length ? <p className="mt-3 break-words text-xs leading-5 text-white/35">缺失或异常文件：{status.missingFiles.join("、")}</p> : null}
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <button ref={closeRef} type="button" className="ghost-button w-full" onClick={onClose}>稍后处理</button>
          <button type="button" className="primary-button w-full" disabled={checking} onClick={onRefresh}>{checking ? <LoaderCircle className="animate-spin" size={16} /> : <RefreshCw size={16} />}{checking ? "正在检测" : "重新检测"}</button>
        </div>
      </div>
    </dialog>
  );
}

function Brand() {
  return (
    <div className="flex items-center justify-center gap-3 xl:justify-start">
      <span className="grid size-9 place-items-center rounded-xl bg-blue-600 shadow-[0_4px_16px_rgba(77,128,230,.3)]">
        <span className="size-3 rounded-[4px] border-2 border-white" />
      </span>
      <span className="text-lg font-semibold tracking-tight md:hidden xl:inline">听录机</span>
    </div>
  );
}
