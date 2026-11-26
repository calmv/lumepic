import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { BookmarkPlus, Check, Copy, Download, RotateCcw, Trash2 } from 'lucide-react';
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
      const rowHeight = Math.min(targetRowHeight * 1.45, Math.max(146, availableWidth / ratioSum));
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
  measuredWidth,
  measuredHeight,
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
  measuredWidth: number;
  measuredHeight: number;
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
  const suppressResetTimer = useRef<number | null>(null);
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);
  const suppressClick = useRef(false);

  const buttonCount = !inTrash
    ? image.uploaderType === 'guest' && onPromoteGuest
      ? 4
      : 3
    : onRestore
      ? 2
      : 1;
  const isShortCard = measuredHeight < (buttonCount >= 4 ? 144 : 116);
  const splitMetaLines = measuredWidth < 165;

  const clearLongPress = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    touchStartPos.current = null;
  };

  useEffect(
    () => () => {
      clearLongPress();
      if (suppressResetTimer.current !== null) {
        window.clearTimeout(suppressResetTimer.current);
      }
    },
    []
  );

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

  const btnSize = isShortCard ? 'h-6 w-6' : 'h-7 w-7';
  const iconSize = `${isShortCard ? 'h-3 w-3' : 'h-3.5 w-3.5'} pointer-events-none shrink-0`;
  const btnShared = `pointer-events-none flex ${btnSize} shrink-0 items-center justify-center rounded-full border bg-clip-padding opacity-0 shadow-xs backdrop-blur-md transition-all duration-150 hover:scale-105 active:scale-95 [@media(hover:hover)]:group-hover:pointer-events-auto [@media(hover:hover)]:group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 dark:shadow-black/30`;
  const btnSurface =
    'border-zinc-900/12 bg-white/82 text-zinc-700 dark:border-white/18 dark:bg-zinc-900/68 dark:text-zinc-100';
  const btnNeutralHover =
    'hover:border-zinc-900/22 hover:bg-white hover:text-zinc-950 dark:hover:border-white/35 dark:hover:bg-zinc-800/95 dark:hover:text-white';
  const btnPromoteHover =
    'hover:border-blue-500 hover:bg-blue-500 hover:text-white dark:hover:border-blue-400 dark:hover:bg-blue-500 dark:hover:text-white';
  const btnRestoreHover =
    'hover:border-emerald-500 hover:bg-emerald-500 hover:text-white dark:hover:border-emerald-400 dark:hover:bg-emerald-500 dark:hover:text-white';
  const btnDangerHover =
    'hover:border-rose-500 hover:bg-rose-500 hover:text-white dark:hover:border-rose-400 dark:hover:bg-rose-500 dark:hover:text-white';

  const actionButtons = (
    <>
      {!inTrash ? (
        <>
          <button
            type="button"
            onClick={handleCopy}
            title={`复制 ${copyFormat.toUpperCase()}`}
            className={`${btnShared} ${btnSurface} ${btnNeutralHover}`}
          >
            {copied ? (
              <Check strokeWidth={2.25} className={`${iconSize} text-emerald-600 dark:text-emerald-400`} />
            ) : (
              <Copy strokeWidth={2} className={iconSize} />
            )}
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              triggerSingleImageDownload(image.url);
            }}
            title="下载原图"
            className={`${btnShared} ${btnSurface} ${btnNeutralHover}`}
          >
            <Download strokeWidth={2} className={iconSize} />
          </button>
          {image.uploaderType === 'guest' && onPromoteGuest && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onPromoteGuest(image);
              }}
              title="复制到我的相册并生成新外链"
              className={`${btnShared} ${btnSurface} ${btnPromoteHover}`}
            >
              <BookmarkPlus strokeWidth={2} className={iconSize} />
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
            className={`${btnShared} ${btnSurface} ${btnRestoreHover}`}
          >
            <RotateCcw strokeWidth={2} className={iconSize} />
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
        className={`${btnShared} ${btnSurface} ${btnDangerHover}`}
      >
        <Trash2 strokeWidth={2} className={iconSize} />
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
        if (suppressResetTimer.current !== null) {
          window.clearTimeout(suppressResetTimer.current);
          suppressResetTimer.current = null;
        }
        suppressClick.current = false;
        if ((e.pointerType !== 'touch' && e.pointerType !== 'pen') || selectionActive) return;
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
      onPointerUp={() => {
        clearLongPress();
        if (suppressClick.current) {
          suppressResetTimer.current = window.setTimeout(() => {
            suppressClick.current = false;
            suppressResetTimer.current = null;
          }, 400);
        }
      }}
      onPointerCancel={() => {
        clearLongPress();
        suppressClick.current = false;
      }}
      onPointerLeave={clearLongPress}
      onContextMenu={(e) => {
        if (suppressClick.current || !window.matchMedia('(hover: hover)').matches) {
          e.preventDefault();
        }
      }}
      onClick={(e) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          if (suppressResetTimer.current !== null) {
            window.clearTimeout(suppressResetTimer.current);
            suppressResetTimer.current = null;
          }
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

      {/* Top-left selection checkbox (light/dark theme matched; hidden on mobile until selectionActive) */}
      <div
        className={`pointer-events-none absolute z-20 ${
          isShortCard ? 'top-1.5 left-1.5' : 'top-2 left-2'
        }`}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect(image.id);
          }}
          aria-label="选择图片"
          className={`flex h-6 w-6 items-center justify-center rounded-full border bg-clip-padding shadow-xs backdrop-blur-md transition-all duration-150 ${
            selected
              ? 'pointer-events-auto border-blue-600 bg-blue-600 text-white opacity-100 dark:border-blue-500 dark:bg-blue-500'
              : selectionActive
                ? 'pointer-events-auto border-zinc-900/20 bg-white/62 text-zinc-800 opacity-100 hover:border-zinc-900/35 hover:bg-white/80 dark:border-white/65 dark:bg-zinc-900/68 dark:text-white dark:hover:bg-zinc-800/90'
                : 'pointer-events-none border-zinc-900/18 bg-white/55 text-zinc-800 opacity-0 hover:scale-105 hover:border-zinc-900/32 hover:bg-white/75 [@media(hover:hover)]:group-hover:pointer-events-auto [@media(hover:hover)]:group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 dark:border-white/55 dark:bg-zinc-900/65 dark:text-white dark:hover:border-white/80 dark:hover:bg-zinc-800/90'
          }`}
        >
          {selected && <Check className="h-3.5 w-3.5" strokeWidth={2.5} />}
        </button>
      </div>

      {/* Desktop hover bottom metadata with ultra-faint white gradient in light mode & soft shadow in dark mode */}
      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-white/22 via-white/7 to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-within:opacity-100 dark:from-black/50 dark:via-black/18 dark:to-transparent [@media(hover:none)]:hidden ${
          isShortCard
            ? 'pt-4 pr-9 pb-1.5 pl-2'
            : measuredWidth < 110
              ? 'pt-5 pr-10 pb-2 pl-2'
              : 'pt-5 pr-11 pb-2 pl-2.5'
        }`}
      >
        <div className="min-w-0">
          <p
            className={`truncate font-medium text-zinc-900 dark:text-white dark:[text-shadow:0_1px_3px_rgba(0,0,0,0.7)] ${
              measuredWidth < 130 ? 'text-[11px] leading-tight' : 'text-xs leading-snug'
            }`}
          >
            {image.originalName}
          </p>
          {splitMetaLines ? (
            <>
              <p className="truncate font-mono text-[9.5px] leading-tight text-zinc-700 dark:text-zinc-200 dark:[text-shadow:0_1px_2px_rgba(0,0,0,0.7)]">
                {image.width}×{image.height}
              </p>
              <p className="truncate font-mono text-[9.5px] leading-tight text-zinc-700 dark:text-zinc-200/90 dark:[text-shadow:0_1px_2px_rgba(0,0,0,0.7)]">
                {formatBytes(image.sizeBytes)}
              </p>
            </>
          ) : (
            <p className="truncate font-mono text-[10px] leading-snug text-zinc-700 dark:text-zinc-200 dark:[text-shadow:0_1px_2px_rgba(0,0,0,0.7)]">
              {image.width}×{image.height} · {formatBytes(image.sizeBytes)}
            </p>
          )}
        </div>
      </div>

      {/* Desktop hover action buttons: always vertical along the bottom-right edge */}
      <div
        className={`pointer-events-none absolute z-20 flex flex-col items-center [@media(hover:none)]:hidden ${
          isShortCard ? 'right-1.5 bottom-1.5 gap-1' : 'right-2 bottom-2 gap-[5px]'
        }`}
      >
        {actionButtons}
      </div>
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
  const mobileSquareSize = containerWidth > 0 ? Math.max(80, (containerWidth - 10) / 2) : 140;

  return (
    <div ref={containerRef} className="w-full">
      {isMobile || containerWidth === 0 ? (
        <div className="grid grid-cols-2 gap-2.5">
          <AnimatePresence mode="popLayout">
            {images.map((img) => (
              <GalleryCard
                key={img.id}
                image={img}
                measuredWidth={mobileSquareSize}
                measuredHeight={mobileSquareSize}
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
                  measuredWidth={width}
                  measuredHeight={height}
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
