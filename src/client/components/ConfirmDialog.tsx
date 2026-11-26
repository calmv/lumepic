import { createContext, useCallback, useContext, useId, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle } from 'lucide-react';
import { useModalDialog } from '../lib/modal';
import { SPRING_GENTLE } from '../lib/motion';

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (confirmed: boolean) => void;
}

const ConfirmContext = createContext<(options: ConfirmOptions) => Promise<boolean>>(() =>
  Promise.resolve(false)
);

export function useConfirm() {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const descId = useId();

  const closeWith = useCallback((result: boolean) => {
    setPending((current) => {
      current?.resolve(result);
      return null;
    });
  }, []);

  useModalDialog(Boolean(pending), dialogRef, () => closeWith(false));

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setPending((previous) => {
        previous?.resolve(false);
        return { ...options, resolve };
      });
    });
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AnimatePresence>
        {pending && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4 backdrop-blur-xs"
            onClick={(event) => {
              if (event.target === event.currentTarget) closeWith(false);
            }}
          >
            <motion.div
              ref={dialogRef}
              role="alertdialog"
              aria-modal="true"
              aria-labelledby={titleId}
              aria-describedby={pending.description ? descId : undefined}
              tabIndex={-1}
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={SPRING_GENTLE}
              className="w-full max-w-sm rounded-3xl border border-zinc-200/90 bg-white p-5 shadow-2xl outline-none dark:border-white/12 dark:bg-zinc-900"
            >
              <div className="flex items-start gap-3">
                <div
                  className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl ${
                    pending.tone === 'danger'
                      ? 'bg-rose-500/12 text-rose-600 dark:text-rose-400'
                      : 'bg-blue-500/12 text-blue-600 dark:text-blue-400'
                  }`}
                >
                  <AlertTriangle className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 id={titleId} className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                    {pending.title}
                  </h3>
                  {pending.description && (
                    <p id={descId} className="mt-1.5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                      {pending.description}
                    </p>
                  )}
                </div>
              </div>

              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => closeWith(false)}
                  className="rounded-xl px-3.5 py-2 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-white/10"
                >
                  {pending.cancelLabel ?? '取消'}
                </button>
                <button
                  type="button"
                  onClick={() => closeWith(true)}
                  className={`rounded-xl px-4 py-2 text-xs font-medium text-white transition-colors ${
                    pending.tone === 'danger'
                      ? 'bg-rose-600 hover:bg-rose-500'
                      : 'bg-zinc-900 hover:bg-zinc-800 dark:bg-blue-600 dark:hover:bg-blue-500'
                  }`}
                >
                  {pending.confirmLabel ?? '确认'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </ConfirmContext.Provider>
  );
}
