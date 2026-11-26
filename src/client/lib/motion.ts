export const SPRING_SNAPPY = {
  type: 'spring' as const,
  stiffness: 420,
  damping: 32,
  mass: 0.75,
};

export const SPRING_GENTLE = {
  type: 'spring' as const,
  stiffness: 290,
  damping: 29,
  mass: 0.85,
};

export const EASE_SMOOTH = [0.22, 1, 0.36, 1] as const;
