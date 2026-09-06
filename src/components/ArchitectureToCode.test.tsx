// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ArchitectureToCode } from './ArchitectureToCode';

let container: HTMLDivElement;
let root: Root;

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function render(ui: React.ReactNode): void {
  act(() => root.render(ui));
}

describe('ArchitectureToCode component', () => {
  it('does not render dialog in DOM when closed', () => {
    render(<ArchitectureToCode open={false} onClose={vi.fn()} />);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders modal dialog with accessible title and ARIA attributes when open', () => {
    render(<ArchitectureToCode open={true} onClose={vi.fn()} />);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toBe('ac-title');

    const title = document.getElementById('ac-title');
    expect(title?.textContent).toBe('From an architecture doc');
  });

  it('calls onClose when close button is clicked', () => {
    const handleClose = vi.fn();
    render(<ArchitectureToCode open={true} onClose={handleClose} />);

    const closeBtn = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Close"]',
    );
    expect(closeBtn).not.toBeNull();
    act(() => closeBtn?.click());
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when scrim is clicked', () => {
    const handleClose = vi.fn();
    render(<ArchitectureToCode open={true} onClose={handleClose} />);

    const scrim = document.querySelector<HTMLElement>('.ac-scrim');
    expect(scrim).not.toBeNull();
    act(() => scrim?.click());
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape key is pressed on the card', () => {
    const handleClose = vi.fn();
    render(<ArchitectureToCode open={true} onClose={handleClose} />);

    const card = document.querySelector<HTMLElement>('.ac-card');
    expect(card).not.toBeNull();
    act(() => {
      card?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('previews text file and displays skill prompt when markdown file is selected', async () => {
    render(<ArchitectureToCode open={true} onClose={vi.fn()} />);

    const fileInput = document.querySelector<HTMLInputElement>('.app-file-input');
    expect(fileInput).not.toBeNull();

    const fileContent = '# My Microservices\nAPI gateway routing to auth and billing.';
    const file = new File([fileContent], 'system-doc.md', { type: 'text/markdown' });

    // Mock file.text() for jsdom compatibility if needed
    if (!file.text) {
      file.text = () => Promise.resolve(fileContent);
    }

    await act(async () => {
      Object.defineProperty(fileInput, 'files', {
        value: [file],
        writable: false,
      });
      fileInput?.dispatchEvent(new Event('change', { bubbles: true }));
      // Allow promise to resolve
      await Promise.resolve();
    });

    const command = document.querySelector('.ac-command');
    expect(command?.textContent).toBe(
      'Use the architecture-to-code skill on system-doc.md.',
    );

    const previewName = document.querySelector('.ac-preview-name');
    expect(previewName?.textContent).toBe('system-doc.md');

    const previewText = document.querySelector('.ac-preview-text');
    expect(previewText?.textContent).toContain('# My Microservices');
  });

  it('copies command to clipboard when Copy button is clicked', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    render(<ArchitectureToCode open={true} onClose={vi.fn()} />);

    const fileInput = document.querySelector<HTMLInputElement>('.app-file-input');
    const file = new File(['content'], 'diagram.png', { type: 'image/png' });
    globalThis.URL.createObjectURL = vi.fn().mockReturnValue('blob:test-image');
    globalThis.URL.revokeObjectURL = vi.fn();

    await act(async () => {
      Object.defineProperty(fileInput, 'files', {
        value: [file],
        writable: false,
      });
      fileInput?.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const copyBtn = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Copy',
    );
    expect(copyBtn).toBeDefined();

    await act(async () => {
      copyBtn?.click();
      await Promise.resolve();
    });

    expect(writeTextMock).toHaveBeenCalledWith(
      'Use the architecture-to-code skill on diagram.png.',
    );

    const status = document.querySelector('.ac-status');
    expect(status?.textContent).toBe('Copied.');
  });
});
