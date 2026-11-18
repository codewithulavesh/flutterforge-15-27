import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Pause, Play } from 'lucide-react';
import './LimeCarousel.css';

export function LimeCarousel({ items, label, reducedMotion }: {
  items: readonly { title: string; body: string; eyebrow?: string }[];
  label: string;
  reducedMotion: boolean;
}) {
  const regionRef = useRef<HTMLDivElement>(null);
  const pointerPauseIntent = useRef<boolean | null>(null);
  const [index, setIndex] = useState(0);
  const [inViewport, setInViewport] = useState(false);
  const [pageVisible, setPageVisible] = useState(
    () => typeof document !== 'undefined' && document.visibilityState === 'visible',
  );
  const [hovered, setHovered] = useState(false);
  const [manuallyPaused, setManuallyPaused] = useState(false);
  const hasMultipleSlides = items.length > 1;
  const rotationStopped = manuallyPaused || reducedMotion || !hasMultipleSlides;
  const autoplaying = !rotationStopped && inViewport && pageVisible && !hovered;
  const activeIndex = items.length ? index % items.length : 0;

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

  useEffect(() => {
    if (!autoplaying) return;
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % items.length);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [autoplaying, items.length]);

  function moveSlide(direction: number) {
    setManuallyPaused(true);
    if (hasMultipleSlides) {
      setIndex((current) => (current + direction + items.length) % items.length);
    }
  }

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
          onClick={() => moveSlide(-1)}
        >
          <ChevronUp size={22} aria-hidden="true" focusable="false" />
        </button>
        <button
          className="lv-carousel__control"
          type="button"
          aria-label={`Next ${label}`}
          disabled={!hasMultipleSlides}
          onClick={() => moveSlide(1)}
        >
          <ChevronDown size={22} aria-hidden="true" focusable="false" />
        </button>
      </div>
      <div className="lv-carousel__slides" aria-live={autoplaying ? 'off' : 'polite'} aria-atomic="true">
        {items.map((item, slideIndex) => (
          <div
            key={slideIndex}
            className="lv-carousel__slide"
            role="group"
            aria-roledescription="slide"
            aria-label={`${slideIndex + 1} of ${items.length}`}
            aria-hidden={slideIndex !== activeIndex}
            data-position={slideIndex < activeIndex ? 'before' : 'after'}
          >
            {item.eyebrow && <p className="lv-carousel__eyebrow">{item.eyebrow}</p>}
            <h3 className="lv-carousel__title">{item.title}</h3>
            <p className="lv-carousel__body">{item.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
