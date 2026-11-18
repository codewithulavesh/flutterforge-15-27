import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
  motion,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
  useVelocity,
} from 'motion/react';
import { cn } from '@/utils/cn';

const MARQUEE_ITEMS = ['Real Dart files', 'Live preview', 'Self-repair', 'Local source', 'No lock-in'] as const;

export function ScrollProgress({ className }: { className?: string }) {
  const { scrollYProgress } = useScroll();
  const scaleX = useSpring(scrollYProgress, { stiffness: 140, damping: 26, restDelta: 0.001 });

  return (
    <motion.div
      aria-hidden
      className={cn('h-[2px] origin-left bg-[var(--fb-ink)]', className)}
      style={{ scaleX }}
    />
  );
}

export function VelocityMarquee({ items = MARQUEE_ITEMS }: { items?: readonly string[] }) {
  const reduce = useReducedMotion() ?? false;
  const { scrollY } = useScroll();
  const velocity = useVelocity(scrollY);
  const smoothed = useSpring(velocity, { stiffness: 280, damping: 42, mass: 0.5 });

  const skewY = useTransform(smoothed, [-1800, 0, 1800], reduce ? [0, 0, 0] : [-3.5, 0, 3.5], {
    clamp: true,
  });
  const rotateX = useTransform(smoothed, [-1800, 0, 1800], reduce ? [0, 0, 0] : [5, 0, -5], {
    clamp: true,
  });
  const scale = useTransform(smoothed, [-1800, 0, 1800], reduce ? [1, 1, 1] : [1.02, 1, 1.02], {
    clamp: true,
  });

  const loop = [...items, ...items];

  const group = (key: string) => (
    <span key={key} aria-hidden className="ffb-marquee-group">
      {loop.map((item, index) => (
        <span key={`${item}-${index}`} className="ffb-marquee-item">
          <span className="ffb-marquee-dot" />
          {item}
        </span>
      ))}
    </span>
  );

  return (
    <div className="ffb-marquee border-y border-black/15 bg-[var(--fb-lime)] py-4 text-black">
      <span className="sr-only">{items.join(' · ')}</span>
      <div className="ffb-marquee-window">
        <motion.div
          style={{ rotateX, skewY, scale, transformPerspective: 1000 }}
          className="ffb-marquee-tilt"
        >
          <div className="ffb-marquee-track">
            {group('a')}
            {group('b')}
          </div>
        </motion.div>
      </div>
    </div>
  );
}

export function Tilt3D({
  children,
  className,
  max = 5,
}: {
  children: ReactNode;
  className?: string;
  max?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion() ?? false;
  const rotateX = useSpring(0, { stiffness: 180, damping: 24 });
  const rotateY = useSpring(0, { stiffness: 180, damping: 24 });

  function handleMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (reduce || event.pointerType !== 'mouse') return;
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width - 0.5;
    const py = (event.clientY - rect.top) / rect.height - 0.5;
    rotateY.set(px * max * 2);
    rotateX.set(-py * max * 2);
  }

  function reset() {
    rotateX.set(0);
    rotateY.set(0);
  }

  return (
    <motion.div
      ref={ref}
      onPointerMove={handleMove}
      onPointerLeave={reset}
      style={{ rotateX, rotateY, transformPerspective: 1400, transformStyle: 'preserve-3d' }}
      className={cn('ffb-tilt', className)}
    >
      {children}
    </motion.div>
  );
}
