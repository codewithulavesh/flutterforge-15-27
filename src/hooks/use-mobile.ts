import { useSyncExternalStore } from 'react';

/**
 * The app shell switches from a rail to a drawer below this width. It is
 * intentionally lower than Tailwind's `lg` (1024px): the dashboard still has
 * room for a 16.5rem rail at 900px, and tablets get the desktop shape instead
 * of a phone drawer.
 */
const MOBILE_BREAKPOINT = 900;

function subscribe(onChange: () => void) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const query = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function getSnapshot() {
  if (typeof window === 'undefined') return false;
  return window.innerWidth < MOBILE_BREAKPOINT;
}

/** True when the viewport is narrower than `lg` (1024px). */
export function useIsMobile() {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
