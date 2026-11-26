import { useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Check,
  Copy,
  ExternalLink,
  HardDrive,
  Images,
  KeyRound,
  Lock,
  Plus,
  Shield,
  Shuffle,
  SlidersHorizontal,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { DEFAULT_TOKEN_LIFETIME_DAYS, MAX_SITE_ICON_BYTES, MAX_TOKEN_LIFETIME_DAYS, MIN_ADMIN_PASSWORD_LENGTH,
  type AdminSettings, type AlbumItem, type ApiTokenItem,
  type PublicConfig, type StorageStats, type WebpMode } from '../../shared/types';
import { api } from '../lib/api';
import { copyText, formatBytes, formatRelativeDate } from '../lib/format';
import { useModalDialog } from '../lib/modal';
import { SPRING_GENTLE, SPRING_SNAPPY } from '../lib/motion';
import { useConfirm } from './ConfirmDialog';
import { SiteIcon } from './SiteIcon';
import { Switch } from './Switch';
import { useToast } from './Toast';

interface SettingsDrawerProps {
  open: boolean;
  siteIconUrl: string | null;
  onClose: () => void;
  onConfigChanged: (cfg: PublicConfig) => void;
  onMaintenanceDone: () => void;
}

export function SettingsDrawer({
  open,
  siteIconUrl,
  onClose,
  onConfigChanged,
  onMaintenanceDone,
}: SettingsDrawerProps) {
  const { push } = useToast();
  const confirm = useConfirm();
  const drawerRef = useRef<HTMLElement | null>(null);
  const siteIconInput = useRef<HTMLInputElement>(null);
  const titleId = useId();
  useModalDialog(open, drawerRef, onClose);
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [numDrafts, setNumDrafts] = useState({
    guestMaxSizeMb: '',
    guestRateLimitPerMin: '',
    adminMaxSizeMb: '',
  });
  const [hardMaxMb, setHardMaxMb] = useState(200);
  const [publicUrlLocked, setPublicUrlLocked] = useState(false);
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [albums, setAlbums] = useState<AlbumItem[]>([]);
  const [tokens, setTokens] = useState<ApiTokenItem[]>([]);
  const [newTokenName, setNewTokenName] = useState('');
  const [tokenLifetime, setTokenLifetime] = useState(String(DEFAULT_TOKEN_LIFETIME_DAYS));
  const [customTokenDays, setCustomTokenDays] = useState('');
  const [creatingToken, setCreatingToken] = useState(false);
  const [choosingRandomAlbums, setChoosingRandomAlbums] = useState(false);
  const [freshRawToken, setFreshRawToken] = useState<string | null>(null);
  const [currentPwd, setCurrentPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [saving, setSaving] = useState(false);
  const saveQueue = useRef(Promise.resolve());
  const pendingSaves = useRef(0);

  const syncNumDrafts = (s: Pick<AdminSettings, 'guestMaxSizeMb' | 'guestRateLimitPerMin' | 'adminMaxSizeMb'>) => {
    setNumDrafts({
      guestMaxSizeMb: String(s.guestMaxSizeMb),
      guestRateLimitPerMin: String(s.guestRateLimitPerMin),
      adminMaxSizeMb: String(s.adminMaxSizeMb),
    });
  };

  const loadAll = async () => {
    try {
      const [sRes, stRes, tRes, aRes] = await Promise.all([
        api.getSettings(),
        api.getStats(),
        api.listTokens(),
        api.listAlbums(),
      ]);
      setSettings(sRes.settings);
      syncNumDrafts(sRes.settings);
      setHardMaxMb(sRes.hardMaxUploadMb);
      setPublicUrlLocked(sRes.publicUrlLocked);
      setStats(stRes);
      setTokens(tRes.items);
      setAlbums(aRes.items);
    } catch (err) {
      push(err instanceof Error ? err.message : '加载设置失败', 'error');
    }
  };

  useEffect(() => {
    if (open) {
      setFreshRawToken(null);
      void loadAll();
    } else {
      setChoosingRandomAlbums(false);
      setFreshRawToken(null);
      setCurrentPwd('');
      setNewPwd('');
    }
  }, [open]);

  const save = async (update: () => Promise<void>, errorMessage: string) => {
    pendingSaves.current++;
    setSaving(true);
    const next = saveQueue.current.then(async () => {
      try {
        await update();
      } catch (err) {
        push(err instanceof Error ? err.message : errorMessage, 'error');
        if (pendingSaves.current === 1) await loadAll();
      } finally {
        pendingSaves.current--;
        if (pendingSaves.current === 0) setSaving(false);
      }
    });
    saveQueue.current = next;
    await next;
  };

  const patchSettings = async (patch: Partial<AdminSettings>, toastMsg?: string) => {
    if (!settings) return;
    await save(async () => {
      const res = await api.updateSettings(patch);
      const saved = Object.fromEntries(Object.keys(patch).map((key) => [key, res.settings[key as keyof AdminSettings]]));
      setSettings((previous) => {
        if (!previous) return previous;
        const merged = { ...previous, ...saved };
        syncNumDrafts(merged);
        return merged;
      });
      onConfigChanged(res.publicConfig);
      if (toastMsg) push(toastMsg, 'success');
    }, '保存设置失败');
  };

  const commitNumberField = (
    field: 'guestMaxSizeMb' | 'guestRateLimitPerMin' | 'adminMaxSizeMb',
    min: number,
    max: number,
    toastMsg: string
  ) => {
    if (!settings) return;
    const raw = numDrafts[field].trim();
    const parsed = Number(raw);
    if (!raw || !Number.isFinite(parsed)) {
      setNumDrafts((prev) => ({ ...prev, [field]: String(settings[field]) }));
      return;
    }
    const clamped = Math.min(max, Math.max(min, Math.round(parsed)));
    setNumDrafts((prev) => ({ ...prev, [field]: String(clamped) }));
    if (clamped !== settings[field]) {
      void patchSettings({ [field]: clamped }, toastMsg);
    }
  };

  const changeSiteIcon = (file: File | null) => {
    if (file && (file.size === 0 || file.size > MAX_SITE_ICON_BYTES)) {
      push('请选择不超过 2 MB 的非空图片', 'error');
      return;
    }
    void save(async () => {
      const { publicConfig } = file ? await api.uploadSiteIcon(file) : await api.resetSiteIcon();
      onConfigChanged(publicConfig);
      push(file ? '站点图标已更新' : '已恢复默认站点图标', 'success');
    }, '保存站点图标失败');
  };

  const handleCleanup = async (mode: 'expired' | 'all_guest' | 'empty_trash') => {
    if (
      mode === 'all_guest' &&
      !(await confirm({
        title: '永久清空全部游客图片？',
        description: '所有游客上传的图片及其外链将被永久删除（已转存到管理员相册的副本不受影响），此操作不可撤销。',
        confirmLabel: '确认清空',
        tone: 'danger',
      }))
    ) {
      return;
    }
    if (
      mode === 'empty_trash' &&
      !(await confirm({
        title: '彻底清空回收站？',
        description: '回收站内的全部图片将被永久销毁且不可恢复。',
        confirmLabel: '确认清空',
        tone: 'danger',
      }))
    ) {
      return;
    }
    try {
      const res = await api.cleanup(mode);
      push(`清理完成，共移除 ${res.deletedCount} 张图片`, 'success');
      await loadAll();
      onMaintenanceDone();
    } catch (err) {
      push(err instanceof Error ? err.message : '清理失败', 'error');
    }
  };

  const handleCreateToken = async () => {
    if (creatingToken) return;
    const days = Number(tokenLifetime === 'custom' ? customTokenDays : tokenLifetime);
    if (!Number.isInteger(days) || days < (tokenLifetime === 'custom' ? 1 : 0) || days > MAX_TOKEN_LIFETIME_DAYS) {
      push(`请输入 1 到 ${MAX_TOKEN_LIFETIME_DAYS} 之间的整数天数`, 'error');
      return;
    }
    setCreatingToken(true);
    try {
      const res = await api.createToken(newTokenName.trim() || 'PicGo 客户端', days);
      setFreshRawToken(res.rawToken);
      setNewTokenName('');
      setTokens((prev) => [res.item, ...prev]);
      push('API Token 已生成，请及时复制保存', 'success');
    } catch (err) {
      push(err instanceof Error ? err.message : '创建 Token 失败', 'error');
    } finally {
      setCreatingToken(false);
    }
  };

  const handleChangePassword = async () => {
    if (!currentPwd || !newPwd.trim() || newPwd.length < MIN_ADMIN_PASSWORD_LENGTH || new TextEncoder().encode(newPwd).length > 256) {
      push(`请输入当前密码，新密码至少 ${MIN_ADMIN_PASSWORD_LENGTH} 个字符且不超过 256 字节`, 'error');
      return;
    }
    if (
      !(await confirm({
        title: '确认修改管理员密码？',
        description: '更新密码后将退出其他已登录设备，并自动吊销所有已签发的上传 API Token。',
        confirmLabel: '确认更新',
        tone: 'danger',
      }))
    ) {
      return;
    }
    try {
      await api.changePassword(currentPwd, newPwd);
      setCurrentPwd('');
      setNewPwd('');
      await loadAll();
      push('管理员密码已更新', 'success');
    } catch (err) {
      push(err instanceof Error ? err.message : '修改密码失败', 'error');
    }
  };

  const diskPct =
    stats?.diskTotalBytes && stats.diskFreeBytes !== null
      ? Math.min(
          100,
          Math.round(((stats.diskTotalBytes - stats.diskFreeBytes) / stats.diskTotalBytes) * 100)
        )
      : 0;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="fixed inset-0 z-40 bg-black/30 backdrop-blur-xs"
          />

          <motion.aside
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={SPRING_GENTLE}
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-zinc-200/80 bg-white/95 shadow-2xl backdrop-blur-2xl outline-none dark:border-white/10 dark:bg-zinc-950/95"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-zinc-200/80 px-6 py-4 dark:border-white/10">
              <div className="flex items-center gap-2.5">
                <SlidersHorizontal className="h-4 w-4 text-blue-500" />
                <h2 id={titleId} className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">图床设置</h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="关闭设置"
                className="rounded-full p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-white/10 dark:hover:text-zinc-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
              {!settings ? (
                <div className="py-12 text-center text-xs text-zinc-400">正在加载配置...</div>
              ) : (
                <>
                  {/* 1. Core Guest Upload Toggle */}
                  <section className="rounded-2xl border border-blue-500/25 bg-blue-500/[0.04] p-4 dark:bg-blue-500/[0.06]">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-blue-500/15 text-blue-600 dark:text-blue-400">
                          <Users className="h-4 w-4" />
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                            允许游客上传图片
                          </p>
                          <p className="mt-0.5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                            开启后，未登录访客可在首页上传并获得外链。后台图库仍需登录。
                          </p>
                        </div>
                      </div>
                      <Switch
                        checked={settings.allowGuestUpload}
                        disabled={saving}
                        ariaLabel="允许游客上传图片"
                        onChange={(next) =>
                          void patchSettings(
                            { allowGuestUpload: next },
                            next ? '已开启游客上传通道' : '已关闭游客上传'
                          )
                        }
                      />
                    </div>

                    <AnimatePresence initial={false}>
                      {settings.allowGuestUpload && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={SPRING_SNAPPY}
                          className="overflow-hidden"
                        >
                          <div className="mt-4 grid grid-cols-1 gap-2.5 border-t border-blue-500/15 pt-4 sm:grid-cols-3">
                            <div>
                              <label className="block text-[11px] text-zinc-500 dark:text-zinc-400">
                                单图上限 (MB)
                              </label>
                              <input
                                type="number"
                                min={1}
                                max={hardMaxMb}
                                value={numDrafts.guestMaxSizeMb}
                                onChange={(e) =>
                                  setNumDrafts((prev) => ({ ...prev, guestMaxSizeMb: e.target.value }))
                                }
                                onBlur={() => commitNumberField('guestMaxSizeMb', 1, hardMaxMb, '游客限额已更新')}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') e.currentTarget.blur();
                                }}
                                className="mt-1 w-full rounded-xl border border-zinc-200 bg-white px-2.5 py-1.5 text-xs dark:border-white/10 dark:bg-zinc-900"
                              />
                            </div>
                            <div>
                              <label className="block text-[11px] text-zinc-500 dark:text-zinc-400">
                                每分钟限次
                              </label>
                              <input
                                type="number"
                                min={1}
                                max={120}
                                value={numDrafts.guestRateLimitPerMin}
                                onChange={(e) =>
                                  setNumDrafts((prev) => ({ ...prev, guestRateLimitPerMin: e.target.value }))
                                }
                                onBlur={() => commitNumberField('guestRateLimitPerMin', 1, 120, '频率限制已更新')}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') e.currentTarget.blur();
                                }}
                                className="mt-1 w-full rounded-xl border border-zinc-200 bg-white px-2.5 py-1.5 text-xs dark:border-white/10 dark:bg-zinc-900"
                              />
                            </div>
                            <div>
                              <label className="block text-[11px] text-zinc-500 dark:text-zinc-400">
                                自动过期
                              </label>
                              <select
                                value={settings.guestTtlDays}
                                onChange={(e) =>
                                  void patchSettings(
                                    { guestTtlDays: Number(e.target.value) },
                                    '游客图片保留时长已更新'
                                  )
                                }
                                className="mt-1 w-full rounded-xl border border-zinc-200 bg-white px-2 py-1.5 text-xs text-zinc-900 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-100"
                              >
                                <option value={1}>1 天</option>
                                <option value={7}>7 天</option>
                                <option value={30}>30 天</option>
                                <option value={0}>永久保留</option>
                              </select>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </section>

                  {/* 2. VPS Local Disk Stats */}
                  {stats && (
                    <section className="rounded-2xl border border-zinc-200/80 bg-zinc-50/70 p-4 dark:border-white/10 dark:bg-white/[0.03]">
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-2 text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                          <HardDrive className="h-4 w-4 text-zinc-500" />
                          VPS 本地存储概览
                        </span>
                        <span className="font-mono text-[11px] text-zinc-500">
                          图库占用 {formatBytes(stats.usedBytes)}
                        </span>
                      </div>

                      {stats.diskTotalBytes && stats.diskFreeBytes !== null && (
                        <div className="mt-3">
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                            <div
                              className="h-full rounded-full bg-zinc-900 transition-all dark:bg-zinc-200"
                              style={{ width: `${diskPct}%` }}
                            />
                          </div>
                          <div className="mt-1.5 flex justify-between text-[11px] text-zinc-500">
                            <span>磁盘已用 {diskPct}%</span>
                            <span>剩余可用 {formatBytes(stats.diskFreeBytes)}</span>
                          </div>
                        </div>
                      )}

                      <div className="mt-3 grid grid-cols-3 gap-2 text-center text-[11px]">
                        <div className="rounded-xl bg-white p-2 dark:bg-zinc-900">
                          <p className="font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                            {stats.adminImages}
                          </p>
                          <p className="text-zinc-500">管理员图</p>
                        </div>
                        <div className="rounded-xl bg-white p-2 dark:bg-zinc-900">
                          <p className="font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                            {stats.guestImages}
                          </p>
                          <p className="text-zinc-500">游客图</p>
                        </div>
                        <div className="rounded-xl bg-white p-2 dark:bg-zinc-900">
                          <p className="font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                            {stats.trashImages}
                          </p>
                          <p className="text-zinc-500">回收站</p>
                        </div>
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void handleCleanup('expired')}
                          className="rounded-xl border border-zinc-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-white/10"
                        >
                          清理过期图片
                        </button>
                        {stats.guestImages > 0 && (
                          <button
                            type="button"
                            onClick={() => void handleCleanup('all_guest')}
                            className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-2.5 py-1.5 text-[11px] font-medium text-amber-700 transition-colors hover:bg-amber-500/20 dark:text-amber-300"
                          >
                            清空游客图片
                          </button>
                        )}
                        {stats.trashImages > 0 && (
                          <button
                            type="button"
                            onClick={() => void handleCleanup('empty_trash')}
                            className="rounded-xl border border-rose-500/25 bg-rose-500/10 px-2.5 py-1.5 text-[11px] font-medium text-rose-600 transition-colors hover:bg-rose-500/20 dark:text-rose-300"
                          >
                            清空回收站
                          </button>
                        )}
                      </div>
                    </section>
                  )}

                  {/* 3. Image Processing & Site Basics */}
                  <section className="space-y-3.5">
                    <h3 className="text-xs font-semibold tracking-wide text-zinc-400 uppercase">
                      图片优化与站点配置
                    </h3>

                    <div className="space-y-2">
                      <div>
                        <p className="text-xs font-medium text-zinc-900 dark:text-zinc-100">
                          上传自动转为 WebP
                        </p>
                        <p className="text-[11px] text-zinc-500">
                          静态图可转为 WebP；保留原格式时优先无损剥离元数据，动图保持原帧动画。
                        </p>
                      </div>
                      <div className="grid grid-cols-3 gap-1.5 rounded-xl border border-zinc-200/80 bg-zinc-100/70 p-1 dark:border-white/10 dark:bg-black/30">
                        {(
                          [
                            { id: 'off', label: '关闭' },
                            { id: 'guest_only', label: '仅游客生效' },
                            { id: 'all', label: '全部生效' },
                          ] as Array<{ id: WebpMode; label: string }>
                        ).map((opt) => {
                          const active = settings.webpMode === opt.id;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              onClick={() =>
                                void patchSettings({ webpMode: opt.id }, `WebP 策略已切换为：${opt.label}`)
                              }
                              className={`rounded-lg px-2 py-1.5 text-[11px] font-medium transition-colors ${
                                active
                                  ? 'bg-white text-zinc-900 shadow-xs dark:bg-zinc-800 dark:text-white'
                                  : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
                              }`}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {settings.webpMode !== 'off' && (
                      <div className="flex items-center justify-between gap-4 rounded-xl bg-zinc-50 px-3 py-2 dark:bg-white/[0.03]">
                        <span className="text-xs text-zinc-600 dark:text-zinc-300">
                          WebP 画质 ({settings.webpQuality}%)
                        </span>
                        <input
                          type="range"
                          min={40}
                          max={95}
                          value={settings.webpQuality}
                          onChange={(e) =>
                            setSettings({ ...settings, webpQuality: Number(e.target.value) })
                          }
                          onMouseUp={() =>
                            void patchSettings({ webpQuality: settings.webpQuality })
                          }
                          onTouchEnd={() =>
                            void patchSettings({ webpQuality: settings.webpQuality })
                          }
                          onKeyUp={(event) => {
                            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
                              void patchSettings({ webpQuality: settings.webpQuality });
                            }
                          }}
                          className="w-32 accent-blue-600"
                        />
                      </div>
                    )}

                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-medium text-zinc-900 dark:text-zinc-100">
                          自动清除隐私 EXIF
                        </p>
                        <p className="text-[11px] text-zinc-500">
                          剥离照片中的 GPS 经纬度与设备信息；关闭后可在灯箱查看相机参数
                        </p>
                      </div>
                      <Switch
                        checked={settings.stripExif}
                        onChange={(next) =>
                          void patchSettings({ stripExif: next }, 'EXIF 隐私策略已更新')
                        }
                      />
                    </div>

                    <div className="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-2">
                      <div>
                        <label className="block text-[11px] text-zinc-500">站点名称</label>
                        <input
                          type="text"
                          value={settings.siteTitle}
                          onChange={(e) => setSettings({ ...settings, siteTitle: e.target.value })}
                          onBlur={() =>
                            void patchSettings({ siteTitle: settings.siteTitle }, '站点标题已更新')
                          }
                          className="mt-1 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs outline-none focus:border-blue-500 dark:border-white/10 dark:bg-zinc-900"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] text-zinc-500">
                          管理员单图上限 (MB，最高 {hardMaxMb})
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={hardMaxMb}
                          value={numDrafts.adminMaxSizeMb}
                          onChange={(e) =>
                            setNumDrafts((prev) => ({ ...prev, adminMaxSizeMb: e.target.value }))
                          }
                          onBlur={() => commitNumberField('adminMaxSizeMb', 1, hardMaxMb, '单图上限已更新')}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') e.currentTarget.blur();
                          }}
                          className="mt-1 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs outline-none focus:border-blue-500 dark:border-white/10 dark:bg-zinc-900"
                        />
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <SiteIcon url={siteIconUrl} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">
                        <Images className="h-4 w-4" />
                      </SiteIcon>
                      <div className="mr-auto">
                        <p className="text-xs font-medium text-zinc-900 dark:text-zinc-100">站点图标</p>
                        <p className="text-[11px] text-zinc-500">PNG、JPG、WebP，最多 2 MB</p>
                      </div>
                      <input
                        ref={siteIconInput}
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        aria-label="站点图标"
                        className="hidden"
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0];
                          event.currentTarget.value = '';
                          if (file) changeSiteIcon(file);
                        }}
                      />
                      {siteIconUrl && (
                        <button type="button" disabled={saving} onClick={() => changeSiteIcon(null)}
                          className="rounded-xl px-2.5 py-1.5 text-xs text-zinc-500 hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-white/10">
                          恢复默认
                        </button>
                      )}
                      <button type="button" disabled={saving} onClick={() => siteIconInput.current?.click()}
                        className="rounded-xl border border-zinc-200/80 px-2.5 py-1.5 text-xs font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/10">
                        选择图标
                      </button>
                    </div>

                    <div>
                      <label className="block text-[11px] text-zinc-500">
                        外链域名{publicUrlLocked ? '（由部署环境管理）' : '（可选，如 https://img.example.com）'}
                      </label>
                      <input
                        type="text"
                        placeholder="留空则自动使用当前访问的 IP 或域名"
                        value={settings.publicUrl}
                        readOnly={publicUrlLocked}
                        onChange={(e) => setSettings({ ...settings, publicUrl: e.target.value })}
                        onBlur={() => {
                          if (!publicUrlLocked) void patchSettings({ publicUrl: settings.publicUrl }, '外链域名已更新');
                        }}
                        className="mt-1 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-1.5 font-mono text-xs outline-none focus:border-blue-500 dark:border-white/10 dark:bg-zinc-900"
                      />
                    </div>
                  </section>

                  {/* 4. Hotlink Protection */}
                  <section className="space-y-3 border-t border-zinc-200/70 pt-4 dark:border-white/10">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <Shield className="h-4 w-4 text-zinc-500" />
                        <div>
                          <p className="text-xs font-medium text-zinc-900 dark:text-zinc-100">
                            Referer 防盗链保护
                          </p>
                          <p className="text-[11px] text-zinc-500">
                            {settings.hotlinkAllowEmpty
                              ? '允许本站、白名单以及省略 Referer 的请求。'
                              : '仅允许本站与白名单来源。缺少来源的请求会被拒绝。'}
                          </p>
                        </div>
                      </div>
                      <Switch
                        checked={settings.hotlinkProtection}
                        onChange={(next) =>
                          void patchSettings({ hotlinkProtection: next }, '防盗链设置已更新')
                        }
                      />
                    </div>

                    {settings.hotlinkProtection && (
                      <div className="space-y-2.5">
                        <textarea
                          rows={2}
                          placeholder="允许的域名，逗号或换行分隔，如：example.com, *.myblog.com"
                          value={settings.allowedReferers}
                          onChange={(e) =>
                            setSettings({ ...settings, allowedReferers: e.target.value })
                          }
                          onBlur={() =>
                            void patchSettings(
                              { allowedReferers: settings.allowedReferers },
                              '防盗链白名单已保存'
                            )
                          }
                          className="w-full rounded-xl border border-zinc-200 bg-zinc-50 p-2.5 font-mono text-xs outline-none focus:border-blue-500 dark:border-white/10 dark:bg-zinc-900"
                        />
                        <div className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200/70 bg-zinc-50/70 px-3 py-2 dark:border-white/10 dark:bg-white/[0.03]">
                          <div>
                            <p className="text-xs font-medium text-zinc-800 dark:text-zinc-200">
                              允许空 Referer（浏览器直链 / 客户端打开）
                            </p>
                            <p className="text-[11px] text-zinc-500">
                              开启后可从地址栏打开，也允许省略 Referer 的站外嵌入。
                            </p>
                          </div>
                          <Switch
                            checked={settings.hotlinkAllowEmpty}
                            disabled={saving}
                            ariaLabel="允许空 Referer"
                            onChange={(next) =>
                              void patchSettings(
                                { hotlinkAllowEmpty: next },
                                next ? '已允许空 Referer 访问' : '已恢复严格拒绝空 Referer'
                              )
                            }
                          />
                        </div>
                      </div>
                    )}
                  </section>

                  {/* 5. Random Image API */}
                  <section className="space-y-3 border-t border-zinc-200/70 pt-4 dark:border-white/10">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <Shuffle className="h-4 w-4 text-zinc-500" />
                        <div>
                          <p className="text-xs font-medium text-zinc-900 dark:text-zinc-100">
                            随机图片 API
                          </p>
                          <p className="text-[11px] text-zinc-500">
                            从选定相册中抽取已创建公开外链的管理员图片
                          </p>
                        </div>
                      </div>
                      <Switch
                        checked={settings.randomApiEnabled || choosingRandomAlbums}
                        disabled={saving}
                        ariaLabel="开启随机图片 API"
                        onChange={(next) => {
                          if (next && settings.randomApiAlbumIds.length === 0) {
                            setChoosingRandomAlbums(true);
                          } else {
                            setChoosingRandomAlbums(false);
                            if (next !== settings.randomApiEnabled) {
                              void patchSettings({ randomApiEnabled: next }, next ? '已开启随机图片 API' : '已关闭随机图片 API');
                            }
                          }
                        }}
                      />
                    </div>

                    <AnimatePresence initial={false}>
                      {(settings.randomApiEnabled || choosingRandomAlbums) && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={SPRING_SNAPPY}
                          className="space-y-3 overflow-hidden"
                        >
                          <div className="rounded-xl border border-zinc-200/80 bg-zinc-50/70 p-3 dark:border-white/10 dark:bg-white/[0.03]">
                            <p className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
                              {settings.randomApiEnabled ? '图片来源相册（可多选）' : '选择至少一个相册后开启'}
                            </p>
                            {albums.length === 0 && <p className="mt-2 text-[11px] text-zinc-500">请先在图库中创建相册。</p>}
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {albums.map((alb) => {
                                const selected = settings.randomApiAlbumIds.includes(alb.id);
                                return (
                                  <button
                                    key={alb.id}
                                    type="button"
                                    disabled={saving}
                                    onClick={() => {
                                      const nextIds = selected
                                        ? settings.randomApiAlbumIds.filter((id) => id !== alb.id)
                                        : [...settings.randomApiAlbumIds, alb.id];
                                      if (nextIds.length === 0) setChoosingRandomAlbums(true);
                                      void patchSettings({
                                        randomApiAlbumIds: nextIds,
                                        randomApiEnabled: nextIds.length > 0,
                                      });
                                    }}
                                    className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors ${
                                      selected
                                        ? 'bg-blue-600 text-white'
                                        : 'bg-white text-zinc-600 hover:bg-zinc-100 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800'
                                    }`}
                                  >
                                    {selected && <Check className="h-3 w-3" />}
                                    <span>{alb.name}</span>
                                    <span className="opacity-65">{alb.imageCount}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          {settings.randomApiEnabled && <div className="rounded-xl border border-zinc-200/80 bg-zinc-50/70 p-3 text-xs dark:border-white/10 dark:bg-white/[0.03]">
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate font-mono text-[11px] text-zinc-800 dark:text-zinc-200">
                                {(settings.publicUrl || window.location.origin)}/api/random
                              </span>
                              <div className="flex shrink-0 items-center gap-1">
                                <button
                                  type="button"
                                  onClick={async () => {
                                    const url = `${settings.publicUrl || window.location.origin}/api/random`;
                                    if (await copyText(url)) {
                                      push('已复制随机图 API 地址', 'success');
                                    }
                                  }}
                                  className="rounded-lg bg-white p-1.5 text-zinc-600 shadow-xs hover:text-blue-600 dark:bg-zinc-900 dark:text-zinc-300"
                                  title="复制链接"
                                >
                                  <Copy className="h-3.5 w-3.5" />
                                </button>
                                <a
                                  href="/api/random"
                                  target="_blank"
                                  rel="noreferrer"
                                  className="rounded-lg bg-white p-1.5 text-zinc-600 shadow-xs hover:text-blue-600 dark:bg-zinc-900 dark:text-zinc-300"
                                  title="新窗口测试打开"
                                >
                                  <ExternalLink className="h-3.5 w-3.5" />
                                </a>
                              </div>
                            </div>
                            <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-500">
                              短路径也支持 <code className="font-mono">/random</code>；追加{' '}
                              <code className="font-mono">?format=json</code> 返回 JSON，追加{' '}
                              <code className="font-mono">?orient=landscape</code> 或{' '}
                              <code className="font-mono">portrait</code> 按横竖屏抽取。
                            </p>
                          </div>}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </section>

                  {/* 6. API Tokens (PicGo / Typora) */}
                  <section className="space-y-3 border-t border-zinc-200/70 pt-4 dark:border-white/10">
                    <div className="flex items-center gap-2">
                      <KeyRound className="h-4 w-4 text-zinc-500" />
                      <h3 className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                        API Token（用于 PicGo / Typora / 脚本传图）
                      </h3>
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={newTokenName}
                        onChange={(e) => setNewTokenName(e.target.value)}
                        placeholder="备注名，如：主力电脑 PicGo"
                        className="min-w-0 flex-1 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs outline-none focus:border-blue-500 dark:border-white/10 dark:bg-zinc-900"
                      />
                      <select
                        aria-label="Token 有效期"
                        title="Token 有效期"
                        value={tokenLifetime}
                        onChange={(event) => setTokenLifetime(event.target.value)}
                        className="shrink-0 rounded-xl border border-zinc-200 bg-zinc-50 px-2 py-1.5 text-xs outline-none focus:border-blue-500 dark:border-white/10 dark:bg-zinc-900"
                      >
                        <option value="7">7 天</option>
                        <option value="30">30 天</option>
                        <option value={DEFAULT_TOKEN_LIFETIME_DAYS}>{DEFAULT_TOKEN_LIFETIME_DAYS} 天</option>
                        <option value="365">365 天</option>
                        <option value="custom">自定义</option>
                        <option value="0">永久</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => void handleCreateToken()}
                        disabled={creatingToken}
                        className="inline-flex shrink-0 items-center gap-1 rounded-xl bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-60 dark:bg-white dark:text-zinc-900"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        生成
                      </button>
                    </div>
                    {tokenLifetime === 'custom' && (
                      <label className="flex items-center gap-2 text-[11px] text-zinc-500">
                        自定义天数
                        <input type="number" min={1} max={MAX_TOKEN_LIFETIME_DAYS} step={1}
                          value={customTokenDays} onChange={(event) => setCustomTokenDays(event.target.value)}
                          className="w-24 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs text-zinc-900 outline-none focus:border-blue-500 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-100" />
                      </label>
                    )}

                    {freshRawToken && (
                      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs">
                        <p className="font-medium text-emerald-700 dark:text-emerald-300">
                          新 Token（仅展示这一次，请妥善复制）：
                        </p>
                        <div className="mt-1.5 flex items-center justify-between gap-2 rounded-lg bg-white/80 px-2.5 py-1.5 font-mono text-[11px] dark:bg-black/40">
                          <span className="truncate">{freshRawToken}</span>
                          <button
                            type="button"
                            onClick={async () => {
                              if (await copyText(freshRawToken)) {
                                push('已复制 Token', 'success');
                              }
                            }}
                            className="shrink-0 text-blue-600 dark:text-blue-400"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <p className="mt-2 text-[11px] text-zinc-600 dark:text-zinc-400">
                          PicGo 自定义图床填法：接口 <code className="font-mono">{window.location.origin}/api/upload</code>，字段名{' '}
                          <code className="font-mono">file</code>，JSON 路径 <code className="font-mono">url</code>，请求头{' '}
                          <code className="font-mono">Authorization: Bearer 你的Token</code>
                        </p>
                      </div>
                    )}

                    {tokens.length > 0 && (
                      <div className="space-y-1.5">
                        {tokens.map((t) => (
                          <div
                            key={t.id}
                            className="flex items-center justify-between rounded-xl border border-zinc-200/70 px-3 py-2 text-xs dark:border-white/10"
                          >
                            <div>
                              <p className="font-medium text-zinc-800 dark:text-zinc-200">{t.name}</p>
                              <p className="font-mono text-[10px] text-zinc-400">
                                {t.prefix}... ·{' '}
                                {t.lastUsedAt ? `最近使用 ${formatRelativeDate(t.lastUsedAt)}` : '尚未使用'}
                                {t.expiresAt ? ` · 到期 ${new Date(t.expiresAt).toLocaleDateString('zh-CN')}` : ' · 永久'}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await api.deleteToken(t.id);
                                  setTokens((prev) => prev.filter((x) => x.id !== t.id));
                                  push('已吊销 Token', 'success');
                                } catch (error) {
                                  push(error instanceof Error ? error.message : '吊销 Token 失败', 'error');
                                }
                              }}
                              className="rounded-lg p-1.5 text-zinc-400 hover:bg-rose-500/10 hover:text-rose-500"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>

                  {/* 7. Change Password */}
                  <section className="space-y-2.5 border-t border-zinc-200/70 pt-4 dark:border-white/10">
                    <div className="flex items-center gap-2">
                      <Lock className="h-4 w-4 text-zinc-500" />
                      <h3 className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                        修改管理员密码
                      </h3>
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <input
                        type="password"
                        value={currentPwd}
                        onChange={(e) => setCurrentPwd(e.target.value)}
                        placeholder="当前密码"
                        className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs outline-none focus:border-blue-500 dark:border-white/10 dark:bg-zinc-900"
                      />
                      <input
                        type="password"
                        value={newPwd}
                        onChange={(e) => setNewPwd(e.target.value)}
                      placeholder={`新密码（至少 ${MIN_ADMIN_PASSWORD_LENGTH} 个字符）`}
                        className="rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs outline-none focus:border-blue-500 dark:border-white/10 dark:bg-zinc-900"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleChangePassword()}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-white/10"
                    >
                      <Check className="h-3.5 w-3.5" />
                      更新密码
                    </button>
                  </section>
                </>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
