import '@testing-library/jest-dom/vitest';
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LimeCarousel } from './LimeCarousel';

// jsdom has no viewport/layout or IntersectionObserver implementation.
class ViewportObserver implements IntersectionObserver {
  static instances = new Set<ViewportObserver>();
  readonly root = null;
  readonly rootMargin = '0px';
  readonly thresholds = [0];
  readonly targets = new Set<Element>();

  constructor(readonly callback: IntersectionObserverCallback) {
    ViewportObserver.instances.add(this);
  }

  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() {
    this.targets.clear();
    ViewportObserver.instances.delete(this);
  }
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

function setInViewport(target: Element, visible: boolean) {
  act(() => {
    for (const observer of ViewportObserver.instances) {
      if (!observer.targets.has(target)) continue;
      const rect = target.getBoundingClientRect();
      observer.callback([{
        target,
        time: performance.now(),
        isIntersecting: visible,
        intersectionRatio: visible ? 1 : 0,
        boundingClientRect: rect,
        intersectionRect: visible ? rect : new DOMRect(),
        rootBounds: new DOMRect(0, 0, 1024, 768),
      }], observer);
    }
  });
}

// jsdom exposes visibilityState, but cannot background a browser tab.
function setPageVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
  fireEvent(document, new Event('visibilitychange'));
}

function advance(milliseconds: number) {
  act(() => { vi.advanceTimersByTime(milliseconds); });
}

const items = [
  { eyebrow: '01 / Design', title: 'Start with an idea', body: 'Describe the app you want to build.' },
  { title: 'Make it your own', body: 'Refine every screen with a conversation.' },
  { title: 'Ship something real', body: 'Export your Flutter code and launch.' },
] as const;

function mountCarousel(reducedMotion = false) {
  const result = render(<LimeCarousel items={items} label="Build stories" reducedMotion={reducedMotion} />);
  const region = screen.getByRole('region', { name: 'Build stories' });
  return { ...result, region };
}

beforeEach(() => {
  // Keep RTL/user-event's zero-delay async drains real; only the rotation clock is fake.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  ViewportObserver.instances.clear();
  vi.stubGlobal('IntersectionObserver', ViewportObserver);
  setPageVisibility('visible');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'visibilityState');
});

describe('LimeCarousel', () => {
  it('exposes one slide at a time in a labeled carousel without focusable inactive text', () => {
    const { region } = mountCarousel();
    expect(region).toHaveAttribute('aria-roledescription', 'carousel');
    expect(region).toHaveClass('lv-carousel');
    expect(within(region).getAllByRole('heading', { level: 3 })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Start with an idea' })).toBeInTheDocument();
    expect(screen.getByText('Describe the app you want to build.')).toBeInTheDocument();
    expect(screen.getByText('01 / Design')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(3);
    for (const title of ['Make it your own', 'Ship something real']) {
      const inactive = screen.getByText(title).closest('[aria-hidden="true"]');
      expect(inactive).not.toBeNull();
      expect(inactive?.querySelector('a, button, input, select, textarea, [tabindex]')).toBeNull();
    }
  });

  it('wraps previous from first to last and next from last to first', () => {
    mountCarousel();
    fireEvent.click(screen.getByRole('button', { name: 'Previous Build stories' }));
    expect(screen.getByRole('heading', { name: 'Ship something real' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next Build stories' }));
    expect(screen.getByRole('heading', { name: 'Start with an idea' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next Build stories' }));
    expect(screen.getByRole('heading', { name: 'Make it your own' })).toBeInTheDocument();
    expect(screen.getByText('Refine every screen with a conversation.')).toBeInTheDocument();
  });

  it('starts its 4000ms autoplay clock only after entering the viewport', () => {
    const { region } = mountCarousel();
    advance(12000);
    expect(screen.getByRole('heading', { name: 'Start with an idea' })).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
    setInViewport(region, true);
    advance(3999);
    expect(screen.getByRole('heading', { name: 'Start with an idea' })).toBeInTheDocument();
    advance(1);
    expect(screen.getByRole('heading', { name: 'Make it your own' })).toBeInTheDocument();
    advance(4000);
    expect(screen.getByRole('heading', { name: 'Ship something real' })).toBeInTheDocument();
    advance(4000);
    expect(screen.getByRole('heading', { name: 'Start with an idea' })).toBeInTheDocument();
  });

  it('cancels the clock offscreen and starts a fresh interval on re-entry', () => {
    const { region } = mountCarousel();
    setInViewport(region, true);
    advance(3000);
    setInViewport(region, false);
    expect(vi.getTimerCount()).toBe(0);
    advance(8000);
    expect(screen.getByRole('heading', { name: 'Start with an idea' })).toBeInTheDocument();
    setInViewport(region, true);
    advance(3999);
    expect(screen.getByRole('heading', { name: 'Start with an idea' })).toBeInTheDocument();
    advance(1);
    expect(screen.getByRole('heading', { name: 'Make it your own' })).toBeInTheDocument();
  });

  it('does not autoplay in a hidden tab, including when initially hidden', () => {
    setPageVisibility('hidden');
    const { region } = mountCarousel();
    setInViewport(region, true);
    advance(8000);
    expect(vi.getTimerCount()).toBe(0);
    expect(screen.getByRole('heading', { name: 'Start with an idea' })).toBeInTheDocument();
    setPageVisibility('visible');
    advance(4000);
    expect(screen.getByRole('heading', { name: 'Make it your own' })).toBeInTheDocument();
    setPageVisibility('hidden');
    expect(vi.getTimerCount()).toBe(0);
    advance(8000);
    expect(screen.getByRole('heading', { name: 'Make it your own' })).toBeInTheDocument();
  });

  it('pauses on hover and resumes on leave unless manually paused', () => {
    const { region } = mountCarousel();
    setInViewport(region, true);
    fireEvent.mouseEnter(region);
    expect(vi.getTimerCount()).toBe(0);
    advance(8000);
    expect(screen.getByRole('heading', { name: 'Start with an idea' })).toBeInTheDocument();
    fireEvent.mouseLeave(region);
    advance(4000);
    expect(screen.getByRole('heading', { name: 'Make it your own' })).toBeInTheDocument();
    fireEvent.mouseEnter(region);
    fireEvent.click(screen.getByRole('button', { name: 'Pause Build stories' }));
    fireEvent.mouseLeave(region);
    advance(8000);
    expect(screen.getByRole('heading', { name: 'Make it your own' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Play Build stories' }));
    advance(4000);
    expect(screen.getByRole('heading', { name: 'Ship something real' })).toBeInTheDocument();
  });

  it.each(['Previous', 'Next'])('stops autoplay after a %s action until explicit Play', (direction) => {
    const { region } = mountCarousel();
    setInViewport(region, true);
    fireEvent.click(screen.getByRole('button', { name: `${direction} Build stories` }));
    const title = direction === 'Previous' ? 'Ship something real' : 'Make it your own';
    expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play Build stories' })).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
    setInViewport(region, false);
    setInViewport(region, true);
    advance(8000);
    expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Play Build stories' }));
    advance(4000);
    expect(screen.queryByRole('heading', { name: title })).not.toBeInTheDocument();
  });

  it('keeps focus-triggered stopping latched after blur and allows explicit keyboard Play', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { region } = mountCarousel();
    setInViewport(region, true);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Play Build stories' })).toHaveFocus();
    expect(vi.getTimerCount()).toBe(0);
    act(() => { (document.activeElement as HTMLElement).blur(); });
    fireEvent.mouseEnter(region);
    fireEvent.mouseLeave(region);
    advance(8000);
    expect(screen.getByRole('heading', { name: 'Start with an idea' })).toBeInTheDocument();
    act(() => { screen.getByRole('button', { name: 'Play Build stories' }).focus(); });
    await user.keyboard('{Enter}');
    advance(4000);
    expect(screen.getByRole('heading', { name: 'Make it your own' })).toBeInTheDocument();
    // Moving focus within the carousel is not a new focus entry.
    await user.tab();
    advance(4000);
    expect(screen.getByRole('heading', { name: 'Ship something real' })).toBeInTheDocument();
    act(() => { (document.activeElement as HTMLElement).blur(); });
    act(() => { screen.getByRole('button', { name: 'Next Build stories' }).focus(); });
    advance(8000);
    expect(screen.getByRole('heading', { name: 'Ship something real' })).toBeInTheDocument();
  });

  it('does not turn a pointer Pause into Play when the same click enters focus', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { region } = mountCarousel();
    setInViewport(region, true);
    await user.click(screen.getByRole('button', { name: 'Pause Build stories' }));
    await user.unhover(region);
    expect(screen.getByRole('button', { name: 'Play Build stories' })).toHaveFocus();
    advance(8000);
    expect(screen.getByRole('heading', { name: 'Start with an idea' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Play Build stories' }));
    await user.unhover(region);
    advance(4000);
    expect(screen.getByRole('heading', { name: 'Make it your own' })).toBeInTheDocument();
  });

  it('uses polite announcements for manual slides but silences autoplay', () => {
    const { region } = mountCarousel();
    expect(screen.getByRole('heading', { name: 'Start with an idea' }).closest('[aria-live]'))
      .toHaveAttribute('aria-live', 'polite');
    setInViewport(region, true);
    expect(screen.getByRole('heading', { name: 'Start with an idea' }).closest('[aria-live]'))
      .toHaveAttribute('aria-live', 'off');
    fireEvent.click(screen.getByRole('button', { name: 'Next Build stories' }));
    expect(screen.getByRole('heading', { name: 'Make it your own' }).closest('[aria-live]'))
      .toHaveAttribute('aria-live', 'polite');
    fireEvent.click(screen.getByRole('button', { name: 'Play Build stories' }));
    expect(screen.getByRole('heading', { name: 'Make it your own' }).closest('[aria-live]'))
      .toHaveAttribute('aria-live', 'off');
  });

  it('never autoplays with reduced motion while keeping manual navigation available', () => {
    const { region } = mountCarousel(true);
    setInViewport(region, true);
    advance(8000);
    expect(vi.getTimerCount()).toBe(0);
    expect(screen.getByRole('heading', { name: 'Start with an idea' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next Build stories' }));
    expect(screen.getByRole('heading', { name: 'Make it your own' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Previous Build stories' }));
    expect(screen.getByRole('heading', { name: 'Start with an idea' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Play Build stories' }));
    advance(8000);
    expect(vi.getTimerCount()).toBe(0);
    expect(screen.getByRole('heading', { name: 'Start with an idea' })).toBeInTheDocument();
  });

  it('cancels an existing timer when reduced motion is enabled', () => {
    const { region, rerender } = mountCarousel();
    setInViewport(region, true);
    advance(3000);
    rerender(<LimeCarousel items={items} label="Build stories" reducedMotion />);
    expect(vi.getTimerCount()).toBe(0);
    advance(8000);
    expect(screen.getByRole('heading', { name: 'Start with an idea' })).toBeInTheDocument();
  });

  it('keeps the two page instances independently observed and controlled', () => {
    render(<>
      <LimeCarousel items={items} label="Design" reducedMotion={false} />
      <LimeCarousel items={items} label="Deliver" reducedMotion={false} />
    </>);
    const design = screen.getByRole('region', { name: 'Design' });
    const deliver = screen.getByRole('region', { name: 'Deliver' });
    setInViewport(design, true);
    advance(4000);
    expect(within(design).getByRole('heading', { name: 'Make it your own' })).toBeInTheDocument();
    expect(within(deliver).getByRole('heading', { name: 'Start with an idea' })).toBeInTheDocument();
    fireEvent.click(within(design).getByRole('button', { name: 'Pause Design' }));
    setInViewport(deliver, true);
    advance(8000);
    expect(within(design).getByRole('heading', { name: 'Make it your own' })).toBeInTheDocument();
    expect(within(deliver).getByRole('heading', { name: 'Ship something real' })).toBeInTheDocument();
  });

  it('cleans up its timer on unmount, including React StrictMode effect replay', () => {
    const { unmount } = render(<StrictMode>
      <LimeCarousel items={items} label="Build stories" reducedMotion={false} />
    </StrictMode>);
    setInViewport(screen.getByRole('region', { name: 'Build stories' }), true);
    expect(vi.getTimerCount()).toBe(1);
    advance(4000);
    expect(screen.getByRole('heading', { name: 'Make it your own' })).toBeInTheDocument();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    setPageVisibility('hidden');
    setPageVisibility('visible');
    advance(8000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([{ slides: [] }, { slides: [items[0]] }])('does not schedule rotation for fewer than two slides: $slides.length', ({ slides }) => {
    render(<LimeCarousel items={slides} label="Build stories" reducedMotion={false} />);
    setInViewport(screen.getByRole('region', { name: 'Build stories' }), true);
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
    advance(8000);
    expect(vi.getTimerCount()).toBe(0);
    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(slides.length);
  });
});
