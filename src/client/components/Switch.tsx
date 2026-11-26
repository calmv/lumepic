import { motion } from 'motion/react';
import { SPRING_SNAPPY } from '../lib/motion';

interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}

export function Switch({ checked, onChange, disabled = false, ariaLabel }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 disabled:cursor-not-allowed disabled:opacity-50 ${
        checked
          ? 'bg-blue-600 dark:bg-blue-500'
          : 'bg-zinc-200 dark:bg-zinc-700'
      }`}
    >
      <motion.span
        layout
        transition={SPRING_SNAPPY}
        className={`pointer-events-none block h-5 w-5 rounded-full bg-white shadow-sm ${
          checked ? 'ml-auto' : 'mr-auto'
        }`}
      />
    </button>
  );
}
