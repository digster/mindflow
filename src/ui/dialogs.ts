/**
 * Modal dialogs and transient notifications.
 *
 * Built on the native `<dialog>` element, which supplies focus trapping, the top
 * layer, backdrop rendering and Escape-to-close for free. Reimplementing those
 * correctly — especially the focus trap — is a surprising amount of accessibility
 * work to get wrong.
 */

import { SHORTCUT_REFERENCE } from '../input/keyboard.ts';
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
          text: 'Cancel',
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

export interface ExportChoice {
  format: 'png' | 'svg' | 'json';
  scale: number;
  selectionOnly: boolean;
  transparent: boolean;
}

export function showExportDialog(hasSelection: boolean): Promise<ExportChoice | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: ExportChoice | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const format = el('select', { class: 'mf-select', 'aria-label': 'Format' }) as HTMLSelectElement;
    format.append(
      el('option', { value: 'png', text: 'PNG image' }),
      el('option', { value: 'svg', text: 'SVG vector' }),
      el('option', { value: 'json', text: 'MindFlow board (.mindflow.json)' }),
    );

    const scale = el('select', { class: 'mf-select', 'aria-label': 'Resolution' }) as HTMLSelectElement;
    scale.append(
      el('option', { value: '1', text: '1× — screen resolution' }),
      el('option', { value: '2', text: '2× — retina', selected: true }),
      el('option', { value: '3', text: '3× — print' }),
    );

    const selectionOnly = el('input', { type: 'checkbox', id: 'mf-export-selection' }) as HTMLInputElement;
    selectionOnly.disabled = !hasSelection;
    selectionOnly.checked = hasSelection;

    const transparent = el('input', { type: 'checkbox', id: 'mf-export-transparent' }) as HTMLInputElement;

    const scaleRow = el(
      'label',
      { class: 'mf-field' },
      el('span', { class: 'mf-field-label', text: 'Resolution' }),
      scale,
    );

    // Resolution is meaningless for vector and JSON output.
    const syncRows = () => {
      scaleRow.hidden = format.value !== 'png';
      transparentRow.hidden = format.value === 'json';
    };
    const transparentRow = el(
      'label',
      { class: 'mf-field mf-field--inline' },
      transparent,
      el('span', { text: 'Transparent background' }),
    );
    format.addEventListener('change', syncRows);

    const body = el(
      'div',
      { class: 'mf-form' },
      el(
        'label',
        { class: 'mf-field' },
        el('span', { class: 'mf-field-label', text: 'Format' }),
        format,
      ),
      scaleRow,
      el(
        'label',
        { class: 'mf-field mf-field--inline' },
        selectionOnly,
        el('span', { text: hasSelection ? 'Selection only' : 'Selection only (nothing selected)' }),
      ),
      transparentRow,
    );
    syncRows();

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
        el('button', {
          class: 'mf-button mf-button--primary',
          type: 'button',
          text: 'Export',
          onclick: () => {
            finish({
              format: format.value as ExportChoice['format'],
              scale: Number(scale.value),
              selectionOnly: selectionOnly.checked,
              transparent: transparent.checked,
            });
            dialog.close();
          },
        }),
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

/** Offered on startup when an autosave from a previous session is found. */
export function showRecoveryDialog(name: string, savedAt: string): Promise<boolean> {
  return confirmDialog({
    title: 'Recover unsaved work?',
    message:
      `A board called "${name}" was left unsaved on ${new Date(savedAt).toLocaleString()}.\n\n` +
      'Recover it, or discard it and start with a blank board?',
    confirmLabel: 'Recover',
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
