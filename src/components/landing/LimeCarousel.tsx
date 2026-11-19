import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, ChevronUp, Pause, Play } from 'lucide-react';
import './LimeCarousel.css';

const AUTOPLAY_MS = 4000;

/**
 * Vertical carousel matching the reference: one 330px slide at a time, with a
 * masked track that glides between slides. The first and last slides are
 * cloned at the track edges so wrapping never runs out of content.
 */
export function LimeCarousel({ items, label, reducedMotion }: {
  items: readonly { title: string; body: string; eyebrow?: string }[];
  label: string;
  reducedMotion: boolean;
}) {
  const regionRef = useRef<HTMLDivElement>(null);
  const pointerPauseIntent = useRef<boolean | null>(null);
  const positionRef = useRef(1);
  const [position, setPosition] = useState(1);
  const [instant, setInstant] = useState(false);
  const [inViewport, setInViewport] = useState(false);
  const [pageVisible, setPageVisible] = useState(
    () => typeof document !== 'undefined' && document.visibilityState === 'visible',
  );
  const [hovered, setHovered] = useState(false);
  const [manuallyPaused, setManuallyPaused] = useState(false);
  const hasMultipleSlides = items.length > 1;
  const rotationStopped = manuallyPaused || reducedMotion || !hasMultipleSlides;
  const autoplaying = !rotationStopped && inViewport && pageVisible && !hovered;
  const activeIndex = items.length ? ((position - 1) % items.length + items.length) % items.length : 0;
  const lastPosition = items.length + 1;

  function moveTrack(next: number, withoutTransition = false) {
    positionRef.current = next;
    if (withoutTransition) setInstant(true);
    setPosition(next);
  }

  function settleTrack() {
    if (positionRef.current >= lastPosition) moveTrack(1, true);
    else if (positionRef.current <= 0) moveTrack(items.length, true);
  }

  function moveToAdjacent(direction: number) {
    if (!hasMultipleSlides) return;
    setManuallyPaused(true);
    const current = positionRef.current;
    // Parked on a clone (an interrupted wrap): finish the wrap in the natural
    // direction, or snap past it when the step would otherwise run off-track.
    if (current >= lastPosition) {
      if (direction > 0) moveTrack(2, true);
      else moveTrack(items.length);
      return;
    }
    if (current <= 0) {
      if (direction > 0) moveTrack(1);
      else moveTrack(items.length - 1, true);
      return;
    }
    moveTrack(current + direction);
  }

  useEffect(() => {
    const region = regionRef.current;
    // Without observation support, keep manual navigation but never autoplay.
    if (!region || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === region) {
          setInViewport(entry.isIntersecting && entry.intersectionRatio > 0);
        }
      }
    });
    observer.observe(region);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const updateVisibility = () => setPageVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', updateVisibility);
    updateVisibility();
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, []);

  // Re-arm the transform transition after a silent clone snap. A frame of
  // transition:none lets the browser paint the reset before the next glide.
  useEffect(() => {
    if (!instant) return;
    const frame = window.requestAnimationFrame(() => setInstant(false));
    return () => window.cancelAnimationFrame(frame);
  }, [instant]);

  useEffect(() => {
    if (!autoplaying) return;
    const timer = window.setInterval(() => {
      const current = positionRef.current;
      // A wrap animation should have settled on the first real slide; if it
      // has not, step straight to the second slide instead of a dead slot.
      if (current >= lastPosition) {
        moveTrack(2, true);
        return;
      }
      moveTrack(current + 1);
    }, AUTOPLAY_MS);
    return () => window.clearInterval(timer);
  }, [autoplaying, lastPosition]);

  const track = items.length
    ? [items[items.length - 1], ...items, items[0]]
    : [];

  return (
    <div
      ref={regionRef}
      className="lv-carousel"
      role="region"
      aria-label={label}
      aria-roledescription="carousel"
      data-reduced-motion={reducedMotion || undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setManuallyPaused(true);
        }
      }}
    >
      <div className="lv-carousel__controls">
        <button
          className="lv-carousel__control"
          type="button"
          aria-label={`${rotationStopped ? 'Play' : 'Pause'} ${label}`}
          disabled={reducedMotion || !hasMultipleSlides}
          onPointerDown={() => {
            // Pointer focus pauses before click: retain the originally requested action.
            pointerPauseIntent.current = !rotationStopped;
          }}
          onPointerCancel={() => { pointerPauseIntent.current = null; }}
          onBlur={() => { pointerPauseIntent.current = null; }}
          onClick={() => {
            setManuallyPaused(pointerPauseIntent.current ?? !manuallyPaused);
            pointerPauseIntent.current = null;
          }}
        >
          {rotationStopped
            ? <Play size={18} aria-hidden="true" focusable="false" />
            : <Pause size={18} aria-hidden="true" focusable="false" />}
        </button>
        <button
          className="lv-carousel__control"
          type="button"
          aria-label={`Previous ${label}`}
          disabled={!hasMultipleSlides}
          onClick={() => moveToAdjacent(-1)}
        >
          <ChevronUp size={22} aria-hidden="true" focusable="false" />
        </button>
        <button
          className="lv-carousel__control"
          type="button"
          aria-label={`Next ${label}`}
          disabled={!hasMultipleSlides}
          onClick={() => moveToAdjacent(1)}
        >
          <ChevronDown size={22} aria-hidden="true" focusable="false" />
        </button>
      </div>
      <div
        className="lv-carousel__viewport"
        aria-live={autoplaying ? 'off' : 'polite'}
        aria-atomic="true"
      >
        <div
          className="lv-carousel__track"
          data-instant={instant || undefined}
          style={{ '--lv-carousel-index': position } as CSSProperties}
          onTransitionEnd={(event) => {
            if (event.target === event.currentTarget && event.propertyName === 'transform') {
              settleTrack();
            }
          }}
        >
          {track.map((item, trackIndex) => {
            const clone = trackIndex === 0 || trackIndex === track.length - 1;
            const slideIndex = clone
              ? (trackIndex === 0 ? items.length - 1 : 0)
              : trackIndex - 1;
            const visible = !clone && slideIndex === activeIndex;
            return (
              <div
                key={`${clone ? 'clone' : 'slide'}-${trackIndex}`}
                className="lv-carousel__slide"
                role="group"
                aria-roledescription="slide"
                aria-label={`${slideIndex + 1} of ${items.length}`}
                aria-hidden={!visible}
                data-clone={clone || undefined}
                data-position={visible ? 'active' : 'inactive'}
              >
                {item.eyebrow && <p className="lv-carousel__eyebrow">{item.eyebrow}</p>}
                <h3 className="lv-carousel__title">{item.title}</h3>
                <p className="lv-carousel__body">{item.body}</p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
