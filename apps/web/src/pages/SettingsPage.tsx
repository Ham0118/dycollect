import { useEffect, useState, type FormEvent } from "react";
import {
  CheckCircle2,
  CloudUpload,
  Cpu,
  Database,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Save,
  ScrollText,
  Settings2,
  Trash2,
} from "lucide-react";
import type { AsrDevice, AsrSettingsView, FeishuSettingsView, FeishuSpace } from "@dycollect/shared";
import {
  clearJobLogs,
  clearTerminalJobs,
  getFeishuSettings,
  getFeishuSpaces,
  getAsrSettings,
  saveFavoriteFeishuAutoSyncSettings,
  saveFeishuSettings,
  saveAsrSettings,
} from "../api";
import { DeleteConfirmationDialog, EmptyState, GlassCard, PageTitle } from "../components/UI";

export type MaintenanceCleanupTarget = "logs" | "jobs";

const cleanupDialogContent: Record<MaintenanceCleanupTarget, {
  title: string;
  subject: string;
  description: string;
}> = {
  logs: {
    title: "清除所有任务日志？",
    subject: "全部任务日志",
    description: "此操作不可撤销，只会删除 job_logs 中的日志。任务记录和任务处理明细仍会保留。",
  },
  jobs: {
    title: "清除最近任务？",
    subject: "全部终态任务",
    description: "此操作不可撤销，将删除全部已完成、部分完成、已取消和失败的任务，并级联删除对应日志与处理明细。人物、作品、Markdown 和飞书同步记录不会被删除。",
  },
};

export function SettingsPage() {
  const [settings, setSettings] = useState<FeishuSettingsView | null>(null);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [spaces, setSpaces] = useState<FeishuSpace[] | null>(null);
  const [spacesLoading, setSpacesLoading] = useState(false);
  const [spacesError, setSpacesError] = useState<string | null>(null);
  const [favoriteAutoSyncEnabled, setFavoriteAutoSyncEnabled] = useState(false);
  const [favoriteSpaceId, setFavoriteSpaceId] = useState("");
  const [favoriteSaving, setFavoriteSaving] = useState(false);
  const [favoriteSaved, setFavoriteSaved] = useState(false);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);
  const [cleanupTarget, setCleanupTarget] = useState<MaintenanceCleanupTarget | null>(null);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [cleanupStatus, setCleanupStatus] = useState<string | null>(null);
  const [asrSettings, setAsrSettings] = useState<AsrSettingsView | null>(null);
  const [asrDevice, setAsrDevice] = useState<AsrDevice>("auto");
  const [asrLoading, setAsrLoading] = useState(true);
  const [asrSaving, setAsrSaving] = useState(false);
  const [asrSaved, setAsrSaved] = useState(false);
  const [asrError, setAsrError] = useState<string | null>(null);

  useEffect(() => {
    void getFeishuSettings()
      .then((value) => {
        setSettings(value);
        setAppId(value.appId);
        setFavoriteAutoSyncEnabled(value.favoriteAutoSync.enabled);
        setFavoriteSpaceId(value.favoriteAutoSync.spaceId ?? "");
        if (value.appSecretConfigured) void loadFeishuSpaces();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "读取飞书设置失败"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void getAsrSettings()
      .then((value) => {
        setAsrSettings(value);
        setAsrDevice(value.selectedDevice);
      })
      .catch((reason) => setAsrError(reason instanceof Error ? reason.message : "读取转录设备失败"))
      .finally(() => setAsrLoading(false));
  }, []);

  async function loadFeishuSpaces() {
    setSpacesLoading(true);
    setSpacesError(null);
    try {
      setSpaces(await getFeishuSpaces());
    } catch (reason) {
      setSpaces(null);
      setSpacesError(reason instanceof Error ? reason.message : "读取飞书知识库失败");
    } finally {
      setSpacesLoading(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const value = await saveFeishuSettings({
        appId,
        ...(appSecret.trim() ? { appSecret } : {}),
      });
      setSettings(value);
      setAppId(value.appId);
      setAppSecret("");
      setSaved(true);
      setFavoriteAutoSyncEnabled(value.favoriteAutoSync.enabled);
      setFavoriteSpaceId(value.favoriteAutoSync.spaceId ?? "");
      void loadFeishuSpaces();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存飞书设置失败");
    } finally {
      setSaving(false);
    }
  }

  async function saveFavoriteAutoSync(event: FormEvent) {
    event.preventDefault();
    setFavoriteSaving(true);
    setFavoriteError(null);
    setFavoriteSaved(false);
    try {
      const value = await saveFavoriteFeishuAutoSyncSettings({
        enabled: favoriteAutoSyncEnabled,
        spaceId: favoriteSpaceId || null,
      });
      setSettings(value);
      setFavoriteAutoSyncEnabled(value.favoriteAutoSync.enabled);
      setFavoriteSpaceId(value.favoriteAutoSync.spaceId ?? "");
      setFavoriteSaved(true);
    } catch (reason) {
      setFavoriteError(reason instanceof Error ? reason.message : "保存收藏飞书同步设置失败");
    } finally {
      setFavoriteSaving(false);
    }
  }

  async function saveAsrDevice(event: FormEvent) {
    event.preventDefault();
    setAsrSaving(true);
    setAsrSaved(false);
    setAsrError(null);
    try {
      const value = await saveAsrSettings(asrDevice);
      setAsrSettings(value);
      setAsrDevice(value.selectedDevice);
      setAsrSaved(true);
    } catch (reason) {
      setAsrError(reason instanceof Error ? reason.message : "保存转录设备失败");
    } finally {
      setAsrSaving(false);
    }
  }

  function requestCleanup(target: MaintenanceCleanupTarget) {
    setCleanupTarget(target);
    setCleanupError(null);
    setCleanupStatus(null);
  }

  async function confirmCleanup() {
    if (!cleanupTarget) return;
    const target = cleanupTarget;
    setCleanupLoading(true);
    setCleanupError(null);
    setCleanupStatus(null);
    try {
      if (target === "logs") {
        const result = await clearJobLogs();
        setCleanupStatus(result.deletedLogs > 0
          ? `已清除 ${result.deletedLogs} 条任务日志`
          : "当前没有可清除的任务日志");
      } else {
        const result = await clearTerminalJobs();
        setCleanupStatus(result.deletedJobs > 0
          ? `已清除 ${result.deletedJobs} 个终态任务`
          : "当前没有可清除的终态任务");
      }
      setCleanupTarget(null);
    } catch (reason) {
      setCleanupError(reason instanceof Error ? reason.message : "数据清理失败");
    } finally {
      setCleanupLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageTitle icon={<Settings2 size={20} strokeWidth={1.5} />} title="设置" description="管理转录设备、外部服务与本地数据。" />
      <div className="grid gap-6">
        <AsrDeviceSection
          settings={asrSettings}
          selectedDevice={asrDevice}
          loading={asrLoading}
          saving={asrSaving}
          saved={asrSaved}
          error={asrError}
          onDeviceChange={(device) => {
            setAsrDevice(device);
            setAsrSaved(false);
            setAsrError(null);
          }}
          onSubmit={(event) => void saveAsrDevice(event)}
        />
        <GlassCard className="overflow-hidden">
          {loading ? <EmptyState title="正在读取设置" description="稍候，配置正在加载。" /> : (
            <form onSubmit={(event) => void submit(event)}>
              <div className="border-b border-white/8 p-5 md:p-7">
                <div className="flex items-start gap-4">
                  <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-blue-500/15 text-blue-300"><KeyRound size={20} strokeWidth={1.5} /></span>
                  <div>
                    <h2 className="font-semibold text-white/90">飞书自建应用</h2>
                    <p className="mt-1 text-sm leading-6 text-white/40">保存前会验证应用凭证。App Secret 只保存在当前主机，不会返回到浏览器。</p>
                  </div>
                </div>
              </div>
              <div className="grid gap-5 p-5 md:p-7">
                <label>
                  <span className="field-label">App ID</span>
                  <input className="input font-mono" value={appId} onChange={(event) => { setAppId(event.target.value); setSaved(false); }} placeholder="cli_xxxxxxxxxxxxxxxx" autoComplete="off" required />
                </label>
                <label>
                  <span className="field-label">App Secret</span>
                  <input
                    className="input font-mono"
                    type="password"
                    value={appSecret}
                    onChange={(event) => { setAppSecret(event.target.value); setSaved(false); }}
                    placeholder={settings?.appSecretConfigured ? "已配置；留空表示保持不变" : "请输入 App Secret"}
                    autoComplete="new-password"
                    required={!settings?.appSecretConfigured || settings.appId !== appId.trim()}
                  />
                </label>
                <div className="rounded-2xl border border-white/8 bg-white/3 px-4 py-3 text-xs leading-5 text-white/38">
                  请在飞书开放平台为应用开通知识库读取、创建节点和新版文档编辑权限，并将应用添加为目标知识库成员或管理员。
                </div>
                {error && <p role="alert" className="rounded-2xl border border-red-400/15 bg-red-500/8 px-4 py-3 text-sm text-red-200">{error}</p>}
                {saved && <p role="status" className="flex items-center gap-2 rounded-2xl border border-emerald-400/15 bg-emerald-500/8 px-4 py-3 text-sm text-emerald-200"><CheckCircle2 size={16} />凭证已验证并保存</p>}
                <div className="flex justify-end">
                  <button type="submit" className="primary-button min-w-32" disabled={saving || !appId.trim()}>
                    {saving ? <LoaderCircle className="animate-spin" size={16} /> : <Save size={16} />}
                    {saving ? "正在验证" : "保存设置"}
                  </button>
                </div>
              </div>
            </form>
          )}
        </GlassCard>
        <FavoriteFeishuSyncSection
          configured={Boolean(settings?.appSecretConfigured)}
          enabled={favoriteAutoSyncEnabled}
          spaceId={favoriteSpaceId}
          spaces={spaces}
          loadingSpaces={spacesLoading}
          saving={favoriteSaving}
          saved={favoriteSaved}
          error={favoriteError ?? spacesError}
          onEnabledChange={(enabled) => {
            setFavoriteAutoSyncEnabled(enabled);
            setFavoriteSaved(false);
            setFavoriteError(null);
          }}
          onSpaceChange={(spaceId) => {
            setFavoriteSpaceId(spaceId);
            setFavoriteSaved(false);
            setFavoriteError(null);
          }}
          onReload={() => void loadFeishuSpaces()}
          onSubmit={(event) => void saveFavoriteAutoSync(event)}
        />
        <DataCleanupSection
          busy={cleanupLoading}
          status={cleanupStatus}
          onRequest={requestCleanup}
        />
      </div>
      <MaintenanceCleanupDialog
        target={cleanupTarget}
        loading={cleanupLoading}
        error={cleanupError}
        onCancel={() => {
          if (!cleanupLoading) {
            setCleanupTarget(null);
            setCleanupError(null);
          }
        }}
        onConfirm={() => void confirmCleanup()}
      />
    </div>
  );
}

const asrDeviceOptions: Array<{ device: AsrDevice; label: string; description: string }> = [
  { device: "auto", label: "自动选择", description: "依次优先使用 CUDA、MPS 和 CPU。" },
  { device: "cpu", label: "CPU", description: "兼容性最高，但转录速度通常较慢。" },
  { device: "cuda", label: "NVIDIA CUDA", description: "适用于已安装 CUDA 版 PyTorch 的 Windows 或 Ubuntu。" },
  { device: "mps", label: "Apple MPS（实验性）", description: "适用于兼容的 macOS；遇到算子错误时请切换到 CPU。" },
];

export function AsrDeviceSection({
  settings,
  selectedDevice,
  loading,
  saving,
  saved,
  error,
  onDeviceChange,
  onSubmit,
}: {
  settings: AsrSettingsView | null;
  selectedDevice: AsrDevice;
  loading: boolean;
  saving: boolean;
  saved: boolean;
  error: string | null;
  onDeviceChange: (device: AsrDevice) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const available = new Set(settings?.availableDevices ?? []);
  const deviceAvailable = (device: AsrDevice) => device === "auto"
    ? available.size > 0
    : available.has(device);
  return (
    <GlassCard className="overflow-hidden">
      <form onSubmit={onSubmit}>
        <div className="border-b border-white/8 p-5 md:p-7">
          <div className="flex items-start gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-violet-500/15 text-violet-200"><Cpu size={20} strokeWidth={1.5} /></span>
            <div>
              <h2 className="font-semibold text-white/90">转录设备</h2>
              <p className="mt-1 text-sm leading-6 text-white/40">选择 Qwen3-ASR 加载设备。切换前必须停止收藏监听并等待任务队列清空。</p>
            </div>
          </div>
        </div>
        {loading ? <EmptyState title="正在检查转录设备" description="稍候，正在读取本机 PyTorch 能力。" /> : (
          <div className="grid gap-4 p-5 md:p-7">
            <div className="grid gap-2 sm:grid-cols-2">
              {asrDeviceOptions.map((option) => {
                const enabled = deviceAvailable(option.device);
                return (
                  <label key={option.device} className={`rounded-2xl border px-4 py-3 ${selectedDevice === option.device ? "border-violet-400/35 bg-violet-500/10" : "border-white/8 bg-white/3"} ${enabled ? "cursor-pointer" : "cursor-not-allowed opacity-45"}`}>
                    <span className="flex items-center gap-3">
                      <input type="radio" name="asr-device" value={option.device} checked={selectedDevice === option.device} disabled={!enabled || saving} onChange={() => onDeviceChange(option.device)} />
                      <span className="text-sm font-semibold text-white/85">{option.label}</span>
                    </span>
                    <span className="mt-2 block text-xs leading-5 text-white/38">{option.description}</span>
                  </label>
                );
              })}
            </div>
            {settings?.resolvedDevice && <p className="text-sm text-white/45">当前解析设备：<span className="font-mono text-violet-200">{settings.resolvedDevice.toUpperCase()}</span></p>}
            {settings?.diagnostic && <p className="rounded-2xl border border-amber-400/15 bg-amber-500/8 px-4 py-3 text-sm leading-6 text-amber-100/80">{settings.diagnostic}</p>}
            {error && <p role="alert" className="rounded-2xl border border-red-400/15 bg-red-500/8 px-4 py-3 text-sm text-red-200">{error}</p>}
            {saved && <p role="status" className="flex items-center gap-2 rounded-2xl border border-emerald-400/15 bg-emerald-500/8 px-4 py-3 text-sm text-emerald-200"><CheckCircle2 size={16} />转录设备已保存，将在下次转录时生效</p>}
            <div className="flex justify-end">
              <button type="submit" className="primary-button min-w-32" disabled={saving || !deviceAvailable(selectedDevice)}>{saving ? <LoaderCircle className="animate-spin" size={16} /> : <Save size={16} />}{saving ? "正在保存" : "保存设备"}</button>
            </div>
          </div>
        )}
      </form>
    </GlassCard>
  );
}

export function FavoriteFeishuSyncSection({
  configured,
  enabled,
  spaceId,
  spaces,
  loadingSpaces,
  saving,
  saved,
  error,
  onEnabledChange,
  onSpaceChange,
  onReload,
  onSubmit,
}: {
  configured: boolean;
  enabled: boolean;
  spaceId: string;
  spaces: FeishuSpace[] | null;
  loadingSpaces: boolean;
  saving: boolean;
  saved: boolean;
  error: string | null;
  onEnabledChange: (enabled: boolean) => void;
  onSpaceChange: (spaceId: string) => void;
  onReload: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const selectedSpaceAvailable = Boolean(
    spaceId && spaces?.some((space) => space.spaceId === spaceId),
  );
  const saveDisabled = saving
    || !configured
    || (enabled && (!spaces || !selectedSpaceAvailable));

  return (
    <GlassCard className="overflow-hidden">
      <form onSubmit={onSubmit}>
        <div className="border-b border-white/8 p-5 md:p-7">
          <div className="flex items-start gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-pink-500/15 text-pink-200">
              <CloudUpload size={20} strokeWidth={1.5} />
            </span>
            <div>
              <h2 className="font-semibold text-white/90">收藏飞书同步</h2>
              <p className="mt-1 text-sm leading-6 text-white/40">
                收藏文章生成后自动同步到指定知识库。关闭时仍会保留已选知识库。
              </p>
            </div>
          </div>
        </div>
        <div className="grid gap-5 p-5 md:p-7">
          <label className={`flex items-center justify-between gap-4 rounded-2xl border px-4 py-4 ${
            configured ? "border-white/8 bg-white/3" : "border-white/6 bg-white/[0.02] opacity-55"
          }`}>
            <span>
              <span className="block text-sm font-semibold text-white/85">自动同步新增收藏</span>
              <span className="mt-1 block text-xs leading-5 text-white/38">
                飞书失败只记录任务告警，不影响本地文章完成状态。
              </span>
            </span>
            <input
              type="checkbox"
              className="size-5 shrink-0 accent-[#5b9cff]"
              checked={enabled}
              disabled={!configured || saving}
              onChange={(event) => onEnabledChange(event.target.checked)}
            />
          </label>

          {!configured ? (
            <div className="rounded-2xl border border-amber-400/15 bg-amber-500/8 px-4 py-3 text-sm leading-6 text-amber-100/80">
              请先保存并验证上方的飞书应用凭证，再配置收藏自动同步。
            </div>
          ) : loadingSpaces ? (
            <div className="flex min-h-28 items-center justify-center gap-2 rounded-2xl border border-white/8 bg-white/3 text-sm text-white/45">
              <LoaderCircle className="animate-spin" size={17} />正在读取知识库
            </div>
          ) : spaces ? (
            <fieldset disabled={saving}>
              <legend className="field-label mb-3">目标知识库</legend>
              {spaces.length === 0 ? (
                <div className="rounded-2xl border border-amber-400/15 bg-amber-500/8 px-4 py-3 text-sm leading-6 text-amber-100/80">
                  当前应用没有可访问的知识库，请检查飞书权限和知识库成员设置。
                </div>
              ) : (
                <div className="grid gap-2">
                  {spaces.map((space) => (
                    <label
                      key={space.spaceId}
                      className={`focus-within:ring-2 focus-within:ring-blue-400/70 flex cursor-pointer items-start gap-3 rounded-2xl border px-4 py-3 transition ${
                        spaceId === space.spaceId
                          ? "border-blue-400/35 bg-blue-500/12"
                          : "border-white/8 bg-white/3 hover:bg-white/6"
                      }`}
                    >
                      <input
                        className="mt-1 size-4 accent-[#5b9cff]"
                        type="radio"
                        name="favorite-feishu-space"
                        value={space.spaceId}
                        checked={spaceId === space.spaceId}
                        onChange={() => onSpaceChange(space.spaceId)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block break-words text-sm font-medium text-white/85 [overflow-wrap:anywhere]">
                          {space.name}
                        </span>
                        {space.description && (
                          <span className="mt-1 block break-words text-xs leading-5 text-white/38 [overflow-wrap:anywhere]">
                            {space.description}
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              )}
              {spaceId && !selectedSpaceAvailable && (
                <p className="mt-3 rounded-2xl border border-amber-400/15 bg-amber-500/8 px-4 py-3 text-sm text-amber-100/80">
                  原目标知识库当前不可访问，请重新选择。
                </p>
              )}
            </fieldset>
          ) : (
            <div className="flex min-h-28 flex-col items-center justify-center gap-3 rounded-2xl border border-red-400/15 bg-red-500/8 p-4 text-center">
              <p className="text-sm text-red-200">{error ?? "读取飞书知识库失败"}</p>
              <button type="button" className="ghost-button" onClick={onReload}>
                <RefreshCw size={15} />重新加载
              </button>
            </div>
          )}

          {error && spaces && (
            <p role="alert" className="rounded-2xl border border-red-400/15 bg-red-500/8 px-4 py-3 text-sm text-red-200">
              {error}
            </p>
          )}
          {saved && (
            <p role="status" className="flex items-center gap-2 rounded-2xl border border-emerald-400/15 bg-emerald-500/8 px-4 py-3 text-sm text-emerald-200">
              <CheckCircle2 size={16} />收藏飞书同步设置已保存
            </p>
          )}
          <div className="flex justify-end">
            <button type="submit" className="primary-button min-w-32" disabled={saveDisabled}>
              {saving ? <LoaderCircle className="animate-spin" size={16} /> : <Save size={16} />}
              {saving ? "正在保存" : "保存同步设置"}
            </button>
          </div>
        </div>
      </form>
    </GlassCard>
  );
}

export function DataCleanupSection({
  busy,
  status,
  onRequest,
}: {
  busy: boolean;
  status: string | null;
  onRequest: (target: MaintenanceCleanupTarget) => void;
}) {
  return (
    <GlassCard className="overflow-hidden border-red-400/10">
      <div className="border-b border-white/8 p-5 md:p-7">
        <div className="flex items-start gap-4">
          <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-red-500/15 text-red-300"><Database size={20} strokeWidth={1.5} /></span>
          <div>
            <h2 className="font-semibold text-white/90">数据清理</h2>
            <p className="mt-1 text-sm leading-6 text-white/40">清理任务历史数据，不会删除人物、作品、Markdown 或飞书同步记录。</p>
          </div>
        </div>
      </div>
      <div className="grid gap-4 p-5 md:p-7">
        <CleanupAction
          icon={<ScrollText size={18} strokeWidth={1.5} />}
          title="清除所有任务日志"
          description="删除全部 job_logs。任务记录和任务处理明细仍会保留。"
          busy={busy}
          onClick={() => onRequest("logs")}
        />
        <CleanupAction
          icon={<Trash2 size={18} strokeWidth={1.5} />}
          title="清除最近任务"
          description="删除全部终态任务，并级联删除对应任务日志和处理明细。"
          busy={busy}
          onClick={() => onRequest("jobs")}
        />
        {status && <p role="status" className="flex items-center gap-2 rounded-2xl border border-emerald-400/15 bg-emerald-500/8 px-4 py-3 text-sm text-emerald-200"><CheckCircle2 size={16} />{status}</p>}
      </div>
    </GlassCard>
  );
}

function CleanupAction({
  icon,
  title,
  description,
  busy,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-white/8 bg-white/3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-red-500/10 text-red-300">{icon}</span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-white/85">{title}</h3>
          <p className="mt-1 text-xs leading-5 text-white/38">{description}</p>
        </div>
      </div>
      <button
        type="button"
        className="focus-ring inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-2xl border border-red-400/20 bg-red-500/12 px-4 text-sm font-semibold text-red-200 transition-colors enabled:hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
        disabled={busy}
        onClick={onClick}
      >
        {busy ? <LoaderCircle className="animate-spin" size={16} /> : <Trash2 size={16} />}
        {title}
      </button>
    </div>
  );
}

export function MaintenanceCleanupDialog({
  target,
  loading,
  error,
  onCancel,
  onConfirm,
}: {
  target: MaintenanceCleanupTarget | null;
  loading: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const content = cleanupDialogContent[target ?? "logs"];
  return (
    <DeleteConfirmationDialog
      open={target !== null}
      title={content.title}
      subject={content.subject}
      description={content.description}
      loading={loading}
      error={error}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
