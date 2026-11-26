import { AnimatePresence, motion } from 'motion/react';
import { Copy } from 'lucide-react';
import type { GuestHistoryItem } from '../lib/api';
import { buildImageLink, copyText, formatBytes, formatRelativeDate, type CopyFormat } from '../lib/format';
import { SPRING_SNAPPY } from '../lib/motion';
import { decodeThumbHashUrl } from '../lib/thumbhash';
import { useToast } from './Toast';

interface GuestHistoryGridProps {
  items: GuestHistoryItem[];
  copyFormat: CopyFormat;
}

export function GuestHistoryGrid({ items, copyFormat }: GuestHistoryGridProps) {
  const { push } = useToast();

  if (items.length === 0) {
    return (
      <div className="mt-8 rounded-3xl border border-zinc-200/70 bg-white/50 px-6 py-12 text-center dark:border-white/[0.06] dark:bg-zinc-900/30">
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          暂无上传记录
        </p>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          上传后的图片外链会临时显示在这里，刷新页面后记录自动清空
        </p>
      </div>
    );
  }

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between px-1">
        <h2 className="text-xs font-semibold tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
          本次上传 ({items.length})
        </h2>
        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">刷新页面后不再显示</span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <AnimatePresence mode="popLayout">
          {items.map((item) => {
            const thumbBg = decodeThumbHashUrl(item.thumbhash);
            return (
              <motion.div
                key={item.id}
                layout
                initial={{ opacity: 0, y: 8, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.93 }}
                transition={SPRING_SNAPPY}
                className="group overflow-hidden rounded-2xl border border-zinc-200/80 bg-white/85 shadow-xs dark:border-white/10 dark:bg-zinc-900/80"
              >
                <div
                  className="relative aspect-[16/10] w-full overflow-hidden bg-zinc-100 dark:bg-zinc-800"
                  style={
                    thumbBg
                      ? { backgroundImage: `url(${thumbBg})`, backgroundSize: 'cover' }
                      : undefined
                  }
                >
                  <img
                    src={item.thumbUrl}
                    alt={item.originalName}
                    draggable={false}
                    className="h-full w-full object-cover transition-transform duration-300 select-none group-hover:scale-[1.03]"
                  />
                </div>

                <div className="flex items-center justify-between gap-2 p-3">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-zinc-800 dark:text-zinc-100">
                      {item.originalName}
                    </p>
                    <p className="mt-0.5 font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                      {item.width}×{item.height} · {formatBytes(item.sizeBytes)} ·{' '}
                      {formatRelativeDate(item.createdAt)}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={async () => {
                      const text = buildImageLink(item.url, item.originalName, copyFormat);
                      if (await copyText(text)) {
                        push(`已复制 ${copyFormat.toUpperCase()}`, 'success');
                      }
                    }}
                    className="inline-flex shrink-0 items-center gap-1 rounded-xl bg-zinc-100 px-3 py-1.5 text-[11px] font-medium text-zinc-700 transition-colors hover:bg-blue-500 hover:text-white dark:bg-white/10 dark:text-zinc-200 dark:hover:bg-blue-500 dark:hover:text-white"
                  >
                    <Copy className="h-3 w-3" />
                    复制
                  </button>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </section>
  );
}
