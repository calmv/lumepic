import { useId, useRef, useState, type FormEvent } from 'react';
import { motion } from 'motion/react';
import { ArrowRight, Lock, Sparkles, X } from 'lucide-react';
import { api } from '../lib/api';
import { MIN_ADMIN_PASSWORD_LENGTH, type PublicConfig } from '../../shared/types';
import { useModalDialog } from '../lib/modal';
import { SPRING_GENTLE } from '../lib/motion';
import { SiteIcon } from './SiteIcon';

interface AuthCardProps {
  config: PublicConfig;
  isModal?: boolean;
  onClose?: () => void;
  onBackHome?: () => void;
  onAuthenticated: (nextConfig: PublicConfig) => void;
}

export function AuthCard({
  config,
  isModal = false,
  onClose,
  onBackHome,
  onAuthenticated,
}: AuthCardProps) {
  const isSetup = !config.initialized;
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const cardRef = useRef<HTMLDivElement | null>(null);
  const headingId = useId();
  useModalDialog(Boolean(isModal), cardRef, onClose);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (isSetup) {
      if (password.length < MIN_ADMIN_PASSWORD_LENGTH || !password.trim() || new TextEncoder().encode(password).length > 256) {
        setError(`密码至少需要 ${MIN_ADMIN_PASSWORD_LENGTH} 个字符，且不超过 256 字节`);
        return;
      }
      if (password !== confirm) {
        setError('两次输入的密码不一致');
        return;
      }
    } else if (!password) {
      setError('请输入管理员密码');
      return;
    }

    setLoading(true);
    try {
      const res = isSetup ? await api.setupAdmin(password, setupToken.trim()) : await api.login(password);
      onAuthenticated(res.config);
      onClose?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : '验证失败');
    } finally {
      setLoading(false);
    }
  };

  const card = (
    <motion.div
      ref={cardRef}
      role={isModal ? 'dialog' : undefined}
      aria-modal={isModal ? true : undefined}
      aria-labelledby={isModal ? headingId : undefined}
      tabIndex={isModal ? -1 : undefined}
      initial={{ opacity: 0, y: 16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.97 }}
      transition={SPRING_GENTLE}
      className="relative w-full max-w-sm rounded-3xl border border-zinc-200/80 bg-white/85 p-7 shadow-2xl shadow-black/5 backdrop-blur-2xl outline-none dark:border-white/10 dark:bg-zinc-900/85 dark:shadow-black/50"
    >
      {isModal && onClose && (
        <button
          type="button"
          onClick={onClose}
          className="absolute top-5 right-5 rounded-full p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-white/10 dark:hover:text-zinc-200"
          aria-label="关闭"
        >
          <X className="h-4 w-4" />
        </button>
      )}

      <div className="mb-6 flex items-center gap-3">
        <SiteIcon url={config.siteIconUrl} className="flex h-10 w-10 items-center justify-center rounded-2xl bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">
          {isSetup ? <Sparkles className="h-5 w-5" /> : <Lock className="h-5 w-5" />}
        </SiteIcon>
        <div>
          <h1 id={headingId} className="text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {isSetup ? `初始化 ${config.siteTitle}` : config.siteTitle}
          </h1>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {isSetup ? '首次使用，请设置管理员访问密码' : '私有图床空间 · 请输入管理员密码'}
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3.5">
        <div>
          <input
            type="password"
            aria-label={isSetup ? '设置管理员密码' : '管理员密码'}
            autoComplete={isSetup ? 'new-password' : 'current-password'}
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={isSetup ? `设置管理员密码（至少 ${MIN_ADMIN_PASSWORD_LENGTH} 个字符）` : '输入管理员密码'}
            className="w-full rounded-2xl border border-zinc-200 bg-zinc-50/70 px-4 py-3 text-sm text-zinc-900 placeholder-zinc-400 outline-none transition-all focus:border-blue-500 focus:bg-white focus:ring-4 focus:ring-blue-500/10 dark:border-white/10 dark:bg-black/30 dark:text-zinc-100 dark:focus:border-blue-400 dark:focus:bg-black/50"
          />
        </div>

        {isSetup && (
          <div>
            <input
              type="password"
              aria-label="再次确认密码"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="再次确认密码"
              className="w-full rounded-2xl border border-zinc-200 bg-zinc-50/70 px-4 py-3 text-sm text-zinc-900 placeholder-zinc-400 outline-none transition-all focus:border-blue-500 focus:bg-white focus:ring-4 focus:ring-blue-500/10 dark:border-white/10 dark:bg-black/30 dark:text-zinc-100 dark:focus:border-blue-400 dark:focus:bg-black/50"
            />
          </div>
        )}

        {isSetup && config.requiresSetupToken && (
          <input
            type="password"
            autoComplete="off"
            aria-label="一次性初始化令牌"
            placeholder="部署时设置的一次性初始化令牌"
            value={setupToken}
            onChange={(e) => setSetupToken(e.target.value)}
            required
            className="w-full rounded-2xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm dark:border-white/10 dark:bg-zinc-900"
          />
        )}

        {error && (
          <motion.p
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            className="px-1 text-xs font-medium text-rose-500"
          >
            {error}
          </motion.p>
        )}

        <motion.button
          whileTap={{ scale: 0.985 }}
          type="submit"
          disabled={loading}
          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-zinc-900 px-4 py-3 text-sm font-medium text-white shadow-sm transition-colors hover:bg-zinc-800 disabled:opacity-60 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          <span>{loading ? '正在验证...' : isSetup ? '完成初始化并进入' : '解锁进入后台'}</span>
          <ArrowRight className="h-4 w-4" />
        </motion.button>

        {!isSetup && config.allowGuestUpload && onBackHome && (
          <button
            type="button"
            onClick={onBackHome}
            className="w-full pt-1 text-center text-xs text-zinc-400 transition-colors hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            返回图片上传首页
          </button>
        )}
      </form>
    </motion.div>
  );

  if (isModal) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4 backdrop-blur-sm"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose?.();
        }}
      >
        {card}
      </div>
    );
  }

  return (
    <div className="bg-ambient-grid relative flex min-h-screen items-center justify-center overflow-hidden p-4">
      <div className="pointer-events-none absolute -top-40 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-blue-500/10 blur-3xl dark:bg-blue-500/15" />
      {card}
    </div>
  );
}
