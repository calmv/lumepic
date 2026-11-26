import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, AlertCircle, Info } from 'lucide-react';
import { SPRING_SNAPPY } from '../lib/motion';

type ToastTone = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastContextValue {
  push: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastContextValue>({ push: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const push = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = nextId++;
    setToasts((prev) => [...prev.slice(-3), { id, message, tone }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 2800);
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="pointer-events-none fixed top-[72px] left-1/2 z-[80] flex w-max max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col items-center gap-2">
        <AnimatePresence mode="popLayout">
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: -14, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.94 }}
              transition={SPRING_SNAPPY}
              className="pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-zinc-200/80 bg-white/95 px-4 py-2 text-xs font-medium text-zinc-900 shadow-lg shadow-black/8 backdrop-blur-xl dark:border-white/12 dark:bg-zinc-900/95 dark:text-zinc-100 dark:shadow-black/50"
            >
              {t.tone === 'success' && (
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                  <Check className="h-3 w-3" strokeWidth={2.5} />
                </span>
              )}
              {t.tone === 'error' && (
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-rose-500/15 text-rose-600 dark:text-rose-400">
                  <AlertCircle className="h-3 w-3" strokeWidth={2.5} />
                </span>
              )}
              {t.tone === 'info' && (
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-blue-500/15 text-blue-600 dark:text-blue-400">
                  <Info className="h-3 w-3" strokeWidth={2.5} />
                </span>
              )}
              <span>{t.message}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
