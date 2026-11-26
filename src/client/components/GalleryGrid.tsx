import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { BookmarkPlus, Check, Copy, Download, RotateCcw, Trash2, UserCheck } from 'lucide-react';
import type { ImageItem } from '../../shared/types';
import { triggerSingleImageDownload } from '../lib/api';
import { buildImageLink, copyText, formatBytes, type CopyFormat } from '../lib/format';
import { SPRING_SNAPPY } from '../lib/motion';
import { decodeThumbHashUrl } from '../lib/thumbhash';
import { useToast } from './Toast';

interface GalleryGridProps {
  images: ImageItem[];
  selectedIds: Set<string>;
  copyFormat: CopyFormat;
  inTrash?: boolean;
  onToggleSelect: (id: string) => void;
  onOpenLightbox: (image: ImageItem) => void;
  onPrepareCopy: (image: ImageItem) => Promise<ImageItem | null>;
  onTrashOrDelete: (image: ImageItem) => void;
  onRestore?: (image: ImageItem) => void;
  onPromoteGuest?: (image: ImageItem) => void;
}

interface JustifiedRow {
  items: Array<{
    image: ImageItem;
    width: number;
    height: number;
  }>;
}

function buildJustifiedRows(
  images: ImageItem[],
  containerWidth: number,
  targetRowHeight: number,
  gap: number
): JustifiedRow[] {
  if (containerWidth <= 0 || images.length === 0) return [];
  const rows: JustifiedRow[] = [];
  let current: Array<{ image: ImageItem; ratio: number }> = [];
  let ratioSum = 0;

  for (const image of images) {
    const rawRatio = image.width > 0 && image.height > 0 ? image.width / image.height : 1.33;
    const ratio = Math.min(2.6, Math.max(0.52, rawRatio));
    current.push({ image, ratio });
    ratioSum += ratio;

    const totalGaps = Math.max(0, current.length - 1) * gap;
    const estimatedWidth = ratioSum * targetRowHeight + totalGaps;

    if (estimatedWidth >= containerWidth) {
      const availableWidth = containerWidth - totalGaps;
      const rowHeight = Math.min(targetRowHeight * 1.45, Math.max(130, availableWidth / ratioSum));
      rows.push({
        items: current.map((entry) => ({
          image: entry.image,
          width: entry.ratio * rowHeight,
          height: rowHeight,
        })),
      });
      current = [];
      ratioSum = 0;
    }
  }

  if (current.length > 0) {
    const totalGaps = Math.max(0, current.length - 1) * gap;
    const maxNaturalWidth = ratioSum * targetRowHeight + totalGaps;
    const rowHeight =
      maxNaturalWidth > containerWidth
        ? (containerWidth - totalGaps) / ratioSum
        : targetRowHeight;
    rows.push({
      items: current.map((entry) => ({
        image: entry.image,
        width: entry.ratio * rowHeight,
        height: rowHeight,
      })),
    });
  }

  return rows;
}

function GalleryCard({
  image,
  width,
  height,
  selected,
  selectionActive,
  copyFormat,
  inTrash,
  onToggleSelect,
  onOpenLightbox,
  onPrepareCopy,
  onTrashOrDelete,
  onRestore,
  onPromoteGuest,
}: {
  image: ImageItem;
  width?: number;
  height?: number;
  selected: boolean;
  selectionActive: boolean;
  copyFormat: CopyFormat;
  inTrash?: boolean;
  onToggleSelect: (id: string) => void;
  onOpenLightbox: (image: ImageItem) => void;
  onPrepareCopy: (image: ImageItem) => Promise<ImageItem | null>;
  onTrashOrDelete: (image: ImageItem) => void;
  onRestore?: (image: ImageItem) => void;
  onPromoteGuest?: (image: ImageItem) => void;
}) {
  const { push } = useToast();
  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState(false);
  const thumbPlaceholder = useMemo(() => decodeThumbHashUrl(image.thumbhash), [image.thumbhash]);
  const longPressTimer = useRef<number | null>(null);
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(false);

  const isNarrow = width !== undefined && width < 195;
  const isVeryNarrow = width !== undefined && width < 130;

  const clearLongPress = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    touchStartPos.current = null;
  };

  useEffect(() => clearLongPress, []);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const shared = await onPrepareCopy(image);
    if (!shared?.shareUrl) return;
    const link = buildImageLink(shared.shareUrl, shared.originalName, copyFormat);
    if (await copyText(link)) {
      setCopied(true);
      push(`已复制 ${copyFormat.toUpperCase()} 链接`, 'success');
      setTimeout(() => setCopied(false), 1400);
    } else {
      push('未能写入剪贴板', 'error');
    }
  };

  const btnBase = isNarrow
    ? 'flex h-7 w-7 items-center justify-center rounded-full border border-white/15 bg-black/50 text-white backdrop-blur-md transition-colors hover:bg-black/75'
    : 'flex h-7 w-7 items-center justify-center rounded-full bg-white/20 text-white backdrop-blur-md transition-colors hover:bg-white/35';

  const actionButtons = (
    <>
      {!inTrash ? (
        <>
          <button
            type="button"
            onClick={handleCopy}
            title={`复制 ${copyFormat.toUpperCase()}`}
            className={btnBase}
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              triggerSingleImageDownload(image.url);
            }}
            title="下载原图"
            className={btnBase}
          >
            <Download className="h-3.5 w-3.5" />
          </button>
          {image.uploaderType === 'guest' && onPromoteGuest && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onPromoteGuest(image);
              }}
              title="复制到我的相册并生成新外链"
              className={`${btnBase} hover:bg-blue-500/85`}
            >
              <BookmarkPlus className="h-3.5 w-3.5" />
            </button>
          )}
        </>
      ) : (
        onRestore && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRestore(image);
            }}
            title="恢复图片"
            className={`${btnBase} hover:bg-emerald-500/80`}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        )
      )}

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onTrashOrDelete(image);
        }}
        title={inTrash ? '彻底删除' : '移至回收站'}
        className={`${btnBase} hover:bg-rose-500/85`}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </>
  );

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={SPRING_SNAPPY}
      style={{
        ...(width && height ? { width, height } : {}),
        WebkitTouchCallout: 'none',
      }}
      onPointerDown={(e) => {
        if ((e.pointerType !== 'touch' && e.pointerType !== 'pen') || selectionActive) return;
        suppressClick.current = false;
        touchStartPos.current = { x: e.clientX, y: e.clientY };
        clearLongPress();
        touchStartPos.current = { x: e.clientX, y: e.clientY };
        longPressTimer.current = window.setTimeout(() => {
          longPressTimer.current = null;
          suppressClick.current = true;
          navigator.vibrate?.(15);
          onToggleSelect(image.id);
        }, 380);
      }}
      onPointerMove={(e) => {
        if (!touchStartPos.current) return;
        if (Math.hypot(e.clientX - touchStartPos.current.x, e.clientY - touchStartPos.current.y) > 10) {
          clearLongPress();
        }
      }}
      onPointerUp={clearLongPress}
      onPointerCancel={clearLongPress}
      onPointerLeave={clearLongPress}
      onContextMenu={(e) => {
        if (suppressClick.current || !window.matchMedia('(hover: hover)').matches) {
          e.preventDefault();
        }
      }}
      onClick={(e) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (selectionActive) {
          onToggleSelect(image.id);
        } else {
          onOpenLightbox(image);
        }
      }}
      className={`group relative cursor-pointer overflow-hidden rounded-2xl border bg-zinc-100 select-none dark:bg-zinc-900 ${
        width && height ? 'shrink-0' : 'aspect-square w-full'
      } ${
        selected
          ? 'border-blue-500 ring-2 ring-blue-500/40'
          : 'border-zinc-200/70 dark:border-white/[0.08]'
      }`}
    >
      {/* ThumbHash blurred instant background */}
      {thumbPlaceholder && (
        <img
          src={thumbPlaceholder}
          alt=""
          aria-hidden="true"
          draggable={false}
          className={`pointer-events-none absolute inset-0 h-full w-full scale-105 object-cover transition-opacity duration-300 ${
            loaded ? 'opacity-0' : 'opacity-100'
          }`}
        />
      )}

      {/* Actual 400w WebP thumbnail */}
      <motion.img
        layoutId={`image-media-${image.id}`}
        src={image.thumbUrl}
        alt={image.originalName}
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={() => setLoaded(true)}
        className={`pointer-events-none h-full w-full object-cover transition-all duration-300 group-hover:scale-[1.03] ${
          loaded ? 'opacity-100' : 'opacity-0'
        }`}
      />

      {/* Top bar: selection checkbox (hidden on mobile until selectionActive) + guest badge */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-2 sm:p-2.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect(image.id);
          }}
          aria-label="选择图片"
          className={`flex h-6 w-6 items-center justify-center rounded-full border backdrop-blur-md transition-all ${
            selected
              ? 'pointer-events-auto scale-100 border-blue-500 bg-blue-500 text-white opacity-100'
              : selectionActive
                ? 'pointer-events-auto scale-100 border-white/75 bg-black/40 text-white opacity-100'
                : 'pointer-events-none scale-90 border-white/50 bg-black/30 text-white opacity-0 [@media(hover:hover)]:group-hover:pointer-events-auto [@media(hover:hover)]:group-hover:scale-100 [@media(hover:hover)]:group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100'
          }`}
        >
          {selected && <Check className="h-3.5 w-3.5" strokeWidth={2.5} />}
        </button>

        {image.uploaderType === 'guest' && (
          <span
            className={`inline-flex items-center gap-1 rounded-full border border-white/20 bg-black/45 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-md transition-opacity ${
              isNarrow ? 'group-hover:opacity-0' : ''
            }`}
          >
            <UserCheck className="h-2.5 w-2.5" />
            {!isVeryNarrow && '游客'}
          </span>
        )}
      </div>

      {/* Desktop hover scrim & actions (hidden on touch devices; vertical rail on narrow portrait cards) */}
      {isNarrow ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/75 via-black/15 to-transparent p-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:hidden">
          <div className="pointer-events-none absolute right-2 bottom-2 flex flex-col items-center gap-1.5 group-hover:pointer-events-auto focus-within:pointer-events-auto">
            {actionButtons}
          </div>
          {!isVeryNarrow && (
            <div className="min-w-0 pr-9">
              <p className="truncate text-[11px] font-medium text-white">{image.originalName}</p>
              <p className="truncate font-mono text-[10px] text-white/75">{formatBytes(image.sizeBytes)}</p>
            </div>
          )}
        </div>
      ) : (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/75 via-black/30 to-transparent p-2.5 pt-8 opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:hidden">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-white">{image.originalName}</p>
            <p className="font-mono text-[10px] text-white/75">
              {image.width}×{image.height} · {formatBytes(image.sizeBytes)}
            </p>
          </div>

          <div className="pointer-events-none flex shrink-0 items-center gap-1 group-hover:pointer-events-auto focus-within:pointer-events-auto">
            {actionButtons}
          </div>
        </div>
      )}
    </motion.div>
  );
}

export function GalleryGrid({
  images,
  selectedIds,
  copyFormat,
  inTrash = false,
  onToggleSelect,
  onOpenLightbox,
  onPrepareCopy,
  onTrashOrDelete,
  onRestore,
  onPromoteGuest,
}: GalleryGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const isMobile = containerWidth > 0 && containerWidth < 560;
  const gap = 12;
  const rows = useMemo(() => {
    if (isMobile || containerWidth === 0) return [];
    const targetHeight = containerWidth > 1080 ? 225 : 195;
    return buildJustifiedRows(images, containerWidth, targetHeight, gap);
  }, [containerWidth, images, isMobile]);

  const selectionActive = selectedIds.size > 0;

  return (
    <div ref={containerRef} className="w-full">
      {isMobile || containerWidth === 0 ? (
        <div className="grid grid-cols-2 gap-2.5">
          <AnimatePresence mode="popLayout">
            {images.map((img) => (
              <GalleryCard
                key={img.id}
                image={img}
                selected={selectedIds.has(img.id)}
                selectionActive={selectionActive}
                copyFormat={copyFormat}
                inTrash={inTrash}
                onToggleSelect={onToggleSelect}
                onOpenLightbox={onOpenLightbox}
                onPrepareCopy={onPrepareCopy}
                onTrashOrDelete={onTrashOrDelete}
                onRestore={onRestore}
                onPromoteGuest={onPromoteGuest}
              />
            ))}
          </AnimatePresence>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((row, rIdx) => (
            <div key={rIdx} className="flex items-stretch gap-3">
              {row.items.map(({ image, width, height }) => (
                <GalleryCard
                  key={image.id}
                  image={image}
                  width={width}
                  height={height}
                  selected={selectedIds.has(image.id)}
                  selectionActive={selectionActive}
                  copyFormat={copyFormat}
                  inTrash={inTrash}
                  onToggleSelect={onToggleSelect}
                  onOpenLightbox={onOpenLightbox}
                  onPrepareCopy={onPrepareCopy}
                  onTrashOrDelete={onTrashOrDelete}
                  onRestore={onRestore}
                  onPromoteGuest={onPromoteGuest}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
