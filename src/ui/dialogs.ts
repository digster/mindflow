/**
 * Modal dialogs and transient notifications.
 *
 * Built on the native `<dialog>` element, which supplies focus trapping, the top
 * layer, backdrop rendering and Escape-to-close for free. Reimplementing those
 * correctly — especially the focus trap — is a surprising amount of accessibility
 * work to get wrong.
 */

import { SHORTCUT_REFERENCE } from '../input/keyboard.ts';
import { PAGE_SIZES, PDF_RESOLUTIONS, type PageOrientation, type PageSizeId } from '../render/pdfLayout.ts';
import type { DriveBoard } from '../io/drive/sync.ts';
import { clear, el, icon } from './dom.ts';
import { ICONS } from './icons.ts';

/** Creates a dialog shell with a title, body and footer. */
function createDialog(
  title: string,
  body: HTMLElement,
  footer?: HTMLElement,
): HTMLDialogElement {
  const dialog = el('dialog', { class: 'mf-dialog', 'aria-label': title }) as HTMLDialogElement;

  dialog.append(
    el(
      'div',
      { class: 'mf-dialog-header' },
      el('h2', { class: 'mf-dialog-title', text: title }),
      el(
        'button',
        {
          class: 'mf-icon-button',
          type: 'button',
          'aria-label': 'Close',
          onclick: () => dialog.close(),
        },
        icon(ICONS.close, 16),
      ),
    ),
    el('div', { class: 'mf-dialog-body' }, body),
  );

  if (footer) dialog.append(el('div', { class: 'mf-dialog-footer' }, footer));

  // Clicking the backdrop closes. The event target is the dialog itself only
  // when the click landed outside the content box.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  // Remove on close so repeated opens do not accumulate detached dialogs.
  dialog.addEventListener('close', () => dialog.remove());

  return dialog;
}

function show(dialog: HTMLDialogElement): void {
  document.body.append(dialog);
  dialog.showModal();
}

/**
 * Whether a modal dialog is currently on screen.
 *
 * Queried rather than tracked in a counter because a dialog removes itself on
 * `close`, and `close` fires however it was dismissed — the button, the
 * backdrop, or Escape. A counter would have to be decremented on all three, and
 * the DOM already holds the answer.
 *
 * Exists for the drop handler, which needs to know it is being asked to replace
 * the board while the user is midway through something else. Anything else that
 * must not act over a modal should use this rather than inventing its own check.
 */
export function isModalDialogOpen(): boolean {
  return document.querySelector('dialog.mf-dialog[open]') !== null;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

let toastContainer: HTMLElement | null = null;

/**
 * Shows a transient message.
 *
 * `role="status"` with `aria-live="polite"` means a screen reader announces it
 * without interrupting whatever the user is doing. Errors linger considerably
 * longer, since they usually need to be read and acted on.
 */
export function toast(message: string, level: 'info' | 'error' = 'info'): void {
  if (!toastContainer) {
    toastContainer = el('div', {
      class: 'mf-toasts',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'false',
    });
    document.body.append(toastContainer);
  }

  const node = el('div', { class: `mf-toast mf-toast--${level}`, text: message });
  toastContainer.append(node);

  const duration = level === 'error' ? 8000 : 3200;
  setTimeout(() => {
    node.classList.add('is-leaving');
    // Match the CSS transition so the node is removed after it fades.
    setTimeout(() => node.remove(), 220);
  }, duration);
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

export function confirmDialog(options: {
  title: string;
  message: string;
  confirmLabel?: string;
  /** Label for the button that declines. Escape and the backdrop decline too. */
  cancelLabel?: string;
  destructive?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const body = el('p', { class: 'mf-dialog-text', text: options.message });
    const confirmButton = el('button', {
      class: `mf-button ${options.destructive ? 'mf-button--danger' : 'mf-button--primary'}`,
      type: 'button',
      text: options.confirmLabel ?? 'Confirm',
      onclick: () => {
        finish(true);
        dialog.close();
      },
    });

    const dialog = createDialog(
      options.title,
      body,
      el(
        'div',
        { class: 'mf-button-row' },
        el('button', {
          class: 'mf-button',
          type: 'button',
          text: options.cancelLabel ?? 'Cancel',
          onclick: () => dialog.close(),
        }),
        confirmButton,
      ),
    );

    // Covers Escape and backdrop clicks as well as the Cancel button.
    dialog.addEventListener('close', () => finish(false));
    show(dialog);
    confirmButton.focus();
  });
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

export function showShortcutsDialog(): void {
  const body = el('div', { class: 'mf-shortcuts' });

  for (const group of SHORTCUT_REFERENCE) {
    body.append(
      el(
        'section',
        { class: 'mf-shortcut-group' },
        el('h3', { class: 'mf-shortcut-heading', text: group.group }),
        el(
          'dl',
          { class: 'mf-shortcut-list' },
          ...group.items.flatMap(([keys, description]) => [
            el('dt', {}, el('kbd', { text: keys })),
            el('dd', { text: description }),
          ]),
        ),
      ),
    );
  }

  show(createDialog('Keyboard shortcuts', body));
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export type ExportFormat = 'png' | 'svg' | 'pdf' | 'json';

export interface ExportChoice {
  format: ExportFormat;
  /** PNG only: pixels per scene unit. */
  scale: number;
  /** For a PDF, the selected frames rather than the selected elements. */
  selectionOnly: boolean;
  transparent: boolean;
  /** PDF only. */
  pageSize: PageSizeId;
  /** PDF only. */
  orientation: PageOrientation;
  /** PDF only: pixels per inch of the printed page. */
  dpi: number;
}

export interface ExportDialogOptions {
  hasSelection: boolean;
  /** Visible frames on the board: the pages a PDF of the whole board has. */
  frameCount: number;
  /** Visible frames in the selection: the pages a "selection only" PDF has. */
  selectedFrameCount: number;
  /** The format selected when the dialog opens. PNG by default. */
  format?: ExportFormat;
}

/** "1 frame", "3 frames". */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function showExportDialog(options: ExportDialogOptions): Promise<ExportChoice | null> {
  const { hasSelection, frameCount, selectedFrameCount } = options;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: ExportChoice | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const select = (label: string, choices: { value: string; text: string; selected?: boolean }[]) => {
      const node = el('select', { class: 'mf-select', 'aria-label': label }) as HTMLSelectElement;
      node.append(...choices.map((choice) => el('option', choice)));
      return node;
    };
    const field = (label: string, control: HTMLElement) =>
      el('label', { class: 'mf-field' }, el('span', { class: 'mf-field-label', text: label }), control);

    const format = select('Format', [
      { value: 'png', text: 'PNG image' },
      { value: 'svg', text: 'SVG vector' },
      { value: 'pdf', text: 'PDF — one page per frame' },
      { value: 'json', text: 'MindFlow board (.mindflow.json)' },
    ]);
    format.value = options.format ?? 'png';

    const scale = select('Resolution', [
      { value: '1', text: '1× — screen resolution' },
      { value: '2', text: '2× — retina', selected: true },
      { value: '3', text: '3× — print' },
    ]);

    const pageSize = select(
      'Page size',
      PAGE_SIZES.map((size) => ({ value: size.id, text: size.label })),
    );
    const orientation = select('Orientation', [
      { value: 'auto', text: 'Auto — turn to fit each frame' },
      { value: 'portrait', text: 'Portrait' },
      { value: 'landscape', text: 'Landscape' },
    ]);
    const dpi = select(
      'PDF resolution',
      PDF_RESOLUTIONS.map((option, index) => ({
        value: String(option.dpi),
        text: option.label,
        selected: index === PDF_RESOLUTIONS.length - 1,
      })),
    );

    // Announced when it changes, since it is the only thing that says why
    // Export may be unavailable.
    const pagesHint = el('span', { class: 'mf-field-hint', 'aria-live': 'polite' });

    const selectionOnly = el('input', { type: 'checkbox', id: 'mf-export-selection' }) as HTMLInputElement;
    const selectionLabel = el('span');
    // What the user last chose, as distinct from what the checkbox shows: a
    // PDF has no use for a selection without frames, so the box is cleared and
    // disabled for it, and switching back to another format restores the choice.
    let selectionWanted = hasSelection;
    selectionOnly.addEventListener('change', () => {
      selectionWanted = selectionOnly.checked;
      sync();
    });

    const transparent = el('input', { type: 'checkbox', id: 'mf-export-transparent' }) as HTMLInputElement;

    const scaleRow = field('Resolution', scale);
    const pdfRows = el(
      'div',
      { class: 'mf-form' },
      el('div', { class: 'mf-field-pair' }, field('Page size', pageSize), field('Orientation', orientation)),
      field('Resolution', dpi),
    );
    const transparentRow = el(
      'label',
      { class: 'mf-field mf-field--inline' },
      transparent,
      el('span', { text: 'Transparent background' }),
    );

    const exportButton = el('button', {
      class: 'mf-button mf-button--primary',
      type: 'button',
      text: 'Export',
      onclick: () => {
        finish({
          format: format.value as ExportFormat,
          scale: Number(scale.value),
          selectionOnly: selectionOnly.checked,
          transparent: transparent.checked,
          pageSize: pageSize.value as PageSizeId,
          orientation: orientation.value as PageOrientation,
          dpi: Number(dpi.value),
        });
        dialog.close();
      },
    }) as HTMLButtonElement;

    // Shows the rows that apply to the chosen format, and for a PDF, how many
    // pages it will have. Resolution means nothing to vector or JSON output,
    // and a background nothing to JSON.
    const sync = () => {
      const pdf = format.value === 'pdf';
      scaleRow.hidden = format.value !== 'png';
      pdfRows.hidden = !pdf;
      pagesHint.hidden = !pdf;
      transparentRow.hidden = format.value === 'json';

      const selectionUsable = pdf ? selectedFrameCount > 0 : hasSelection;
      selectionOnly.disabled = !selectionUsable;
      selectionOnly.checked = selectionUsable && selectionWanted;
      selectionLabel.textContent = !hasSelection
        ? 'Selection only (nothing selected)'
        : pdf && !selectionUsable
          ? 'Selection only (no frames selected)'
          : 'Selection only';

      const pages = selectionOnly.checked ? selectedFrameCount : frameCount;
      pagesHint.textContent =
        pages === 0
          ? 'This board has no frames. Each frame becomes one page: draw one around each page’s content with the Frame tool (F).'
          : `${plural(pages, 'frame')} → ${plural(pages, 'page')}, in reading order. Each frame is scaled to fit its page.`;
      exportButton.disabled = pdf && pages === 0;
    };
    format.addEventListener('change', sync);

    const body = el(
      'div',
      { class: 'mf-form' },
      el('div', { class: 'mf-field' }, field('Format', format), pagesHint),
      scaleRow,
      pdfRows,
      el('label', { class: 'mf-field mf-field--inline' }, selectionOnly, selectionLabel),
      transparentRow,
    );
    sync();

    const dialog = createDialog(
      'Export',
      body,
      el(
        'div',
        { class: 'mf-button-row' },
        el('button', {
          class: 'mf-button',
          type: 'button',
          text: 'Cancel',
          onclick: () => dialog.close(),
        }),
        exportButton,
      ),
    );

    dialog.addEventListener('close', () => finish(null));
    show(dialog);
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface SettingsValues {
  clientId: string;
}

export function showSettingsDialog(
  current: SettingsValues,
  onSave: (values: SettingsValues) => void,
): void {
  const clientId = el('input', {
    class: 'mf-input',
    type: 'text',
    value: current.clientId,
    placeholder: '000000000000-xxxxxxxx.apps.googleusercontent.com',
    spellcheck: 'false',
    'aria-label': 'Google OAuth Client ID',
  }) as HTMLInputElement;

  const origin = window.location.origin === 'null' ? '(unavailable on file://)' : window.location.origin;

  const body = el(
    'div',
    { class: 'mf-form' },
    el(
      'label',
      { class: 'mf-field' },
      el('span', { class: 'mf-field-label', text: 'Google OAuth Client ID' }),
      clientId,
      el('span', {
        class: 'mf-field-hint',
        text:
          'Optional. Needed only for the Google Drive integration. Create a "Web application" ' +
          'OAuth client in the Google Cloud console and add this exact origin to its authorised ' +
          `JavaScript origins: ${origin}`,
      }),
    ),
    el(
      'div',
      { class: 'mf-note' },
      el('strong', { text: 'MindFlow only ever requests the drive.file scope. ' }),
      el('span', {
        text:
          'Google classifies it as non-sensitive: it grants access solely to files MindFlow itself ' +
          'created, never to the rest of your Drive. Files you add to the MindFlow folder by hand ' +
          'through drive.google.com will not be visible to the app.',
      }),
    ),
  );

  const dialog = createDialog(
    'Settings',
    body,
    el(
      'div',
      { class: 'mf-button-row' },
      el('button', {
        class: 'mf-button',
        type: 'button',
        text: 'Cancel',
        onclick: () => dialog.close(),
      }),
      el('button', {
        class: 'mf-button mf-button--primary',
        type: 'button',
        text: 'Save',
        onclick: () => {
          onSave({ clientId: clientId.value });
          dialog.close();
        },
      }),
    ),
  );

  show(dialog);
}

// ---------------------------------------------------------------------------
// Drive browser
// ---------------------------------------------------------------------------

export interface DriveDialogCallbacks {
  onOpen: (board: DriveBoard) => void;
  onSaveHere: () => void;
  onDelete: (board: DriveBoard) => void;
  onDisconnect: () => void;
  onOpenFolder: () => void;
}

/** Lists the boards in the Drive folder, with actions. */
export function showDriveDialog(
  folderName: string,
  boards: DriveBoard[],
  callbacks: DriveDialogCallbacks,
): HTMLDialogElement {
  const list = el('div', { class: 'mf-drive-list' });

  if (boards.length === 0) {
    list.append(
      el('p', {
        class: 'mf-dialog-text',
        text: `No boards in "${folderName}" yet. Save this board to put one there.`,
      }),
    );
  } else {
    for (const board of boards) {
      list.append(
        el(
          'div',
          { class: 'mf-drive-item' },
          el(
            'button',
            {
              class: 'mf-drive-open',
              type: 'button',
              onclick: () => {
                callbacks.onOpen(board);
                dialog.close();
              },
            },
            el('span', { class: 'mf-drive-name', text: board.name }),
            el('span', {
              class: 'mf-drive-meta',
              text: [
                board.modifiedTime ? new Date(board.modifiedTime).toLocaleString() : null,
                board.size ? `${(board.size / 1024).toFixed(0)} kB` : null,
              ]
                .filter(Boolean)
                .join(' · '),
            }),
          ),
          el(
            'button',
            {
              class: 'mf-icon-button mf-icon-button--small',
              type: 'button',
              title: `Move "${board.name}" to Drive trash`,
              'aria-label': `Move ${board.name} to Drive trash`,
              onclick: () => callbacks.onDelete(board),
            },
            icon(ICONS.trash, 15),
          ),
        ),
      );
    }
  }

  const body = el(
    'div',
    {},
    el(
      'p',
      { class: 'mf-dialog-text' },
      'Working folder: ',
      el('strong', { text: folderName }),
      ' — ',
      el('button', {
        class: 'mf-link',
        type: 'button',
        text: 'open in Drive',
        onclick: callbacks.onOpenFolder,
      }),
    ),
    list,
  );

  const dialog = createDialog(
    'Google Drive',
    body,
    el(
      'div',
      { class: 'mf-button-row mf-button-row--split' },
      el('button', {
        class: 'mf-button',
        type: 'button',
        text: 'Disconnect',
        onclick: () => {
          callbacks.onDisconnect();
          dialog.close();
        },
      }),
      el('button', {
        class: 'mf-button mf-button--primary',
        type: 'button',
        text: 'Save this board here',
        onclick: () => {
          callbacks.onSaveHere();
          dialog.close();
        },
      }),
    ),
  );

  show(dialog);
  return dialog;
}

/** Shown before the first Drive connection, so consent is never a surprise. */
export function showDriveConnectDialog(folderName: string): Promise<boolean> {
  return confirmDialog({
    title: 'Connect Google Drive',
    message:
      `MindFlow will create a folder called "${folderName}" in your Google Drive and keep your boards there.\n\n` +
      'It requests only the drive.file permission, which lets it see and manage the files it creates itself — ' +
      'never the rest of your Drive. Google will show you a consent screen next.',
    confirmLabel: 'Continue',
  });
}

/**
 * Offered on startup when the board open at the end of the last session was
 * left with unsaved changes.
 *
 * Declining is not destructive: the board stays in the recent-boards menu, and
 * the message says where to find it. Escape and the backdrop decline too, which
 * is exactly why declining must never delete anything.
 */
export function showRecoveryDialog(name: string, savedAt: string): Promise<boolean> {
  return confirmDialog({
    title: 'Recover unsaved work?',
    message:
      `"${name}" was left with unsaved changes on ${new Date(savedAt).toLocaleString()}.\n\n` +
      'Recover it now, or start with a blank board? Either way it stays under Recent boards — ' +
      'click the logo at the top left.',
    confirmLabel: 'Recover',
    cancelLabel: 'Start blank',
  });
}

/** Reports load warnings when a file needed repairs to open. */
export function showLoadWarnings(warnings: { level: string; path: string; message: string }[]): void {
  const serious = warnings.filter((warning) => warning.level !== 'info');
  if (serious.length === 0) return;

  const body = el(
    'div',
    {},
    el('p', {
      class: 'mf-dialog-text',
      text: 'The board opened, but some things needed attention:',
    }),
    el(
      'ul',
      { class: 'mf-warning-list' },
      ...serious.slice(0, 20).map((warning) =>
        el(
          'li',
          { class: `mf-warning mf-warning--${warning.level}` },
          el('code', { text: warning.path }),
          el('span', { text: ` ${warning.message}` }),
        ),
      ),
    ),
    serious.length > 20
      ? el('p', { class: 'mf-dialog-text', text: `…and ${serious.length - 20} more.` })
      : null,
  );

  show(createDialog('Board opened with warnings', body));
}
