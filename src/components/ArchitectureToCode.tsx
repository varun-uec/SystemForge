import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePresence } from './presence';
import { downloadBlob } from '../imageExport';
import './ArchitectureToCode.css';

/* ==========================================================================
   From an architecture doc.

   WHY IT EXISTS. A student (or a team) often starts from a written
   description or a whiteboard photo of a system, not a blank canvas. This
   panel is the front door for that: pick the doc or the image, and hand it
   to Claude Code, which does the actual reading and writing.

   WHY NOT A LIVE "ANALYZING..." STEP. Breakscale calls no network and holds
   no API key: the browser genuinely cannot read an architecture doc, only
   Claude Code can. Faking a progress step for work that is not happening
   here would be a lie dressed as a feature. So this panel does exactly what
   the browser can do (accept a file, show it back, hand over a command) and
   is plain about the rest.

   THE ROUND TRIP CLOSES THROUGH THE EXISTING IMPORT PATH. Once the skill has
   written a `.breakscale` file, opening it is Settings -> Open a file, or a
   drop on the canvas, unchanged. This panel never touches `topology`,
   `engine` or canvas state, so it needs nothing from `App.tsx` beyond
   whether it is open.
   ========================================================================== */

export interface ArchitectureToCodeProps {
  open: boolean;
  onClose: () => void;
}

type CopyStatus = 'idle' | 'copied' | 'failed';

const ACCEPT = '.md,text/markdown,image/png,image/jpeg,image/webp';
const PREVIEW_CHARS = 500;

function isImage(file: File): boolean {
  return file.type.startsWith('image/');
}

export function ArchitectureToCode({ open, onClose }: ArchitectureToCodeProps) {
  const { mounted, closing, unmount } = usePresence(open);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle');
  const copyTimer = useRef<number | undefined>(undefined);

  /* Reset on OPEN, matching Examples: the last session's pick should not
     linger under a reader who came back for a different file. */
  useEffect(() => {
    if (open) {
      setFile(null);
      setTextPreview(null);
      setImageUrl(null);
      setCopyStatus('idle');
    }
  }, [open]);

  useEffect(() => {
    if (!file) return;
    if (isImage(file)) {
      const url = URL.createObjectURL(file);
      setImageUrl(url);
      return () => URL.revokeObjectURL(url);
    }
    let cancelled = false;
    void file.text().then((text) => {
      if (!cancelled) setTextPreview(text.slice(0, PREVIEW_CHARS));
    });
    return () => {
      cancelled = true;
    };
  }, [file]);

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  /* Focus goes to the card itself, the same contract Shortcuts keeps: this
     dialog's first control is "pick a file", not something worth stealing
     focus for on open. */
  useEffect(() => {
    if (!open) return;
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const card = cardRef.current;
    card?.focus();
    return () => {
      const active = document.activeElement;
      const inside = card?.contains(active as Node) ?? false;
      if (inside || active === document.body || active === null) {
        opener?.focus();
      }
    };
  }, [open]);

  if (!mounted) return null;

  const command = file ? `Use the architecture-to-code skill on ${file.name}.` : null;

  const handleCopy = () => {
    if (!command) return;
    void (async () => {
      try {
        await navigator.clipboard.writeText(command);
        setCopyStatus('copied');
      } catch {
        setCopyStatus('failed');
      }
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopyStatus('idle'), 2500);
    })();
  };

  const handleSaveCopy = () => {
    if (file) downloadBlob(file, file.name);
  };

  return createPortal(
    <div
      className={`ac-root${closing ? ' is-closing' : ''}`}
      inert={closing || undefined}
    >
      <div className="ac-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={cardRef}
        className="ac-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ac-title"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        onAnimationEnd={(e) => {
          if (closing && e.target === e.currentTarget) unmount();
        }}
      >
        <header className="ac-head">
          <div>
            <h2 id="ac-title" className="ac-title">
              From an architecture doc
            </h2>
            <p className="ac-sub">
              Turn a written description or a diagram into a working example.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-icon"
            onClick={onClose}
            aria-label="Close"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <p className="ac-note">
          Breakscale does not call an AI model itself: nothing here is uploaded
          anywhere. Pick a file, and this hands it to Claude Code, which does the
          reading and the writing, in your own terminal.
        </p>

        <input
          ref={inputRef}
          type="file"
          className="app-file-input"
          accept={ACCEPT}
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const picked = e.target.files?.[0] ?? null;
            setFile(picked);
            setCopyStatus('idle');
            e.target.value = '';
          }}
        />
        <button type="button" className="btn" onClick={() => inputRef.current?.click()}>
          {file ? 'Choose a different file' : 'Choose a file'}
        </button>

        {file && (
          <>
            <div className="ac-preview">
              <p className="ac-preview-name">{file.name}</p>
              {imageUrl ? (
                <img className="ac-preview-image" src={imageUrl} alt="" />
              ) : (
                <pre className="ac-preview-text">
                  {textPreview}
                  {textPreview && textPreview.length >= PREVIEW_CHARS ? '…' : ''}
                </pre>
              )}
            </div>

            <div className="ac-command-row">
              <code className="ac-command">{command}</code>
              <button type="button" className="btn btn-sm" onClick={handleCopy}>
                Copy
              </button>
            </div>
            <p className="ac-status" role="status">
              {copyStatus === 'copied' && 'Copied.'}
              {copyStatus === 'failed' &&
                'Could not copy. Your browser blocked clipboard access.'}
            </p>

            <button type="button" className="btn" onClick={handleSaveCopy}>
              Save a copy to your downloads
            </button>
            <p className="ac-hint">
              Needed if the file came from a paste or a share sheet: Claude Code reads a
              real path, and the browser never exposes one for those.
            </p>
          </>
        )}

        <p className="ac-hint">
          When it is done, open the design it wrote the same way you open any other:
          Settings &rarr; Open a file, or drop it on the canvas.
        </p>
      </div>
    </div>,
    document.body,
  );
}
