import { useEffect, useRef, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { Film } from './films';
import './FilmDialog.css';

export function FilmDialog({ film, poster, onClose }: { film: Film; poster?: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const video = videoRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    // Best effort: the click is a user gesture, but the browser may still block sound.
    try {
      video?.play().catch(() => {});
    } catch {
      // jsdom does not implement media playback.
    }
    return () => video?.pause();
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      className="agents-film-dialog"
      aria-labelledby={`film-dialog-title-${film.id}`}
      onClose={onClose}
      onClick={event => {
        if (event.target === event.currentTarget) dialogRef.current?.close();
      }}
    >
      <div className="agents-film-dialog-shell" style={{ '--film-accent': film.accent } as CSSProperties}>
        <header>
          <p>{film.num} / 04 · {film.duration} · Live capture</p>
          <h2 id={`film-dialog-title-${film.id}`}>{film.title}</h2>
          <button type="button" onClick={() => dialogRef.current?.close()} aria-label="Close film">
            <X size={18} />
          </button>
        </header>
        <video ref={videoRef} src={film.src} poster={poster ?? film.poster} controls playsInline preload="metadata" />
        <footer>
          <span>Nova · disposable test project</span>
          <span>Captured in the live workspace</span>
        </footer>
      </div>
    </dialog>,
    document.body,
  );
}
