import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import {
  BookmarkPlus,
  Check,
  CheckSquare,
  ChevronDown,
  Copy,
  Download,
  FolderInput,
  FolderPlus,
  Images,
  Lock,
  LogOut,
  Moon,
  Pencil,
  RotateCcw,
  Search,
  Settings,
  Sun,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { MAX_BATCH_IMAGES, type AlbumItem, type ImageItem, type PublicConfig, type UploaderType } from '../shared/types';
import { api, ApiError, triggerSingleImageDownload, type GuestHistoryItem } from './lib/api';
import { buildImageLink, copyText, type CopyFormat } from './lib/format';
import { useModalDialog } from './lib/modal';
import { SPRING_GENTLE, SPRING_SNAPPY } from './lib/motion';
import { AuthCard } from './components/AuthCard';
import { ConfirmProvider, useConfirm } from './components/ConfirmDialog';
import { GalleryGrid } from './components/GalleryGrid';
import { GuestHistoryGrid } from './components/GuestHistoryGrid';
import { Lightbox } from './components/Lightbox';
import { SettingsDrawer } from './components/SettingsDrawer';
import { SiteIcon } from './components/SiteIcon';
import { ToastProvider, useToast } from './components/Toast';
import { UploadZone } from './components/UploadZone';

function normalizePath(p: string): string {
  return p.replace(/\/+$/, '') || '/';
}

function WorkspaceApp() {
  const { push } = useToast();
  const confirm = useConfirm();
  const [pathname, setPathname] = useState<string>(() => normalizePath(window.location.pathname));
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [configError, setConfigError] = useState('');
  const [dark, setDark] = useState<boolean>(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  );
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [copyFormat, setCopyFormat] = useState<CopyFormat>(() => {
    try {
      const saved = localStorage.getItem('lumepic_copy_format');
      if (saved === 'url' || saved === 'markdown' || saved === 'html' || saved === 'bbcode') {
        return saved;
      }
    } catch {}
    return 'markdown';
  });

  // Admin Gallery State
  const [storedImages, setImages] = useState<ImageItem[]>([]);
  const [storedTotal, setTotalImages] = useState(0);
  const [loadedViewKey, setLoadedViewKey] = useState('');
  const galleryRequest = useRef<AbortController | null>(null);
  const [albums, setAlbums] = useState<AlbumItem[]>([]);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [uploaderFilter, setUploaderFilter] = useState<UploaderType | 'all'>('all');
  const [inTrash, setInTrash] = useState(false);
  const [activeAlbumId, setActiveAlbumId] = useState<string>('');
  const [loadingGallery, setLoadingGallery] = useState(false);
  const [galleryError, setGalleryError] = useState('');

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const sharingChanges = useRef(new Map<string, Pick<ImageItem, 'shareUrl' | 'shareThumbUrl'>>());
  const [dockMenu, setDockMenu] = useState<'move' | 'promote' | null>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<ImageItem | null>(null);
  const [promotingImage, setPromotingImage] = useState<ImageItem | null>(null);
  const [promoteTargetAlbumId, setPromoteTargetAlbumId] = useState<string>('');
  const promoteDialogRef = useRef<HTMLDivElement | null>(null);
  const promoteTitleId = useId();
  useModalDialog(Boolean(promotingImage), promoteDialogRef, () => setPromotingImage(null));

  const [creatingAlbum, setCreatingAlbum] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState('');
  const [editingAlbumId, setEditingAlbumId] = useState<string | null>(null);
  const [editingAlbumName, setEditingAlbumName] = useState('');
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);

  // Guest History State: strictly in-memory for current page session (clears on refresh)
  const [guestHistory, setGuestHistory] = useState<GuestHistoryItem[]>([]);

  const navigateTo = useCallback((nextPath: string, replace = false) => {
    const clean = normalizePath(nextPath);
    if (replace) {
      window.history.replaceState(null, '', clean);
    } else {
      window.history.pushState(null, '', clean);
    }
    setPathname(clean);
  }, []);

  useEffect(() => {
    try {
      localStorage.removeItem('lumepic_guest_history_v1');
    } catch {}
    const onPopState = () => setPathname(normalizePath(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('lumepic_theme', next ? 'dark' : 'light');
    } catch {}
  };

  const changeCopyFormat = (fmt: CopyFormat) => {
    setCopyFormat(fmt);
    try {
      localStorage.setItem('lumepic_copy_format', fmt);
    } catch {}
  };

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 240);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (selectedIds.size === 0) setDockMenu(null);
  }, [selectedIds.size]);

  useEffect(() => {
    if (!dockMenu) return;
    const onMouseDown = (e: MouseEvent) => {
      if (dockRef.current && !dockRef.current.contains(e.target as Node)) {
        setDockMenu(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDockMenu(null);
    };
    document.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [dockMenu]);

  const refreshPublicConfig = useCallback(async () => {
    setConfigError('');
    try {
      const cfg = await api.getPublicConfig();
      setConfig(cfg);
      document.title = `${cfg.siteTitle} · 极简私有图床`;
    } catch (err) {
      const message = err instanceof Error ? err.message : '无法连接服务器';
      setConfigError(message);
      push(message, 'error');
    }
  }, [push]);

  useEffect(() => {
    void refreshPublicConfig();
  }, [refreshPublicConfig]);

  useEffect(() => {
    const iconLink = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!iconLink) return;
    if (config?.siteIconUrl) {
      iconLink.href = config.siteIconUrl;
      iconLink.type = 'image/png';
    } else {
      iconLink.href = '/favicon.svg';
      iconLink.type = 'image/svg+xml';
    }
  }, [config?.siteIconUrl]);

  const isAdminRoute = pathname === '/admin' || pathname.startsWith('/admin/');
  const showAdminWorkspace = Boolean(
    config?.initialized && config?.isAdmin && (!config.allowGuestUpload || isAdminRoute)
  );
  const filterAlbum = inTrash ? '' : activeAlbumId;
  const viewKey = JSON.stringify([showAdminWorkspace, filterAlbum, debouncedSearch, uploaderFilter, inTrash]);
  const currentView = useRef(viewKey);
  const galleryReady = search === debouncedSearch && loadedViewKey === viewKey;
  const images = galleryReady ? storedImages : [];
  const totalImages = galleryReady ? storedTotal : 0;
  const selectedImagesList = images.filter((image) => selectedIds.has(image.id));

  useLayoutEffect(() => {
    currentView.current = viewKey;
    setSelectedIds(new Set());
    setDockMenu(null);
    setLightboxImage(null);
    setPromotingImage(null);
    setLoadingMore(false);
  }, [viewKey, search]);

  const fetchAdminData = useCallback(async () => {
    if (!showAdminWorkspace || currentView.current !== viewKey) return;
    galleryRequest.current?.abort();
    const request = new AbortController();
    galleryRequest.current = request;
    setLoadingGallery(true);
    setGalleryError('');
    setLoadingMore(false);
    try {
      const [imgRes, albRes] = await Promise.all([
        api.listImages({
          search: debouncedSearch || undefined,
          albumId: filterAlbum || undefined,
          uploaderType: uploaderFilter,
          trash: inTrash,
          limit: 120,
          signal: request.signal,
        }),
        api.listAlbums(request.signal),
      ]);
      if (request.signal.aborted || currentView.current !== viewKey) return;
      setImages(imgRes.items);
      setTotalImages(imgRes.total);
      setAlbums(albRes.items);
      setLoadedViewKey(viewKey);
      setSelectedIds((previous) => new Set(imgRes.items.filter((image) => previous.has(image.id)).map((image) => image.id)));
    } catch (err) {
      if (request.signal.aborted || currentView.current !== viewKey) return;
      if (err instanceof ApiError && err.status === 401) void refreshPublicConfig();
      setGalleryError(err instanceof Error ? err.message : '加载图库失败');
    } finally {
      if (!request.signal.aborted && galleryRequest.current === request) setLoadingGallery(false);
    }
  }, [debouncedSearch, filterAlbum, inTrash, push, refreshPublicConfig, showAdminWorkspace, uploaderFilter, viewKey]);

  const loadMoreImages = async () => {
    if (!galleryReady || loadingGallery || loadingMore || images.length >= totalImages) return;
    const request = galleryRequest.current;
    setLoadingMore(true);
    try {
      const res = await api.listImages({
        search: debouncedSearch || undefined,
        albumId: filterAlbum || undefined,
        uploaderType: uploaderFilter,
        trash: inTrash,
        limit: 80,
        offset: images.length,
        signal: request?.signal,
      });
      if (request?.signal.aborted || currentView.current !== viewKey || request !== galleryRequest.current) return;
      setImages((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        const extra = res.items.filter((i) => !seen.has(i.id));
        return [...prev, ...extra];
      });
      setTotalImages(res.total);
    } catch (err) {
      if (request?.signal.aborted || currentView.current !== viewKey) return;
      push(err instanceof Error ? err.message : '加载更多失败', 'error');
    } finally {
      if (request === galleryRequest.current && currentView.current === viewKey) setLoadingMore(false);
    }
  };

  useEffect(() => {
    if (showAdminWorkspace) void fetchAdminData();
    return () => galleryRequest.current?.abort();
  }, [fetchAdminData, showAdminWorkspace]);

  const handleGuestUploaded = useCallback((image: ImageItem) => {
    const entry: GuestHistoryItem = {
      id: image.id,
      filename: image.filename,
      originalName: image.originalName,
      mimeType: image.mimeType,
      width: image.width,
      height: image.height,
      sizeBytes: image.sizeBytes,
      thumbhash: image.thumbhash,
      url: image.url,
      thumbUrl: image.thumbUrl,
      expiresAt: image.expiresAt,
      createdAt: image.createdAt,
    };
    setGuestHistory((prev) => [entry, ...prev.filter((p) => p.id !== entry.id)]);
  }, []);

  const handleLogout = async () => {
    try {
      await api.logout();
      galleryRequest.current?.abort();
      setImages([]);
      sharingChanges.current.clear();
      setSelectedIds(new Set());
      setDockMenu(null);
      setSettingsOpen(false);
      setConfig((current) => current && { ...current, isAdmin: false });
      await refreshPublicConfig();
      push('已退出管理员登录', 'info');
    } catch (err) {
      push(err instanceof Error ? err.message : '退出登录失败', 'error');
    }
  };

  const handleToggleSelect = (id: string) => {
    if (!selectedIds.has(id) && selectedImagesList.length >= MAX_BATCH_IMAGES) {
      push(`每次最多选择 ${MAX_BATCH_IMAGES} 张图片`, 'info');
      return;
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleTrashOrDelete = async (img: ImageItem) => {
    const permanent = Boolean(img.deletedAt);
    if (
      permanent &&
      !(await confirm({
        title: `彻底删除「${img.originalName}」？`,
        description: '从回收站删除后无法恢复，若没有其他副本引用该文件也将从磁盘移除。',
        confirmLabel: '彻底删除',
        tone: 'danger',
      }))
    ) {
      return;
    }
    try {
      await api.deleteImage(img.id, permanent);
      void fetchAdminData();
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(img.id);
        return next;
      });
      if (lightboxImage?.id === img.id) setLightboxImage(null);
      push(permanent ? '已彻底删除' : '已移至回收站', 'success');
    } catch (err) {
      push(err instanceof Error ? err.message : '删除失败', 'error');
    }
  };

  const handleRestore = async (img: ImageItem) => {
    try {
      await api.batchImages('restore', [img.id]);
      void fetchAdminData();
      if (lightboxImage?.id === img.id) setLightboxImage(null);
      push('已从回收站恢复', 'success');
    } catch (err) {
      push(err instanceof Error ? err.message : '恢复失败', 'error');
    }
  };

  const handleUpdateImage = async (
    id: string,
    patch: { originalName?: string; albumId?: string | null; promoteToAdmin?: boolean }
  ) => {
    const res = await api.updateImage(id, patch);
    setLightboxImage((current) => current?.id === id ? res.image : current);
    await fetchAdminData();
  };

  const updateSharing = useCallback((items: ImageItem[]) => {
    const byId = new Map(items.map(({ id, shareUrl, shareThumbUrl }) => [id, { shareUrl, shareThumbUrl }]));
    for (const [id, links] of byId) sharingChanges.current.set(id, links);
    const update = (image: ImageItem) => {
      const links = byId.get(image.id);
      return links ? { ...image, ...links } : image;
    };
    setImages((previous) => previous.map(update));
    setLightboxImage((current) => current && update(current));
  }, []);

  const prepareImageCopy = useCallback(async (image: ImageItem): Promise<ImageItem | null> => {
    if (image.deletedAt) return null;
    const current = { ...image, ...sharingChanges.current.get(image.id) };
    if (current.shareUrl) return current;
    if (
      !(await confirm({
        title: '为这张图片重新生成公开外链？',
        description: '生成新的随机外链后，持有该链接的访客可查看此图片。',
        confirmLabel: '生成外链',
      }))
    ) {
      return null;
    }
    try {
      const { image: shared } = await api.setImageSharing(image.id, true);
      updateSharing([shared]);
      return shared;
    } catch (err) {
      push(err instanceof Error ? err.message : '无法生成外链', 'error');
      return null;
    }
  }, [confirm, push, updateSharing]);

  const handleRevokeSharing = async (image: ImageItem) => {
    if (
      !(await confirm({
        title: '撤销公开外链？',
        description: '撤销后已复制的旧链接将失效，图片仅保留在私有后台中。',
        confirmLabel: '撤销外链',
        tone: 'danger',
      }))
    ) {
      return;
    }
    try {
      const { image: updated } = await api.setImageSharing(image.id, false);
      updateSharing([updated]);
      push('已撤销外链', 'success');
    } catch (err) {
      push(err instanceof Error ? err.message : '撤销外链失败', 'error');
    }
  };

  const openPromoteModal = (img: ImageItem) => {
    setPromotingImage(img);
    setPromoteTargetAlbumId(activeAlbumId && activeAlbumId !== 'unassigned' ? activeAlbumId : '');
  };

  const confirmSinglePromote = async () => {
    if (!promotingImage) return;
    try {
      const targetAlbum = promoteTargetAlbumId || null;
      await handleUpdateImage(promotingImage.id, {
        promoteToAdmin: true,
        albumId: targetAlbum,
      });
      setPromotingImage(null);
      push('已转存到相册并生成管理员外链', 'success');
    } catch (err) {
      push(err instanceof Error ? err.message : '转存失败', 'error');
    }
  };

  const handleBatch = async (action: 'trash' | 'restore' | 'delete') => {
    const ids = selectedImagesList.map((image) => image.id);
    if (ids.length === 0) return;
    if (
      action === 'delete' &&
      !(await confirm({
        title: `彻底删除选中的 ${ids.length} 张图片？`,
        description: '该操作不可撤销，选中图片将从回收站永久销毁。',
        confirmLabel: '彻底删除',
        tone: 'danger',
      }))
    ) {
      return;
    }
    try {
      const { affected } = await api.batchImages(action, ids);
      setSelectedIds(new Set());
      setDockMenu(null);
      await fetchAdminData();
      push(
        action === 'trash'
          ? `已将 ${affected} 张图片移至回收站`
          : action === 'restore'
            ? `已恢复 ${affected} 张图片`
            : `已彻底删除 ${affected} 张图片`,
        'success'
      );
    } catch (err) {
      push(err instanceof Error ? err.message : '批量操作失败', 'error');
    }
  };

  const handleBatchMoveAlbum = async (albumId: string | null) => {
    const ids = selectedImagesList.map((image) => image.id);
    if (ids.length === 0) return;
    try {
      await api.batchImages('move', ids, albumId);
      setSelectedIds(new Set());
      setDockMenu(null);
      await fetchAdminData();
      push(albumId ? '已将选中图片移动到目标相册' : '已移动到未分类（默认图库）', 'success');
    } catch (err) {
      push(err instanceof Error ? err.message : '移动失败', 'error');
    }
  };

  const handleBatchPromote = async (albumId: string | null) => {
    const ids = selectedImagesList.filter((image) => image.uploaderType === 'guest').map((image) => image.id);
    if (ids.length === 0) return;
    try {
      const { affected } = await api.batchImages('promote', ids, albumId);
      setSelectedIds(new Set());
      setDockMenu(null);
      await fetchAdminData();
      push(`已将 ${affected} 张游客图片转存到相册`, 'success');
    } catch (err) {
      push(err instanceof Error ? err.message : '转存失败', 'error');
    }
  };

  const handleBatchDownload = async () => {
    const selected = selectedImagesList;
    if (selected.length === 0) return;
    if (selected.length === 1) {
      triggerSingleImageDownload(selected[0]!.url);
      return;
    }
    try {
      push('正在打包下载选中图片...', 'info');
      await api.downloadZip(selected.map((s) => s.id));
    } catch (err) {
      push(err instanceof Error ? err.message : '打包下载失败', 'error');
    }
  };

  const handleBatchCopy = async () => {
    if (selectedImagesList.length === 0) return;
    const unpublished = selectedImagesList.filter((image) => !image.shareUrl);
    if (
      unpublished.length &&
      !(await confirm({
        title: `为 ${unpublished.length} 张图片生成公开外链？`,
        description: '生成外链后，持有链接的访客可以查看这些图片。',
        confirmLabel: '生成并复制',
      }))
    ) {
      return;
    }
    try {
      const { items } = unpublished.length ? await api.shareImages(unpublished.map((image) => image.id)) : { items: [] };
      if (items.length) updateSharing(items);
      const shared = new Map(items.map((image) => [image.id, image.shareUrl]));
      const text = selectedImagesList.map((image) =>
        buildImageLink(image.shareUrl ?? shared.get(image.id)!, image.originalName, copyFormat)
      ).join('\n');
      if (await copyText(text)) push(`已复制 ${selectedImagesList.length} 条 ${copyFormat.toUpperCase()} 链接`, 'success');
      else push('未能写入剪贴板', 'error');
    } catch (err) {
      push(err instanceof Error ? err.message : '无法复制外链', 'error');
    }
  };

  const handleCreateAlbum = async () => {
    const trimmed = newAlbumName.trim();
    if (!trimmed) return;
    try {
      const res = await api.createAlbum(trimmed);
      setAlbums((prev) => [res.album, ...prev.filter((a) => a.id !== res.album.id)]);
      setNewAlbumName('');
      setCreatingAlbum(false);
      push(`已创建相册「${res.album.name}」`, 'success');
    } catch (err) {
      push(err instanceof Error ? err.message : '创建相册失败', 'error');
    }
  };

  const handleRenameAlbum = async () => {
    if (!editingAlbumId) return;
    const trimmed = editingAlbumName.trim();
    if (!trimmed) {
      setEditingAlbumId(null);
      return;
    }
    try {
      const res = await api.renameAlbum(editingAlbumId, trimmed);
      setAlbums((prev) => prev.map((a) => (a.id === editingAlbumId ? res.album : a)));
      setImages((prev) =>
        prev.map((img) =>
          img.albumId === editingAlbumId ? { ...img, albumName: res.album.name } : img
        )
      );
      setEditingAlbumId(null);
      push(`相册已重命名为「${res.album.name}」`, 'success');
    } catch (err) {
      push(err instanceof Error ? err.message : '重命名失败', 'error');
    }
  };

  // Loading Splash
  if (!config) {
    if (configError) return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-sm">
        <p role="alert">{configError}</p>
        <button type="button" onClick={() => void refreshPublicConfig()} className="rounded-xl border px-4 py-2">重试</button>
      </div>
    );
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-900 dark:border-zinc-700 dark:border-t-white" />
      </div>
    );
  }

  // 1. Setup OR Admin Login (/admin or private mode)
  if (!config.initialized || (!config.isAdmin && (!config.allowGuestUpload || isAdminRoute))) {
    return (
      <AuthCard
        config={config}
        onBackHome={
          config.allowGuestUpload && isAdminRoute ? () => navigateTo('/') : undefined
        }
        onAuthenticated={(next) => {
          setConfig(next);
          if (!isAdminRoute) navigateTo('/admin', true);
          push(config.initialized ? '欢迎回来' : '初始化完成，已进入私有图床', 'success');
        }}
      />
    );
  }

  // 2. Pure Guest Upload Homepage (at / when allowGuestUpload is ON; NO login icon in header)
  if (config.allowGuestUpload && !isAdminRoute) {
    return (
      <div className="bg-ambient-grid min-h-screen">
        <header className="sticky top-0 z-30 border-b border-zinc-200/70 bg-white/75 backdrop-blur-xl dark:border-white/[0.06] dark:bg-zinc-950/75">
          <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4 sm:px-6">
            <div className="flex items-center gap-2.5">
              <SiteIcon url={config.siteIconUrl} className="flex h-8 w-8 items-center justify-center rounded-xl bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">
                <Images className="h-4 w-4" />
              </SiteIcon>
              <span className="text-sm font-semibold tracking-tight">{config.siteTitle}</span>
            </div>

            <button
              type="button"
              onClick={toggleTheme}
              className="flex h-8 w-8 items-center justify-center rounded-xl border border-zinc-200/80 bg-white/80 text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-white/10"
              title="切换明暗主题"
            >
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
        </header>

        <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
          <UploadZone
            maxSizeMb={config.guestMaxSizeMb}
            copyFormat={copyFormat}
            onChangeCopyFormat={changeCopyFormat}
            onUploaded={handleGuestUploaded}
            onPrepareCopy={prepareImageCopy}
            isGuest
          />
          <GuestHistoryGrid items={guestHistory} copyFormat={copyFormat} />
        </main>
      </div>
    );
  }

  // 3. Full Admin Workspace
  const viewModeTabs: Array<{ id: string; label: string; uploader: UploaderType | 'all'; trash: boolean }> = [
    { id: 'all', label: '全部图片', uploader: 'all', trash: false },
    { id: 'admin', label: '仅我的', uploader: 'admin', trash: false },
    { id: 'guest', label: '游客上传', uploader: 'guest', trash: false },
    { id: 'trash', label: '回收站', uploader: 'all', trash: true },
  ];

  const activeTabId = inTrash ? 'trash' : uploaderFilter;
  const selectedHasGuest = selectedImagesList.some((i) => i.uploaderType === 'guest');

  return (
    <div className="bg-ambient-grid min-h-screen pb-28">
      {/* Top Navbar */}
      <header className="sticky top-0 z-30 border-b border-zinc-200/70 bg-white/75 backdrop-blur-xl dark:border-white/[0.06] dark:bg-zinc-950/75">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-2 px-3.5 sm:h-15 sm:gap-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <SiteIcon url={config.siteIconUrl} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">
              <Images className="h-4 w-4" />
            </SiteIcon>
            <span className="truncate text-sm font-semibold tracking-tight">{config.siteTitle}</span>

            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors sm:gap-1.5 sm:px-2.5 ${
                config.allowGuestUpload
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300'
                  : 'border-zinc-200/80 bg-zinc-100/80 text-zinc-600 hover:bg-zinc-200/70 dark:border-white/10 dark:bg-white/5 dark:text-zinc-400 dark:hover:bg-white/10'
              }`}
              title="点击快速调整游客上传开关"
            >
              {config.allowGuestUpload ? (
                <>
                  <Users className="h-3 w-3" />
                  <span className="sm:hidden">游客</span>
                  <span className="hidden sm:inline">游客可上传</span>
                </>
              ) : (
                <>
                  <Lock className="h-3 w-3" />
                  <span className="sm:hidden">仅管理员</span>
                  <span className="hidden sm:inline">仅管理员上传</span>
                </>
              )}
            </button>
          </div>

          <div className="flex flex-1 items-center justify-end gap-1.5 sm:gap-2">
            <div className="relative hidden w-full max-w-xs sm:block">
              <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索文件名..."
                className="w-full rounded-xl border border-zinc-200/80 bg-zinc-100/70 py-1.5 pr-7 pl-8 text-xs text-zinc-900 placeholder-zinc-400 outline-none transition-all focus:border-blue-500/60 focus:bg-white dark:border-white/10 dark:bg-white/[0.06] dark:text-zinc-100 dark:focus:bg-zinc-900"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute top-1/2 right-2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={() => setMobileSearchOpen((v) => !v)}
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border transition-colors sm:hidden ${
                mobileSearchOpen || search
                  ? 'border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400'
                  : 'border-zinc-200/80 bg-white/80 text-zinc-600 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-300'
              }`}
              title="搜索"
            >
              <Search className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={toggleTheme}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-zinc-200/80 bg-white/80 text-zinc-600 transition-colors hover:bg-zinc-100 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-white/10"
              title="切换主题"
            >
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>

            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-xl border border-zinc-200/80 bg-white/80 px-2.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 sm:px-3 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-white/10"
              title="设置"
            >
              <Settings className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">设置</span>
            </button>

            <button
              type="button"
              onClick={() => void handleLogout()}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-zinc-200/80 bg-white/80 text-zinc-500 transition-colors hover:bg-rose-500/10 hover:text-rose-500 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-400"
              title="退出登录"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {mobileSearchOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={SPRING_SNAPPY}
              className="overflow-hidden border-t border-zinc-200/60 px-3.5 py-2 sm:hidden dark:border-white/[0.06]"
            >
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <input
                  type="text"
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索文件名..."
                  className="w-full rounded-xl border border-zinc-200/80 bg-zinc-100/70 py-1.5 pr-7 pl-8 text-xs text-zinc-900 placeholder-zinc-400 outline-none focus:border-blue-500/60 focus:bg-white dark:border-white/10 dark:bg-white/[0.06] dark:text-zinc-100 dark:focus:bg-zinc-900"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    className="absolute top-1/2 right-2 -translate-y-1/2 text-zinc-400"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 pt-6 sm:px-6">
        {/* Upload Area (kept mounted when viewing Trash so in-progress uploads are not aborted) */}
        <div className={inTrash ? 'hidden' : undefined}>
          <UploadZone
            maxSizeMb={config.adminMaxSizeMb}
            albumId={activeAlbumId && activeAlbumId !== 'unassigned' ? activeAlbumId : null}
            copyFormat={copyFormat}
            onChangeCopyFormat={changeCopyFormat}
            onBatchUploaded={() => void fetchAdminData()}
            onPrepareCopy={prepareImageCopy}
            disabled={inTrash}
          />
        </div>

        {/* Filter & Album Controls */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center rounded-2xl border border-zinc-200/80 bg-white/80 p-1 dark:border-white/10 dark:bg-zinc-900/70">
              {viewModeTabs.map((tab) => {
                const active = activeTabId === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => {
                      setSelectedIds(new Set());
                      setUploaderFilter(tab.uploader);
                      setInTrash(tab.trash);
                    }}
                    className={`relative rounded-xl px-3 py-1 text-xs font-medium transition-colors ${
                      active
                        ? 'text-zinc-900 dark:text-white'
                        : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
                    }`}
                  >
                    {active && (
                      <motion.span
                        layoutId="gallery-mode-pill"
                        transition={SPRING_SNAPPY}
                        className="absolute inset-0 rounded-xl bg-zinc-100 dark:bg-white/10"
                      />
                    )}
                    <span className="relative z-10">{tab.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Album pills */}
            {!inTrash && (
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setEditingAlbumId(null);
                    setActiveAlbumId('');
                  }}
                  className={`rounded-xl px-2.5 py-1 text-xs font-medium transition-colors ${
                    activeAlbumId === ''
                      ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
                      : 'bg-zinc-100/80 text-zinc-600 hover:bg-zinc-200/80 dark:bg-white/5 dark:text-zinc-400 dark:hover:bg-white/10'
                  }`}
                >
                  全部相册
                </button>
                {albums.map((alb) => {
                  const isEditing = editingAlbumId === alb.id;
                  const isSelected = activeAlbumId === alb.id;
                  return (
                    <div key={alb.id} className="inline-flex items-center">
                      {isEditing ? (
                        <div className="flex items-center gap-1">
                          <input
                            type="text"
                            autoFocus
                            value={editingAlbumName}
                            onChange={(e) => setEditingAlbumName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void handleRenameAlbum();
                              if (e.key === 'Escape') setEditingAlbumId(null);
                            }}
                            className="w-24 rounded-xl border border-blue-500/60 bg-white px-2.5 py-1 text-xs text-zinc-900 outline-none dark:bg-zinc-900 dark:text-zinc-100"
                          />
                          <button
                            type="button"
                            onClick={() => void handleRenameAlbum()}
                            className="rounded-xl bg-blue-600 p-1.5 text-white"
                            title="保存相册名"
                          >
                            <Check className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingAlbumId(null)}
                            className="rounded-xl p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingAlbumId(null);
                              setActiveAlbumId(isSelected ? '' : alb.id);
                            }}
                            className={`rounded-xl px-2.5 py-1 text-xs font-medium transition-colors ${
                              isSelected
                                ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
                                : 'bg-zinc-100/80 text-zinc-600 hover:bg-zinc-200/80 dark:bg-white/5 dark:text-zinc-400 dark:hover:bg-white/10'
                            }`}
                          >
                            {alb.name}
                            <span className="ml-1 opacity-60">{alb.imageCount}</span>
                          </button>
                          {isSelected && (
                            <div className="ml-1 inline-flex items-center gap-0.5">
                              <button
                                type="button"
                                title="重命名相册"
                                onClick={() => {
                                  setEditingAlbumId(alb.id);
                                  setEditingAlbumName(alb.name);
                                }}
                                className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-200/70 hover:text-zinc-700 dark:hover:bg-white/10 dark:hover:text-zinc-200"
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                              <button
                                type="button"
                                title="删除此相册（不会删除图片本身）"
                                onClick={async () => {
                                  if (
                                    !(await confirm({
                                      title: `删除相册「${alb.name}」？`,
                                      description: '仅移除相册分类，相册内的图片本身会保留在全部图片中。',
                                      confirmLabel: '删除相册',
                                      tone: 'danger',
                                    }))
                                  ) {
                                    return;
                                  }
                                  try {
                                    await api.deleteAlbum(alb.id);
                                    setActiveAlbumId('');
                                    setAlbums((prev) => prev.filter((a) => a.id !== alb.id));
                                    push('已删除相册', 'success');
                                  } catch (error) {
                                    push(error instanceof Error ? error.message : '删除相册失败', 'error');
                                  }
                                }}
                                className="rounded-lg p-1 text-zinc-400 hover:bg-rose-500/10 hover:text-rose-500"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}

                {creatingAlbum ? (
                  <div className="flex items-center gap-1">
                    <input
                      type="text"
                      autoFocus
                      value={newAlbumName}
                      onChange={(e) => setNewAlbumName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleCreateAlbum();
                        if (e.key === 'Escape') setCreatingAlbum(false);
                      }}
                      placeholder="相册名..."
                      className="w-24 rounded-xl border border-blue-500/60 bg-white px-2.5 py-1 text-xs text-zinc-900 outline-none dark:bg-zinc-900 dark:text-zinc-100"
                    />
                    <button
                      type="button"
                      onClick={() => void handleCreateAlbum()}
                      className="rounded-xl bg-blue-600 px-2.5 py-1 text-xs font-medium text-white"
                    >
                      确定
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setCreatingAlbum(true)}
                    className="inline-flex items-center gap-1 rounded-xl border border-dashed border-zinc-300 px-2.5 py-1 text-xs text-zinc-500 transition-colors hover:border-zinc-400 hover:text-zinc-800 dark:border-white/15 dark:text-zinc-400 dark:hover:text-zinc-200"
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                    新相册
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 sm:justify-end">
            {images.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  if (selectedImagesList.length === Math.min(MAX_BATCH_IMAGES, images.length)) {
                    setSelectedIds(new Set());
                  } else {
                    if (images.length > MAX_BATCH_IMAGES) push(`已选择前 ${MAX_BATCH_IMAGES} 张图片`, 'info');
                    setSelectedIds(new Set(images.slice(0, MAX_BATCH_IMAGES).map((i) => i.id)));
                  }
                }}
                className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
              >
                <CheckSquare className="h-3.5 w-3.5" />
                {selectedImagesList.length === Math.min(MAX_BATCH_IMAGES, images.length) ? '取消全选' : '全选本页'}
              </button>
            )}
            <span className="font-mono text-xs text-zinc-400">共 {totalImages} 张</span>
          </div>
        </div>

        {/* Gallery */}
        {galleryError && images.length === 0 ? (
          <div className="rounded-3xl border border-zinc-200/70 p-8 text-center text-sm dark:border-white/[0.06]">
            <p role="alert">{galleryError}</p>
            <button type="button" onClick={() => void fetchAdminData()} className="mt-3 rounded-xl border px-4 py-2">重试</button>
          </div>
        ) : (loadingGallery || !galleryReady) && images.length === 0 ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 8 }).map((_, idx) => (
              <div
                key={idx}
                className="aspect-[4/3] animate-pulse rounded-2xl bg-zinc-200/70 dark:bg-white/[0.06]"
              />
            ))}
          </div>
        ) : images.length === 0 ? (
          <div className="rounded-3xl border border-zinc-200/70 bg-white/50 px-6 py-16 text-center dark:border-white/[0.06] dark:bg-zinc-900/30">
            <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">
              {inTrash ? '回收站是空的' : '这里还没有图片'}
            </p>
            <p className="mt-1 text-xs text-zinc-400">
              {inTrash
                ? '回收站最多保留 30 天，游客图片仍受原有效期约束'
                : '拖入或按 Ctrl+V 粘贴一张截图试试'}
            </p>
          </div>
        ) : (
          <GalleryGrid
            images={images}
            selectedIds={selectedIds}
            copyFormat={copyFormat}
            inTrash={inTrash}
            onToggleSelect={handleToggleSelect}
            onOpenLightbox={setLightboxImage}
            onPrepareCopy={prepareImageCopy}
            onTrashOrDelete={(img) => void handleTrashOrDelete(img)}
            onRestore={(img) => void handleRestore(img)}
            onPromoteGuest={openPromoteModal}
          />
        )}

        {images.length < totalImages && (
          <div className="flex justify-center pt-2">
            <button
              type="button"
              disabled={loadingMore}
              onClick={() => void loadMoreImages()}
              className="rounded-2xl border border-zinc-200/80 bg-white/80 px-5 py-2 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-60 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              {loadingMore
                ? '正在加载...'
                : `加载更多（已显示 ${images.length} / ${totalImages}）`}
            </button>
          </div>
        )}
      </main>

      {/* Floating Batch Dock with custom dark-mode-safe album popovers */}
      <AnimatePresence>
        {selectedImagesList.length > 0 && (
          <motion.div
            ref={dockRef}
            initial={{ opacity: 0, y: 36, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 28, scale: 0.96 }}
            transition={SPRING_SNAPPY}
            className="fixed bottom-4 left-1/2 z-40 flex w-[calc(100%-24px)] max-w-fit -translate-x-1/2 flex-wrap items-center justify-center gap-1.5 rounded-2xl border border-zinc-200/90 bg-white/95 px-3.5 py-2.5 shadow-2xl shadow-black/15 backdrop-blur-2xl sm:bottom-5 sm:gap-2 sm:px-4 dark:border-white/15 dark:bg-zinc-900/95"
          >
            <span className="mr-1 font-mono text-xs font-semibold text-zinc-900 dark:text-white">
              已选 {selectedImagesList.length} 张
            </span>

            {!inTrash ? (
              <>
                <button
                  type="button"
                  onClick={() => void handleBatchCopy()}
                  className="inline-flex items-center gap-1 rounded-xl bg-zinc-100 px-2.5 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-200 sm:px-3 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
                >
                  <Copy className="h-3.5 w-3.5" />
                  复制
                </button>

                <button
                  type="button"
                  onClick={() => void handleBatchDownload()}
                  className="inline-flex items-center gap-1 rounded-xl bg-zinc-100 px-2.5 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-200 sm:px-3 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
                >
                  <Download className="h-3.5 w-3.5" />
                  {selectedImagesList.length > 1 ? '打包下载' : '下载'}
                </button>

                {/* Move selected images to chosen album */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setDockMenu((m) => (m === 'move' ? null : 'move'))}
                    className="inline-flex items-center gap-1 rounded-xl bg-zinc-100 px-2.5 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-200 sm:px-3 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
                  >
                    <FolderInput className="h-3.5 w-3.5" />
                    移动到相册
                    <ChevronDown className="h-3 w-3 opacity-60" />
                  </button>

                  <AnimatePresence>
                    {dockMenu === 'move' && (
                      <motion.div
                        initial={{ opacity: 0, y: 8, scale: 0.96 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 6, scale: 0.96 }}
                        transition={SPRING_SNAPPY}
                        className="absolute bottom-full left-0 mb-2 w-48 overflow-hidden rounded-2xl border border-zinc-200 bg-white p-1.5 shadow-xl dark:border-white/15 dark:bg-zinc-900"
                      >
                        <button
                          type="button"
                          onClick={() => void handleBatchMoveAlbum(null)}
                          className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-xs text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                        >
                          <span>未分类（默认图库）</span>
                        </button>
                        {albums.map((a) => (
                          <button
                            key={a.id}
                            type="button"
                            onClick={() => void handleBatchMoveAlbum(a.id)}
                            className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-xs text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
                          >
                            <span className="truncate">{a.name}</span>
                            <span className="font-mono text-[10px] text-zinc-400">{a.imageCount}</span>
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Promote selected guest images to chosen admin album */}
                {selectedHasGuest && (
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setDockMenu((m) => (m === 'promote' ? null : 'promote'))}
                      className="inline-flex items-center gap-1 rounded-xl bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-blue-500 sm:px-3"
                    >
                      <BookmarkPlus className="h-3.5 w-3.5" />
                      转存到相册
                      <ChevronDown className="h-3 w-3 opacity-75" />
                    </button>

                    <AnimatePresence>
                      {dockMenu === 'promote' && (
                        <motion.div
                          initial={{ opacity: 0, y: 8, scale: 0.96 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: 6, scale: 0.96 }}
                          transition={SPRING_SNAPPY}
                          className="absolute right-0 bottom-full mb-2 w-52 overflow-hidden rounded-2xl border border-zinc-200 bg-white p-1.5 shadow-xl dark:border-white/15 dark:bg-zinc-900"
                        >
                          <p className="px-3 py-1.5 text-[10px] text-zinc-400">
                            复制到管理员图库，游客原链接和有效期保留
                          </p>
                          <button
                            type="button"
                            onClick={() => void handleBatchPromote(null)}
                            className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-xs text-zinc-700 hover:bg-blue-500/10 hover:text-blue-600 dark:text-zinc-200 dark:hover:text-blue-400"
                          >
                            <span>默认图库</span>
                          </button>
                          {albums.map((a) => (
                            <button
                              key={a.id}
                              type="button"
                              onClick={() => void handleBatchPromote(a.id)}
                              className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-xs text-zinc-700 hover:bg-blue-500/10 hover:text-blue-600 dark:text-zinc-200 dark:hover:text-blue-400"
                            >
                              <span className="truncate">{a.name}</span>
                              <span className="font-mono text-[10px] text-zinc-400">
                                {a.imageCount}
                              </span>
                            </button>
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => void handleBatch('trash')}
                  className="inline-flex items-center gap-1 rounded-xl bg-rose-500/15 px-2.5 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-500/25 sm:px-3 dark:text-rose-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  删除
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => void handleBatch('restore')}
                  className="inline-flex items-center gap-1 rounded-xl bg-emerald-500/15 px-3 py-1.5 text-xs font-medium text-emerald-600 hover:bg-emerald-500/25 dark:text-emerald-400"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  恢复
                </button>
                <button
                  type="button"
                  onClick={() => void handleBatch('delete')}
                  className="inline-flex items-center gap-1 rounded-xl bg-rose-500/15 px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-500/25 dark:text-rose-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  彻底删除
                </button>
              </>
            )}

            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="rounded-xl p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              title="取消选择"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Single-Card Promote Guest Image Modal */}
      <AnimatePresence>
        {promotingImage && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-xs"
            onClick={(e) => {
              if (e.target === e.currentTarget) setPromotingImage(null);
            }}
          >
            <motion.div
              ref={promoteDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={promoteTitleId}
              tabIndex={-1}
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={SPRING_GENTLE}
              className="w-full max-w-sm rounded-3xl border border-zinc-200 bg-white p-5 shadow-2xl outline-none dark:border-white/10 dark:bg-zinc-900"
            >
              <div className="flex items-center justify-between">
                <h3 id={promoteTitleId} className="flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  <BookmarkPlus className="h-4 w-4 text-blue-500" />
                  转存游客图片到相册
                </h3>
                <button
                  type="button"
                  onClick={() => setPromotingImage(null)}
                  aria-label="关闭"
                  className="rounded-full p-1 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                转存会生成独立的管理员外链。游客原链接和有效期保留。
              </p>

              <div className="mt-4 space-y-1.5 max-h-52 overflow-y-auto">
                <button
                  type="button"
                  onClick={() => setPromoteTargetAlbumId('')}
                  className={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-xs transition-colors ${
                    promoteTargetAlbumId === ''
                      ? 'border-blue-500 bg-blue-500/10 font-medium text-blue-600 dark:text-blue-400'
                      : 'border-zinc-200/80 text-zinc-700 hover:bg-zinc-50 dark:border-white/10 dark:text-zinc-200 dark:hover:bg-zinc-800'
                  }`}
                >
                  <span>默认图库（不归入相册）</span>
                  {promoteTargetAlbumId === '' && <Check className="h-3.5 w-3.5" />}
                </button>
                {albums.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setPromoteTargetAlbumId(a.id)}
                    className={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left text-xs transition-colors ${
                      promoteTargetAlbumId === a.id
                        ? 'border-blue-500 bg-blue-500/10 font-medium text-blue-600 dark:text-blue-400'
                        : 'border-zinc-200/80 text-zinc-700 hover:bg-zinc-50 dark:border-white/10 dark:text-zinc-200 dark:hover:bg-zinc-800'
                    }`}
                  >
                    <span className="truncate">{a.name}</span>
                    {promoteTargetAlbumId === a.id && <Check className="h-3.5 w-3.5" />}
                  </button>
                ))}
              </div>

              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setPromotingImage(null)}
                  className="rounded-xl px-3 py-1.5 text-xs font-medium text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void confirmSinglePromote()}
                  className="rounded-xl bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
                >
                  确认转存
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Lightbox */}
      <Lightbox
        image={lightboxImage}
        images={images}
        albums={albums}
        copyFormat={copyFormat}
        onClose={() => setLightboxImage(null)}
        onNavigate={setLightboxImage}
        onUpdateImage={handleUpdateImage}
        onTrashOrDelete={handleTrashOrDelete}
        onRestore={handleRestore}
        onPrepareCopy={prepareImageCopy}
        onRevokeSharing={(image) => void handleRevokeSharing(image)}
      />

      {/* Settings Drawer */}
      <SettingsDrawer
        open={settingsOpen}
        siteIconUrl={config.siteIconUrl}
        onClose={() => setSettingsOpen(false)}
        onConfigChanged={(next) => {
          setConfig(next);
          document.title = `${next.siteTitle} · 极简私有图床`;
        }}
        onMaintenanceDone={() => void fetchAdminData()}
      />
    </div>
  );
}

export function App() {
  return (
    <MotionConfig reducedMotion="user">
      <ToastProvider>
        <ConfirmProvider>
          <WorkspaceApp />
        </ConfirmProvider>
      </ToastProvider>
    </MotionConfig>
  );
}
