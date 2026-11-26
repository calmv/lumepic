import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  BookmarkPlus,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  Info,
  Link2Off,
  RotateCcw,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { AlbumItem, ImageItem } from '../../shared/types';
import { triggerSingleImageDownload } from '../lib/api';
import {
  buildImageLink,
  copyText,
  formatBytes,
  formatDateTime,
  type CopyFormat,
} from '../lib/format';
import { isTopModal, useMediaQuery, useModalDialog } from '../lib/modal';
import { SPRING_GENTLE, SPRING_SNAPPY } from '../lib/motion';
import { useToast } from './Toast';

interface LightboxProps {
  image: ImageItem | null;
  images: ImageItem[];
  albums: AlbumItem[];
  copyFormat: CopyFormat;
  onClose: () => void;
  onNavigate: (next: ImageItem) => void;
  onUpdateImage: (
    id: string,
    patch: { originalName?: string; albumId?: string | null; promoteToAdmin?: boolean }
  ) => Promise<void>;
  onTrashOrDelete: (image: ImageItem) => Promise<void>;
  onRestore?: (image: ImageItem) => Promise<void>;
  onPrepareCopy: (image: ImageItem) => Promise<ImageItem | null>;
  onRevokeSharing: (image: ImageItem) => void;
}

const FORMATS: Array<{ id: CopyFormat; label: string }> = [
  { id: 'url', label: '直链 URL' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'html', label: 'HTML' },
  { id: 'bbcode', label: 'BBCode' },
];

export function Lightbox({
  image,
  images,
  albums,
  copyFormat,
  onClose,
  onNavigate,
  onUpdateImage,
  onTrashOrDelete,
  onRestore,
  onPrepareCopy,
  onRevokeSharing,
}: LightboxProps) {
  const { push } = useToast();
  const isMobile = useMediaQuery('(max-width: 767px)');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [showInfo, setShowInfo] = useState(true);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [dragX, setDragX] = useState(0);
  const [slideDir, setSlideDir] = useState<-1 | 0 | 1>(0);
  const [copiedFmt, setCopiedFmt] = useState<CopyFormat | null>(null);
  const [editingName, setEditingName] = useState('');
  const [promoteAlbumId, setPromoteAlbumId] = useState<string>('');
  const touchSession = useRef<{
    startX: number;
    startY: number;
    startTime: number;
    axis: 'x' | 'y' | null;
    dx: number;
  } | null>(null);
  const didSwipeRef = useRef(false);

  const modalId = useModalDialog(Boolean(image), containerRef, () => {
    if (isMobile && mobileSheetOpen) setMobileSheetOpen(false);
    else onClose();
  });

  useEffect(() => {
    if (!isMobile) setMobileSheetOpen(false);
  }, [isMobile]);

  useEffect(() => {
    if (!image) {
      setImmersive(false);
      setSlideDir(0);
    }
    setZoomed(false);
    setDragX(0);
    setMobileSheetOpen(false);
    setEditingName(image?.originalName ?? '');
    setPromoteAlbumId(image?.albumId ?? '');
  }, [image?.id, image?.originalName, image?.albumId]);

  const currentIdx = image ? images.findIndex((i) => i.id === image.id) : -1;
  const prevImg = currentIdx > 0 ? images[currentIdx - 1] : null;
  const nextImg = currentIdx >= 0 && currentIdx < images.length - 1 ? images[currentIdx + 1] : null;

  const navigateWithDirection = (target: ImageItem, dir: -1 | 1) => {
    setSlideDir(dir);
    setDragX(0);
    onNavigate(target);
  };

  useEffect(() => {
    if (!image) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isTopModal(modalId)) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
      if (e.key === 'ArrowLeft' && prevImg) navigateWithDirection(prevImg, -1);
      if (e.key === 'ArrowRight' && nextImg) navigateWithDirection(nextImg, 1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [image, modalId, nextImg, onNavigate, prevImg]);

  const handleCopyFormat = async (fmt: CopyFormat) => {
    if (!image) return;
    const shared = await onPrepareCopy(image);
    if (!shared?.shareUrl) return;
    const text = buildImageLink(shared.shareUrl, shared.originalName, fmt);
    if (await copyText(text)) {
      setCopiedFmt(fmt);
      push(`已复制 ${fmt.toUpperCase()}`, 'success');
      setTimeout(() => setCopiedFmt(null), 1400);
    } else {
      push('未能写入剪贴板', 'error');
    }
  };

  const commitName = async () => {
    if (!image) return;
    const trimmed = editingName.trim();
    if (trimmed && trimmed !== image.originalName) {
      try {
        await onUpdateImage(image.id, { originalName: trimmed });
        push('文件名已更新', 'success');
      } catch (error) {
        push(error instanceof Error ? error.message : '文件名更新失败', 'error');
      }
    }
  };

  const handlePromote = async () => {
    if (!image) return;
    try {
      await onUpdateImage(image.id, { promoteToAdmin: true, albumId: promoteAlbumId || null });
      push('已转存到管理员图库并生成新外链', 'success');
    } catch (error) {
      push(error instanceof Error ? error.message : '转存失败', 'error');
    }
  };

  const renderInspectorBody = () => {
    if (!image) return null;
    return (
      <div className="space-y-5">
        <div>
          <label className="text-[11px] font-medium tracking-wider text-zinc-400 uppercase">
            图片名称
          </label>
          <input
            type="text"
            value={editingName}
            onChange={(e) => setEditingName(e.target.value)}
            onBlur={() => void commitName()}
            onKeyDown={(e) => e.key === 'Enter' && void commitName()}
            className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-xs text-white outline-none transition-colors focus:border-blue-400"
          />
        </div>

        {/* Promote Guest Image to Admin Album */}
        {image.uploaderType === 'guest' && !image.deletedAt && (
          <div className="rounded-2xl border border-blue-500/30 bg-blue-500/10 p-3.5">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-blue-300">
              <BookmarkPlus className="h-3.5 w-3.5" />
              游客图片 · 可转存到我的相册
            </p>
            <p className="mt-1 text-[11px] text-zinc-300">
              转存会生成独立的管理员外链。游客原链接和有效期保留。
            </p>
            <div className="mt-2.5 flex gap-2">
              <select
                value={promoteAlbumId}
                onChange={(e) => setPromoteAlbumId(e.target.value)}
                style={{ colorScheme: 'dark' }}
                className="flex-1 rounded-xl border border-white/15 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-100 outline-none focus:border-blue-400"
              >
                <option value="" className="bg-zinc-900 text-zinc-100">默认图库</option>
                {albums.map((a) => (
                  <option key={a.id} value={a.id} className="bg-zinc-900 text-zinc-100">
                    {a.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void handlePromote()}
                className="shrink-0 rounded-xl bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500"
              >
                确认转存
              </button>
            </div>
          </div>
        )}

        {/* Multi-format link copy */}
        {!image.deletedAt && <div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium tracking-wider text-zinc-400 uppercase">一键复制外链</span>
            {image.shareUrl && (
              <button type="button" onClick={() => onRevokeSharing(image)}
                title="撤销外链" aria-label="撤销外链"
                className="rounded-lg p-1 text-zinc-400 transition-colors hover:bg-white/10 hover:text-white">
                <Link2Off className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="mt-2 space-y-2">
            {FORMATS.map((fmt) => {
              const linkVal = image.shareUrl ? buildImageLink(image.shareUrl, image.originalName, fmt.id) : '复制后生成外链';
              const isCopied = copiedFmt === fmt.id;
              return (
                <div
                  key={fmt.id}
                  className="group flex items-center justify-between gap-2 rounded-xl border border-white/8 bg-black/25 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-[10px] font-medium text-zinc-400">{fmt.label}</p>
                    <p className="truncate font-mono text-[11px] text-zinc-200">{linkVal}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleCopyFormat(fmt.id)}
                    aria-label={`复制 ${fmt.label}`}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/10 text-zinc-200 transition-colors hover:bg-blue-500 hover:text-white"
                  >
                    {isCopied ? (
                      <Check className="h-3.5 w-3.5 text-emerald-300" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </div>}

        {/* Album assignment */}
        <div>
          <label className="flex items-center gap-1.5 text-[11px] font-medium tracking-wider text-zinc-400 uppercase">
            <FolderOpen className="h-3.5 w-3.5" />
            所属相册
          </label>
          <select
            value={image.albumId ?? ''}
            style={{ colorScheme: 'dark' }}
            onChange={(e) =>
              void onUpdateImage(image.id, {
                albumId: e.target.value ? e.target.value : null,
              })
            }
            className="mt-1.5 w-full rounded-xl border border-white/10 bg-zinc-800 px-3 py-2 text-xs text-zinc-100 outline-none focus:border-blue-400"
          >
            <option value="" className="bg-zinc-900 text-zinc-100">未分类（默认）</option>
            {albums.map((a) => (
              <option key={a.id} value={a.id} className="bg-zinc-900 text-zinc-100">
                {a.name}
              </option>
            ))}
          </select>
        </div>

        {/* Metadata */}
        <div className="space-y-2 rounded-2xl border border-white/8 bg-black/20 p-3.5 text-xs">
          <div className="flex justify-between text-zinc-400">
            <span>分辨率</span>
            <span className="font-mono text-zinc-200">
              {image.width} × {image.height}
            </span>
          </div>
          <div className="flex justify-between text-zinc-400">
            <span>文件大小</span>
            <span className="font-mono text-zinc-200">{formatBytes(image.sizeBytes)}</span>
          </div>
          <div className="flex justify-between text-zinc-400">
            <span>MIME 格式</span>
            <span className="font-mono text-zinc-200">{image.mimeType}</span>
          </div>
          <div className="flex justify-between text-zinc-400">
            <span>上传来源</span>
            <span className="text-zinc-200">
              {image.uploaderType === 'guest' ? '游客上传' : '管理员'}
            </span>
          </div>
          <div className="flex justify-between text-zinc-400">
            <span>上传时间</span>
            <span className="text-zinc-200">{formatDateTime(image.createdAt)}</span>
          </div>
          {image.expiresAt && (
            <div className="flex justify-between text-zinc-400">
              <span>到期自动清理</span>
              <span className="text-amber-300">{formatDateTime(image.expiresAt)}</span>
            </div>
          )}
        </div>

        {/* Optional Camera EXIF */}
        {image.exif && (
          <div className="space-y-1.5 rounded-2xl border border-white/8 bg-black/20 p-3.5 text-xs">
            <p className="mb-1 flex items-center gap-1.5 font-medium text-zinc-300">
              <Camera className="h-3.5 w-3.5 text-blue-400" />
              相机参数 (EXIF)
            </p>
            {(image.exif.make || image.exif.model) && (
              <p className="text-zinc-300">
                {[image.exif.make, image.exif.model].filter(Boolean).join(' ')}
              </p>
            )}
            <p className="font-mono text-[11px] text-zinc-400">
              {[
                image.exif.focalLength ? `${image.exif.focalLength}mm` : null,
                image.exif.fNumber ? `f/${image.exif.fNumber}` : null,
                image.exif.exposureTime ?? null,
                image.exif.iso ? `ISO ${image.exif.iso}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
        )}
      </div>
    );
  };

  const renderFooterActions = () => {
    if (!image) return null;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => triggerSingleImageDownload(image.url)}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-white px-3 py-2 text-xs font-medium text-zinc-900 transition-colors hover:bg-zinc-200"
        >
          <Download className="h-3.5 w-3.5" />
          下载图片
        </button>

        <a
          href={image.url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-zinc-200 transition-colors hover:bg-white/10"
          title="新窗口打开"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>

        {image.deletedAt && onRestore && (
          <button
            type="button"
            onClick={() => void onRestore(image)}
            className="flex items-center justify-center gap-1.5 rounded-xl bg-emerald-500/20 px-3 py-2 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-500/30"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            恢复
          </button>
        )}

        <button
          type="button"
          onClick={() => void onTrashOrDelete(image)}
          className="flex items-center justify-center gap-1.5 rounded-xl bg-rose-500/20 px-3 py-2 text-xs font-medium text-rose-300 transition-colors hover:bg-rose-500/30"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {image.deletedAt ? '彻底删除' : '删除'}
        </button>
      </div>
    );
  };

  return (
    <AnimatePresence>
      {image && (
        <motion.div
          ref={containerRef}
          role="dialog"
          aria-modal="true"
          aria-label={`图片预览：${image.originalName}`}
          tabIndex={-1}
          key="lightbox-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className={`fixed inset-0 z-50 flex backdrop-blur-xl outline-none transition-colors duration-200 ${
            immersive ? 'bg-black/96' : 'bg-zinc-950/90'
          }`}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              if (immersive) setImmersive(false);
              else onClose();
            }
          }}
        >
          {/* Main Viewer Area */}
          <div
            className={`relative flex flex-1 touch-pan-y flex-col items-center justify-center overflow-hidden transition-[padding] duration-200 ${
              immersive ? 'p-2 sm:p-6' : 'p-4 pb-20 sm:p-8 md:pb-8'
            }`}
            onTouchStart={(e) => {
              if (mobileSheetOpen || zoomed || e.touches.length !== 1) {
                touchSession.current = null;
                return;
              }
              const target = e.target as HTMLElement | null;
              if (target?.closest('button, a, input, select, textarea')) return;
              const t = e.touches[0]!;
              didSwipeRef.current = false;
              touchSession.current = {
                startX: t.clientX,
                startY: t.clientY,
                startTime: Date.now(),
                axis: null,
                dx: 0,
              };
            }}
            onTouchMove={(e) => {
              const session = touchSession.current;
              if (!session || e.touches.length !== 1) {
                if (touchSession.current) {
                  touchSession.current = null;
                  setDragX(0);
                }
                return;
              }
              const t = e.touches[0]!;
              const dx = t.clientX - session.startX;
              const dy = t.clientY - session.startY;
              if (!session.axis) {
                if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
                session.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
                if (session.axis === 'x') didSwipeRef.current = true;
              }
              if (session.axis !== 'x') return;
              session.dx = dx;
              const hasNeighbor = (dx < 0 && Boolean(nextImg)) || (dx > 0 && Boolean(prevImg));
              setDragX(hasNeighbor ? dx : dx * 0.25);
            }}
            onTouchEnd={() => {
              const session = touchSession.current;
              touchSession.current = null;
              if (!session || session.axis !== 'x') {
                setDragX(0);
                return;
              }
              const dt = Math.max(1, Date.now() - session.startTime);
              const vx = session.dx / dt;
              const shouldSwitch = Math.abs(session.dx) > 48 || (Math.abs(session.dx) > 20 && Math.abs(vx) > 0.32);
              if (shouldSwitch && session.dx < 0 && nextImg) {
                navigateWithDirection(nextImg, 1);
              } else if (shouldSwitch && session.dx > 0 && prevImg) {
                navigateWithDirection(prevImg, -1);
              } else {
                setDragX(0);
              }
              window.setTimeout(() => {
                didSwipeRef.current = false;
              }, 60);
            }}
            onTouchCancel={() => {
              touchSession.current = null;
              setDragX(0);
            }}
            onClick={(e) => {
              if (didSwipeRef.current) return;
              if (e.target === e.currentTarget) {
                if (immersive) setImmersive(false);
                else onClose();
              }
            }}
          >
            {/* Top floating bar (hidden in pure/immersive mode) */}
            <AnimatePresence initial={false}>
              {!immersive && (
                <motion.div
                  initial={{ opacity: 0, y: -12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -12 }}
                  transition={{ duration: 0.18 }}
                  className="pointer-events-none absolute inset-x-3 top-3 z-10 flex items-center justify-between gap-2 sm:inset-x-4 sm:top-4"
                >
                  <div className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-full border border-white/10 bg-black/45 px-3 py-1.5 text-xs text-zinc-200 backdrop-blur-md">
                    <span className="max-w-[135px] truncate font-medium sm:max-w-48">
                      {image.originalName}
                    </span>
                    <span className="hidden text-zinc-500 sm:inline">·</span>
                    <span className="hidden font-mono text-[11px] text-zinc-400 sm:inline">
                      {image.width}×{image.height}
                    </span>
                  </div>

                  <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => triggerSingleImageDownload(image.url)}
                      className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-black/45 text-zinc-200 backdrop-blur-md transition-colors hover:bg-white/15"
                      title="下载图片"
                    >
                      <Download className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setZoomed((z) => !z)}
                      className="hidden h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-black/45 text-zinc-200 backdrop-blur-md transition-colors hover:bg-white/15 sm:flex"
                      title={zoomed ? '还原比例' : '放大查看'}
                    >
                      {zoomed ? <ZoomOut className="h-4 w-4" /> : <ZoomIn className="h-4 w-4" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (isMobile) {
                          setMobileSheetOpen((v) => !v);
                        } else {
                          setShowInfo((v) => !v);
                        }
                      }}
                      className={`flex h-9 w-9 items-center justify-center rounded-full border border-white/10 backdrop-blur-md transition-colors ${
                        (isMobile ? mobileSheetOpen : showInfo)
                          ? 'bg-white text-zinc-900'
                          : 'bg-black/45 text-zinc-200 hover:bg-white/15'
                      }`}
                      title="显示/隐藏详情"
                    >
                      <Info className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={onClose}
                      className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-black/45 text-zinc-200 backdrop-blur-md transition-colors hover:bg-white/15"
                      title="关闭 (Esc)"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Desktop Prev / Next arrows (hidden on mobile in favor of finger swipe, and hidden in pure mode) */}
            {!immersive && prevImg && (
              <button
                type="button"
                onClick={() => navigateWithDirection(prevImg, -1)}
                className="absolute left-4 z-10 hidden h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-black/45 text-white backdrop-blur-md transition-transform hover:scale-105 hover:bg-black/70 md:flex"
                title="上一张 (←)"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
            )}
            {!immersive && nextImg && (
              <button
                type="button"
                onClick={() => navigateWithDirection(nextImg, 1)}
                className="absolute right-4 z-10 hidden h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-black/45 text-white backdrop-blur-md transition-transform hover:scale-105 hover:bg-black/70 md:flex"
                title="下一张 (→)"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            )}

            {/* Image with swipe drag follow & click-to-toggle pure immersive view */}
            <motion.img
              key={image.id}
              layoutId={slideDir === 0 ? `image-media-${image.id}` : undefined}
              src={image.url}
              alt={image.originalName}
              draggable={false}
              style={{ WebkitTouchCallout: 'none' }}
              onClick={() => {
                if (didSwipeRef.current) return;
                if (mobileSheetOpen) {
                  setMobileSheetOpen(false);
                  return;
                }
                setImmersive((v) => !v);
              }}
              initial={slideDir !== 0 ? { opacity: 0.35, x: slideDir * 64 } : false}
              animate={{ opacity: 1, x: dragX, scale: zoomed ? 1.55 : 1 }}
              transition={dragX !== 0 ? { duration: 0 } : SPRING_GENTLE}
              className={`max-w-full cursor-pointer rounded-xl object-contain shadow-2xl select-none ${
                immersive ? 'max-h-[94vh]' : 'max-h-[75vh] sm:max-h-[84vh]'
              }`}
            />

            {/* Mobile quick-action bar at bottom (hidden in pure/immersive mode) */}
            <AnimatePresence initial={false}>
              {!immersive && (
                <motion.div
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 16 }}
                  transition={{ duration: 0.18 }}
                  className="fixed inset-x-3 bottom-3 z-20 flex items-center justify-between gap-2 rounded-2xl border border-white/10 bg-zinc-900/90 px-3 py-2 backdrop-blur-xl md:hidden"
                >
                  {!image.deletedAt && <button
                    type="button"
                    onClick={() => void handleCopyFormat(copyFormat)}
                    className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-blue-600 px-3 py-2 text-xs font-medium text-white"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    复制 {copyFormat.toUpperCase()}
                  </button>}
                  <button
                    type="button"
                    onClick={() => triggerSingleImageDownload(image.url)}
                    className="inline-flex items-center justify-center gap-1 rounded-xl bg-white/10 px-3 py-2 text-xs font-medium text-zinc-100"
                  >
                    <Download className="h-3.5 w-3.5" />
                    下载
                  </button>
                  <button
                    type="button"
                    onClick={() => setMobileSheetOpen(true)}
                    className="inline-flex items-center justify-center gap-1 rounded-xl bg-white/10 px-3 py-2 text-xs font-medium text-zinc-100"
                  >
                    <Info className="h-3.5 w-3.5" />
                    详情
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Desktop Right Info Sidebar (also hides during pure/immersive mode) */}
          <AnimatePresence initial={false}>
            {showInfo && !immersive && (
              <motion.aside
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: 340, opacity: 0.98 }}
                exit={{ width: 0, opacity: 0 }}
                transition={SPRING_SNAPPY}
                className="hidden h-full shrink-0 overflow-hidden border-l border-white/10 bg-zinc-900/95 text-zinc-100 md:block"
              >
                <div className="flex h-full w-[340px] flex-col justify-between overflow-y-auto p-5">
                  {renderInspectorBody()}
                  <div className="mt-5 border-t border-white/10 pt-4">
                    {renderFooterActions()}
                  </div>
                </div>
              </motion.aside>
            )}
          </AnimatePresence>

          {/* Mobile Bottom Sheet Inspector */}
          <AnimatePresence>
            {mobileSheetOpen && (
              <>
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={() => setMobileSheetOpen(false)}
                  className="fixed inset-0 z-30 bg-black/50 md:hidden"
                />
                <motion.div
                  initial={{ y: '100%' }}
                  animate={{ y: 0 }}
                  exit={{ y: '100%' }}
                  transition={SPRING_GENTLE}
                  className="fixed inset-x-0 bottom-0 z-40 flex max-h-[82vh] flex-col rounded-t-3xl border-t border-white/10 bg-zinc-900 text-zinc-100 md:hidden"
                >
                  <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
                    <span className="text-xs font-semibold">图片详情与操作</span>
                    <button
                      type="button"
                      onClick={() => setMobileSheetOpen(false)}
                      className="rounded-full p-1 text-zinc-400 hover:bg-white/10"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-5">{renderInspectorBody()}</div>
                  <div className="border-t border-white/10 p-4">{renderFooterActions()}</div>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
