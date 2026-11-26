import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, Clipboard, Copy, ImagePlus, Loader2, UploadCloud, X } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { getImagePickerAccept } from '../lib/filePicker';
import { buildImageLink, copyText, formatBytes, type CopyFormat } from '../lib/format';
import { hasOpenModal } from '../lib/modal';
import { SPRING_GENTLE, SPRING_SNAPPY } from '../lib/motion';
import type { ImageItem } from '../../shared/types';
import { useToast } from './Toast';

interface QueueItem {
  localId: string;
  name: string;
  file?: File;
  previewUrl: string;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  error?: string;
  retryAfter?: number;
  image?: ImageItem;
}

interface UploadTask {
  localId: string;
  file: File;
  linkIndex: number;
  albumId?: string | null;
  isGuest: boolean;
}

interface UploadTransfer {
  links: Array<{ url: string; name: string } | null>;
  uploaded: number;
}

interface UploadZoneProps {
  maxSizeMb: number;
  albumId?: string | null;
  copyFormat: CopyFormat;
  onChangeCopyFormat: (fmt: CopyFormat) => void;
  onUploaded?: (image: ImageItem) => void;
  onBatchUploaded?: () => void;
  onPrepareCopy: (image: ImageItem) => Promise<ImageItem | null>;
  isGuest?: boolean;
  disabled?: boolean;
}

const ALLOWED_TYPE = /^image\/(?:jpeg|png|webp|avif|gif)$/i;
const MAX_QUEUE_SIZE = 24;
const PARALLEL_UPLOADS = 2;
const MAX_RETRIES = 3;

function waitForRetry(seconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const abort = () => {
      window.clearTimeout(timer);
      resolve(false);
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve(true);
    }, seconds * 1000);
    signal.addEventListener('abort', abort, { once: true });
  });
}

const FORMAT_LABELS: Array<{ id: CopyFormat; label: string }> = [
  { id: 'markdown', label: 'Markdown' },
  { id: 'url', label: '直链 URL' },
  { id: 'html', label: 'HTML' },
  { id: 'bbcode', label: 'BBCode' },
];

export function UploadZone({
  maxSizeMb,
  albumId,
  copyFormat,
  onChangeCopyFormat,
  onUploaded,
  onBatchUploaded,
  onPrepareCopy,
  isGuest = false,
  disabled = false,
}: UploadZoneProps) {
  const { push } = useToast();
  const [isDraggingWindow, setIsDraggingWindow] = useState(false);
  const [isHoverZone, setIsHoverZone] = useState(false);
  const [autoCopy, setAutoCopy] = useState<boolean>(() => {
    try {
      return localStorage.getItem('lumepic_auto_copy') !== 'false';
    } catch {
      return true;
    }
  });
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const dragCounter = useRef(0);
  const internalDragRef = useRef(false);
  const previewUrls = useRef(new Set<string>());
  const activeControllers = useRef(new Set<AbortController>());
  const waitingUploads = useRef<UploadTask[]>([]);
  const currentTransfer = useRef<UploadTransfer | null>(null);
  const settings = useRef({ autoCopy, copyFormat, onUploaded, onBatchUploaded, push });
  settings.current = { autoCopy, copyFormat, onUploaded, onBatchUploaded, push };

  useEffect(() => {
    const visible = new Set(queue.map((item) => item.previewUrl));
    for (const url of previewUrls.current) {
      if (!visible.has(url)) {
        URL.revokeObjectURL(url);
        previewUrls.current.delete(url);
      }
    }
  }, [queue]);

  useEffect(() => () => {
    currentTransfer.current = null;
    waitingUploads.current.length = 0;
    for (const controller of activeControllers.current) controller.abort();
    activeControllers.current.clear();
    for (const url of previewUrls.current) URL.revokeObjectURL(url);
    previewUrls.current.clear();
  }, []);

  const toggleAutoCopy = () => {
    const next = !autoCopy;
    setAutoCopy(next);
    try {
      localStorage.setItem('lumepic_auto_copy', String(next));
    } catch {}
  };

  const drainQueue = useCallback(function drain() {
    const transfer = currentTransfer.current;
    if (!transfer) return;
    while (activeControllers.current.size < PARALLEL_UPLOADS) {
      const task = waitingUploads.current.shift();
      if (!task) break;
      const controller = new AbortController();
      activeControllers.current.add(controller);
      const update = (patch: Partial<QueueItem>) => setQueue((previous) => previous.map((row) =>
        row.localId === task.localId ? { ...row, ...patch } : row));
      void (async () => {
        try {
          let image: ImageItem;
          for (let retry = 0; ; retry++) {
            try {
              const result = await api.uploadImage(task.file, {
                albumId: task.albumId,
                isGuest: task.isGuest,
                signal: controller.signal,
                onProgress: (progress) => update({ progress }),
              });
              image = result.image;
              break;
            } catch (error) {
              if (controller.signal.aborted) return;
              const delay = error instanceof ApiError && error.status === 429 ? error.retryAfterSeconds : undefined;
              if (!delay || delay > 120 || retry >= MAX_RETRIES) throw error;
              update({ progress: 0, retryAfter: delay });
              if (!await waitForRetry(delay, controller.signal)) return;
              update({ retryAfter: undefined });
            }
          }
          if (controller.signal.aborted) return;
          update({ progress: 100, status: 'done', image, file: undefined });
          if (image.shareUrl) transfer.links[task.linkIndex] = { url: image.shareUrl, name: image.originalName };
          transfer.uploaded++;
          settings.current.onUploaded?.(image);
        } catch (error) {
          if (controller.signal.aborted) return;
          const message = error instanceof Error ? error.message : '上传失败';
          update({ status: 'error', error: message });
          settings.current.push(message, 'error');
        } finally {
          activeControllers.current.delete(controller);
          drain();
        }
      })();
    }

    if (activeControllers.current.size > 0) return;
    currentTransfer.current = null;
    if (transfer.uploaded === 0) return;
    const { autoCopy, copyFormat, onBatchUploaded, push } = settings.current;
    onBatchUploaded?.();
    const links = transfer.links.flatMap((link) => link ? [buildImageLink(link.url, link.name, copyFormat)] : []);
    if (autoCopy && links.length) {
      void copyText(links.join('\n')).catch(() => false).then((copied) => {
        if (copied) push(`已上传 ${transfer.uploaded} 张图片并复制 ${links.length} 条公开外链`, 'success');
        else push(`已上传 ${transfer.uploaded} 张图片（浏览器拦截了自动复制，请点右侧复制）`, 'info');
      });
    } else {
      push(`已上传 ${transfer.uploaded} 张图片`, 'success');
    }
  }, []);

  const handleFiles = useCallback(
    (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      if (files.length > MAX_QUEUE_SIZE) {
        push(`每批最多选择 ${MAX_QUEUE_SIZE} 张图片`, 'error');
        return;
      }
      const supported = files.filter((file) => ALLOWED_TYPE.test(file.type) ||
        /\.(?:jpe?g|png|webp|avif|gif)$/i.test(file.name));
      const maxBytes = maxSizeMb * 1024 * 1024;
      const accepted = supported.filter((file) => file.size > 0 && file.size <= maxBytes);
      if (accepted.length !== files.length || accepted.length === 0) {
        push(`仅上传格式受支持且大小不超过 ${maxSizeMb} MB 的非空图片`, 'error');
      }
      if (accepted.length === 0) return;

      const available = MAX_QUEUE_SIZE - waitingUploads.current.length - activeControllers.current.size;
      const incoming = accepted.slice(0, available);
      if (incoming.length < accepted.length) {
        push(incoming.length
          ? `已追加 ${incoming.length} 张图片，队列空出后可继续添加`
          : '上传队列已满，请稍后追加图片', 'info');
      }
      if (!incoming.length) return;
      const transfer = currentTransfer.current ??= { links: [], uploaded: 0 };
      const entries: QueueItem[] = incoming.map((file) => {
        const localId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
        const previewUrl = URL.createObjectURL(file);
        previewUrls.current.add(previewUrl);
        const linkIndex = transfer.links.push(null) - 1;
        waitingUploads.current.push({ localId, file, linkIndex, albumId: isGuest ? null : albumId, isGuest });
        return {
          localId,
          name: file.name || 'pasted-image.png',
          file,
          previewUrl,
          progress: 0,
          status: 'uploading',
        };
      });
      setQueue((previous) => {
        const active = previous.filter((row) => row.status === 'uploading').length;
        let historySpace = MAX_QUEUE_SIZE - active - entries.length;
        return [...entries, ...previous.filter((row) => row.status === 'uploading' || historySpace-- > 0)];
      });
      drainQueue();
    },
    [albumId, drainQueue, isGuest, maxSizeMb, push]
  );

  // Global window drag-and-drop (strictly ignoring internal page drags) & Ctrl/Cmd+V paste
  useEffect(() => {
    const onDragStart = () => {
      internalDragRef.current = true;
    };
    const onDragEnd = () => {
      internalDragRef.current = false;
      dragCounter.current = 0;
      setIsDraggingWindow(false);
    };
    const isExternalFileDrag = (e: DragEvent) => {
      if (internalDragRef.current) return false;
      const dt = e.dataTransfer;
      if (!dt) return false;
      const types = Array.from(dt.types ?? []);
      return types.includes('Files');
    };
    const onDragEnter = (e: DragEvent) => {
      if (disabled || !isExternalFileDrag(e)) return;
      e.preventDefault();
      if (hasOpenModal()) return;
      dragCounter.current += 1;
      setIsDraggingWindow(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (disabled || !isExternalFileDrag(e)) return;
      e.preventDefault();
    };
    const onDragLeave = (e: DragEvent) => {
      if (disabled || !isExternalFileDrag(e)) return;
      e.preventDefault();
      dragCounter.current = Math.max(0, dragCounter.current - 1);
      if (dragCounter.current === 0) {
        setIsDraggingWindow(false);
      }
    };
    const onDrop = (e: DragEvent) => {
      const wasInternal = internalDragRef.current;
      internalDragRef.current = false;
      dragCounter.current = 0;
      setIsDraggingWindow(false);
      setIsHoverZone(false);
      if (disabled) return;
      if (wasInternal) {
        e.preventDefault();
        return;
      }
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      if (hasOpenModal()) return;
      void handleFiles(e.dataTransfer.files);
    };
    const onPaste = (e: ClipboardEvent) => {
      if (disabled || hasOpenModal()) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        void handleFiles(files);
      }
    };

    window.addEventListener('dragstart', onDragStart);
    window.addEventListener('dragend', onDragEnd);
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('dragstart', onDragStart);
      window.removeEventListener('dragend', onDragEnd);
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('paste', onPaste);
    };
  }, [disabled, handleFiles]);

  const onInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) {
      void handleFiles(e.target.files);
      e.target.value = '';
    }
  };

  const dismissQueueItem = (localId: string) => {
    setQueue((previous) => previous.filter((item) => item.localId !== localId));
  };

  const copyUploaded = async (image: ImageItem) => {
    const shared = await onPrepareCopy(image);
    if (!shared?.shareUrl) return;
    if (await copyText(buildImageLink(shared.shareUrl, shared.originalName, copyFormat))) {
      push(`已复制 ${copyFormat.toUpperCase()}`, 'success');
    } else {
      push('未能写入剪贴板', 'error');
    }
  };

  return (
    <>
      {/* Full-window drag overlay */}
      <AnimatePresence>
        {isDraggingWindow && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-white/75 p-6 backdrop-blur-md dark:bg-black/70"
          >
            <motion.div
              initial={{ scale: 0.96, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.96, opacity: 0 }}
              transition={SPRING_GENTLE}
              className="flex h-full max-h-96 w-full max-w-2xl flex-col items-center justify-center rounded-3xl border-2 border-dashed border-blue-500/70 bg-blue-500/[0.04]"
            >
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-600 dark:text-blue-400">
                <UploadCloud className="h-7 w-7" />
              </div>
              <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                松开鼠标即可立即上传
              </p>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                支持 JPG / PNG / WebP / AVIF / GIF，单张上限 {maxSizeMb} MB
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Dropzone Surface */}
      <section className="w-full">
        <motion.div
          onMouseEnter={() => setIsHoverZone(true)}
          onMouseLeave={() => setIsHoverZone(false)}
          animate={{
            scale: isHoverZone ? 1.003 : 1,
          }}
          transition={SPRING_SNAPPY}
          className="group relative cursor-pointer overflow-hidden rounded-3xl border border-dashed border-zinc-300/90 bg-white/75 px-6 py-7 transition-colors hover:border-blue-500/60 hover:bg-white dark:border-white/12 dark:bg-zinc-900/60 dark:hover:border-blue-400/50 dark:hover:bg-zinc-900/90"
        >
          <input
            type="file"
            accept={getImagePickerAccept()}
            multiple
            disabled={disabled}
            aria-label="选择图片上传"
            className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:pointer-events-none"
            onChange={onInputChange}
          />

          <div className="flex flex-col items-stretch justify-between gap-4 lg:flex-row lg:items-center">
            <div className="pointer-events-none flex items-center gap-3.5">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-700 transition-colors group-hover:bg-blue-500/10 group-hover:text-blue-600 sm:h-12 sm:w-12 dark:bg-white/[0.06] dark:text-zinc-300 dark:group-hover:bg-blue-500/15 dark:group-hover:text-blue-400">
                <ImagePlus className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    点击选择或拖拽图片上传
                  </span>
                  <span className="hidden items-center gap-1.5 sm:inline-flex">
                    <span className="text-sm text-zinc-500 dark:text-zinc-400">，或按</span>
                    <kbd className="rounded-lg border border-zinc-200 bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] font-medium text-zinc-600 dark:border-white/10 dark:bg-white/10 dark:text-zinc-300">
                      Ctrl + V
                    </kbd>
                    <span className="text-sm text-zinc-500 dark:text-zinc-400">粘贴</span>
                  </span>
                </div>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  支持批量上传 · 自动生成缩略图 · 单图上限 {maxSizeMb} MB
                </p>
              </div>
            </div>

            {/* Format selector + auto-copy pill (z-20 sits above overlay file input) */}
            <div
              className="relative z-20 flex flex-wrap items-center justify-between gap-2 lg:justify-end"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center rounded-xl border border-zinc-200/80 bg-zinc-100/80 p-0.5 dark:border-white/10 dark:bg-black/30">
                {FORMAT_LABELS.map((fmt) => {
                  const active = copyFormat === fmt.id;
                  return (
                    <button
                      key={fmt.id}
                      type="button"
                      onClick={() => onChangeCopyFormat(fmt.id)}
                      className={`relative rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                        active
                          ? 'text-zinc-900 dark:text-white'
                          : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
                      }`}
                    >
                      {active && (
                        <motion.span
                          layoutId="copy-format-pill"
                          transition={SPRING_SNAPPY}
                          className="absolute inset-0 rounded-lg bg-white shadow-xs dark:bg-zinc-800"
                        />
                      )}
                      <span className="relative z-10">{fmt.label}</span>
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={toggleAutoCopy}
                className={`flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  autoCopy
                    ? 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400'
                    : 'border-zinc-200/80 bg-zinc-100/70 text-zinc-500 dark:border-white/10 dark:bg-white/5 dark:text-zinc-400'
                }`}
                title="上传完成后自动复制可用的外链"
              >
                <Clipboard className="h-3.5 w-3.5" />
                <span>自动复制</span>
              </button>
            </div>
          </div>
        </motion.div>

        {/* Live upload queue strip */}
        <AnimatePresence initial={false}>
          {queue.length > 0 && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={SPRING_GENTLE}
              className="mt-3 overflow-hidden"
            >
              <div className="mb-1.5 flex items-center justify-between px-1">
                <span className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
                  近期传输 ({queue.length})
                </span>
                <button
                  type="button"
                  onClick={() => setQueue([])}
                  disabled={queue.some((item) => item.status === 'uploading')}
                  className="text-[11px] text-zinc-500 transition-colors hover:text-zinc-800 disabled:opacity-40 dark:text-zinc-400 dark:hover:text-zinc-200"
                >
                  收起队列
                </button>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <AnimatePresence mode="popLayout">
                  {queue.map((item) => (
                    <motion.div
                      key={item.localId}
                      layout
                      initial={{ opacity: 0, scale: 0.94, y: 6 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.92 }}
                      transition={SPRING_SNAPPY}
                      className="flex items-center gap-3 rounded-2xl border border-zinc-200/80 bg-white/90 p-2.5 shadow-xs dark:border-white/10 dark:bg-zinc-900/90"
                    >
                      <img
                        src={item.previewUrl}
                        alt={item.name}
                        draggable={false}
                        className="h-11 w-11 shrink-0 rounded-xl object-cover select-none"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-xs font-medium text-zinc-800 dark:text-zinc-100">
                            {item.name}
                          </p>
                          <button
                            type="button"
                            onClick={() => dismissQueueItem(item.localId)}
                            disabled={item.status === 'uploading'}
                            aria-label="移除上传记录"
                            className="shrink-0 text-zinc-400 hover:text-zinc-600 disabled:opacity-40 dark:hover:text-zinc-200"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>

                        {item.status === 'uploading' && item.retryAfter !== undefined && (
                          <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">预计 {item.retryAfter} 秒后自动重试</p>
                        )}
                        {item.status === 'uploading' && item.retryAfter === undefined && (
                          <div className="mt-1.5 flex items-center gap-2">
                            <div className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                              <motion.div
                                className="h-full rounded-full bg-blue-500"
                                initial={{ width: 0 }}
                                animate={{ width: `${Math.max(8, item.progress)}%` }}
                                transition={{ duration: 0.2 }}
                              />
                            </div>
                            <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
                          </div>
                        )}

                        {item.status === 'done' && item.image && (
                          <div className="mt-1 flex items-center justify-between gap-2">
                            <span className="flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                              <Check className="h-3 w-3" />
                              {formatBytes(item.image.sizeBytes)}
                            </span>
                            <button
                              type="button"
                              onClick={() => void copyUploaded(item.image!)}
                              className="inline-flex items-center gap-1 rounded-lg bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-700 transition-colors hover:bg-zinc-200 dark:bg-white/10 dark:text-zinc-200 dark:hover:bg-white/20"
                            >
                              <Copy className="h-3 w-3" />
                              复制
                            </button>
                          </div>
                        )}

                        {item.status === 'error' && (
                          <div className="mt-1 flex items-center gap-2">
                            <p className="min-w-0 truncate text-[11px] text-rose-500 dark:text-rose-400" title={item.error}>{item.error}</p>
                            {item.file && <button type="button" className="shrink-0 text-[11px] font-medium text-blue-600 hover:underline disabled:opacity-40 dark:text-blue-400"
                              disabled={queue.filter((row) => row.status === 'uploading').length >= MAX_QUEUE_SIZE}
                              onClick={() => {
                                dismissQueueItem(item.localId);
                                void handleFiles([item.file!]);
                              }}>重试</button>}
                          </div>
                        )}
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </section>
    </>
  );
}
