/**
 * Application shell.
 *
 * Builds the DOM, constructs every subsystem and wires them together. Deliberately
 * the only file that knows about all of them — the store, renderer, controller,
 * UI and IO modules each know nothing about each other, and are composed here.
 */

import type { MindflowElement, Point } from '../model/types.ts';
import { FILE_EXTENSION } from '../model/types.ts';
import { Store, type BoardOrigin } from '../store/store.ts';
import { addElements, setCanvasSettings, renameBoard } from '../store/commands.ts';
import { Renderer } from '../render/renderer.ts';
import { ImageCache } from '../render/images.ts';
import { drawOverlay } from '../render/overlay.ts';
import { exportToPNG, exportToSVG } from '../render/export.ts';
import { InteractionController } from '../input/controller.ts';
import { installKeyboardShortcuts } from '../input/keyboard.ts';
import { screenToScene } from '../model/geometry.ts';
import { serializeDocument, type LoadResult } from '../model/document.ts';
import { Actions } from './actions.ts';
import { Toolbar } from '../ui/toolbar.ts';
import { StylePanel } from '../ui/stylePanel.ts';
import { TextEditor } from '../ui/textEditor.ts';
import { showContextMenu } from '../ui/contextMenu.ts';
import { closePopover } from '../ui/popover.ts';
import {
  confirmDialog,
  showDriveConnectDialog,
  showDriveDialog,
  showExportDialog,
  showLoadWarnings,
  showRecoveryDialog,
  showSettingsDialog,
  showShortcutsDialog,
  toast,
} from '../ui/dialogs.ts';
import {
  downloadBlob,
  openFromFile,
  pickImageFile,
  readBoardFile,
  saveToFile,
  supportsFileSystemAccess,
  toFileName,
} from '../io/localFile.ts';
import { Autosave } from '../io/autosave.ts';
import { findImageFile, prepareImageImport } from '../io/imageImport.ts';
import { getClientId, isOriginSupported, disconnect, setClientId } from '../io/drive/auth.ts';
import {
  defaultFolderName,
  folderUrl,
  forgetFolder,
  listBoards,
  openBoard,
  resolveFolder,
  saveBoard,
  deleteBoard,
  type DriveBoard,
} from '../io/drive/sync.ts';
import { el } from '../ui/dom.ts';

export class MindflowApp {
  private readonly store = new Store();
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: Renderer;
  private readonly images: ImageCache;
  private readonly controller: InteractionController;
  private readonly actions: Actions;
  private readonly toolbar: Toolbar;
  private readonly stylePanel: StylePanel;
  private readonly textEditor: TextEditor;
  private readonly autosave: Autosave;
  private readonly disposers: (() => void)[] = [];

  /** Cached Drive folder for the session, so we resolve it once. */
  private driveFolder: { id: string; name: string } | null = null;

  constructor(private readonly root: HTMLElement) {
    this.canvas = el('canvas', { class: 'mf-canvas', 'aria-label': 'Whiteboard canvas' });

    this.images = new ImageCache(() => this.renderer.invalidate());
    this.renderer = new Renderer({
      canvas: this.canvas,
      drawOverlay: (render) =>
        drawOverlay(render, {
          selected: this.store.selectedElements(),
          hovered: this.controller.hovered,
          marquee: this.controller.marquee,
          bindingCandidates: this.controller.bindingCandidates,
          guides: this.controller.guides,
          viewport: this.store.viewport,
          editing: this.store.getState().editingId !== null,
        }),
    });

    this.actions = new Actions({
      store: this.store,
      getViewportSize: () => this.renderer.size,
      notify: toast,
    });

    this.textEditor = new TextEditor(this.store);

    this.controller = new InteractionController({
      canvas: this.canvas,
      store: this.store,
      onEditText: (element) => this.textEditor.open(element),
      onOverlayChange: () => this.renderer.invalidate(),
      onRequestImage: (point) => void this.insertImageAtPoint(point),
      onContextMenu: ({ scene, screen, hit }) =>
        showContextMenu({ store: this.store, actions: this.actions, scene, screen, hit }),
    });

    this.toolbar = new Toolbar(this.store, this.actions, {
      onNew: () => void this.newBoard(),
      onOpen: () => void this.openBoardFile(),
      onSave: () => void this.save(),
      onExport: () => void this.exportBoard(),
      onDrive: () => void this.openDrive(),
      onHelp: () => showShortcutsDialog(),
      onSettings: () => this.openSettings(),
      onToggleGrid: () => this.toggleGrid(),
      onRename: (name) => this.store.execute(renameBoard(this.store.document, name)),
    });

    this.stylePanel = new StylePanel(this.store, this.actions);
    this.autosave = new Autosave((error) => {
      console.warn('[mindflow] autosave disabled', error);
      toast('Autosave is unavailable — your browser refused local storage. Save to a file instead.', 'error');
    });

    this.mount();
    this.wire();
    void this.startup();
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  private mount(): void {
    this.root.append(
      this.toolbar.topBarElement,
      el(
        'main',
        { class: 'mf-main' },
        this.toolbar.toolbarElement,
        el('div', { class: 'mf-canvas-wrap' }, this.canvas, this.textEditor.element),
        this.stylePanel.element,
      ),
    );
    this.renderer.resize();
    this.pushScene();
  }

  private wire(): void {
    // ---- Store → view ----------------------------------------------------
    this.disposers.push(
      this.store.subscribe((state, reason) => {
        if (reason === 'document' || reason === 'load') {
          this.images.sync(state.document);
          this.autosave.schedule(state.document, state.preserved);
        }
        if (reason === 'load') {
          this.images.prune(state.document);
        }
        if (reason === 'viewport' || reason === 'load') {
          this.textEditor.reposition();
        }
        if (reason === 'selection' || reason === 'document' || reason === 'load') {
          this.stylePanel.sync();
        }
        this.toolbar.sync();
        this.pushScene();
      }),
    );

    // ---- Resize ----------------------------------------------------------
    const resizeObserver = new ResizeObserver(() => {
      this.renderer.resize();
      this.textEditor.reposition();
    });
    resizeObserver.observe(this.canvas);
    this.disposers.push(() => resizeObserver.disconnect());

    // ---- Keyboard --------------------------------------------------------
    this.disposers.push(
      installKeyboardShortcuts({
        store: this.store,
        actions: this.actions,
        onSave: () => void this.save(),
        onSaveAs: () => void this.save(true),
        onOpen: () => void this.openBoardFile(),
        onNew: () => void this.newBoard(),
        onExport: () => void this.exportBoard(),
        onSpaceChange: (held) => this.controller.setSpaceHeld(held),
      }),
    );

    // ---- Clipboard -------------------------------------------------------
    // Native clipboard events carry image data that the keyboard handler cannot
    // reach, which is what makes pasting a screenshot work.
    const onPaste = (event: ClipboardEvent) => {
      if (this.textEditor.isEditing) return;
      const image = findImageFile(event.clipboardData?.items ?? null);
      if (image) {
        event.preventDefault();
        void this.insertImageFile(image, this.viewportCenter());
        return;
      }
      event.preventDefault();
      void this.actions.paste();
    };
    window.addEventListener('paste', onPaste);
    this.disposers.push(() => window.removeEventListener('paste', onPaste));

    // ---- Drag and drop ---------------------------------------------------
    const onDragOver = (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      const files = event.dataTransfer?.files;
      const file = files?.[0];
      if (!file) return;

      const rect = this.canvas.getBoundingClientRect();
      const point = screenToScene(
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        this.store.viewport,
      );

      if (file.type.startsWith('image/')) void this.insertImageFile(file, point);
      else void this.openDroppedBoard(file);
    };
    this.canvas.addEventListener('dragover', onDragOver);
    this.canvas.addEventListener('drop', onDrop);
    this.disposers.push(() => {
      this.canvas.removeEventListener('dragover', onDragOver);
      this.canvas.removeEventListener('drop', onDrop);
    });

    // ---- Unsaved-work guard ----------------------------------------------
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!this.store.getState().dirty) return;
      // Flush the autosave synchronously-ish so a confirmed navigation still
      // leaves a recovery record behind.
      void this.autosave.saveNow(this.store.document, this.store.getState().preserved);
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    this.disposers.push(() => window.removeEventListener('beforeunload', onBeforeUnload));
  }

  private pushScene(): void {
    this.renderer.setScene(this.store.document, this.store.viewport, this.images.images);
  }

  private viewportCenter(): Point {
    const { width, height } = this.renderer.size;
    return screenToScene({ x: width / 2, y: height / 2 }, this.store.viewport);
  }

  /** Offers to restore an autosave left behind by a previous session. */
  private async startup(): Promise<void> {
    const record = await this.autosave.recover();
    if (!record) return;

    try {
      const recovered = await confirmRecovery(record.name, record.savedAt);
      if (!recovered) {
        await this.autosave.clear();
        return;
      }
      const { loadDocument } = await import('../model/document.ts');
      const result = loadDocument(record.contents);
      this.applyLoad(result, { kind: 'new' });
      // The recovered board is unsaved by definition.
      this.store.markDirty();
      toast('Recovered your unsaved board.');
    } catch (error) {
      console.error('[mindflow] recovery failed', error);
      toast('Could not recover the previous board.', 'error');
      await this.autosave.clear();
    }
  }

  // -------------------------------------------------------------------------
  // Board lifecycle
  // -------------------------------------------------------------------------

  private applyLoad(result: LoadResult, origin: BoardOrigin): void {
    // An open editor must never outlive the document it was editing. Blur alone
    // is not enough to rely on: whether clicking a toolbar button moves focus
    // out of a textarea is a platform convention, not a guarantee — macOS
    // browsers traditionally do not focus buttons on click. Left open, the
    // editor floats over the incoming board still showing the old one's text.
    this.textEditor.commit();
    // Same argument for a popover: a context menu still listing "Ungroup" for
    // elements that no longer exist would act on a stale selection.
    closePopover();
    this.images.clear();
    this.store.load(result, origin);
    this.images.sync(result.document);
    showLoadWarnings(result.warnings);
  }

  private async confirmDiscard(): Promise<boolean> {
    if (!this.store.getState().dirty) return true;
    return confirmDialog({
      title: 'Discard unsaved changes?',
      message: 'This board has changes that have not been saved. Continue and lose them?',
      confirmLabel: 'Discard',
      destructive: true,
    });
  }

  private async newBoard(): Promise<void> {
    // Before confirmDiscard, not after: a pending edit is part of the board
    // being left, so it has to land before the user is asked whether losing the
    // board's changes is acceptable. See applyLoad for why blur is not enough.
    this.textEditor.commit();
    closePopover();
    if (!(await this.confirmDiscard())) return;
    this.images.clear();
    this.store.reset();
    void this.autosave.clear();
  }

  private async openBoardFile(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    try {
      const opened = await openFromFile();
      if (!opened) return;
      this.applyLoad(opened.result, {
        kind: 'local',
        name: opened.name,
        handle: opened.handle,
      });
      void this.autosave.clear();
      toast(`Opened ${opened.name}`);
    } catch (error) {
      toast(errorMessage(error, 'Could not open that file.'), 'error');
    }
  }

  private async openDroppedBoard(file: File): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    try {
      const result = await readBoardFile(file);
      this.applyLoad(result, { kind: 'local', name: file.name });
      toast(`Opened ${file.name}`);
    } catch (error) {
      toast(errorMessage(error, 'That file is not a MindFlow board.'), 'error');
    }
  }

  /** Saves back to wherever the board came from, or prompts when it is new. */
  private async save(saveAs = false): Promise<void> {
    const state = this.store.getState();
    const document = this.store.documentForSave();

    try {
      if (!saveAs && state.origin.kind === 'drive') {
        await this.saveToDrive(state.origin.fileId, state.origin.name);
        return;
      }

      const existingHandle = state.origin.kind === 'local' ? state.origin.handle : undefined;
      const result = await saveToFile(document, state.preserved, { existingHandle, saveAs });

      this.store.markSaved({ kind: 'local', name: result.name, handle: result.handle });
      void this.autosave.clear();

      toast(
        result.viaDownload
          ? `Downloaded ${result.name}. This browser cannot save back to a file in place, so each save creates a new download.`
          : `Saved ${result.name}`,
      );
    } catch (error) {
      if ((error as Error).name === 'AbortError') return; // Picker dismissed.
      toast(errorMessage(error, 'Could not save the board.'), 'error');
    }
  }

  private async exportBoard(): Promise<void> {
    const hasSelection = this.store.selectedIds().length > 0;
    const choice = await showExportDialog(hasSelection);
    if (!choice) return;

    const document = this.store.documentForSave();
    const elements = choice.selectionOnly ? this.store.selectedElements() : document.elements;
    const baseName = toFileName(document.meta.name).replace(FILE_EXTENSION, '');

    try {
      if (choice.format === 'json') {
        const contents = serializeDocument(document, this.store.getState().preserved);
        downloadBlob(new Blob([contents], { type: 'application/json' }), `${baseName}${FILE_EXTENSION}`);
      } else if (choice.format === 'svg') {
        const svg = exportToSVG(document, { elements, background: !choice.transparent });
        downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${baseName}.svg`);
      } else {
        const blob = await exportToPNG(document, this.images.images, {
          elements,
          scale: choice.scale,
          background: !choice.transparent,
        });
        downloadBlob(blob, `${baseName}.png`);
      }
      toast('Exported.');
    } catch (error) {
      toast(errorMessage(error, 'Export failed.'), 'error');
    }
  }

  // -------------------------------------------------------------------------
  // Images
  // -------------------------------------------------------------------------

  private async insertImageAtPoint(point: Point): Promise<void> {
    const file = await pickImageFile();
    if (file) await this.insertImageFile(file, point);
  }

  private async insertImageFile(file: File, at: Point): Promise<void> {
    try {
      const imported = await prepareImageImport(this.store.document, file, at);

      // Assets live outside the command system — see `Store.addFiles` for why.
      if (!imported.deduplicated) {
        this.store.addFiles({ [imported.fileId]: imported.file });
      }

      this.store.execute(addElements([imported.element], 'Add image'));
      this.store.setSelection([imported.element.id]);
      this.images.sync(this.store.document);
    } catch (error) {
      toast(errorMessage(error, 'Could not add that image.'), 'error');
    }
  }

  // -------------------------------------------------------------------------
  // Canvas settings
  // -------------------------------------------------------------------------

  private toggleGrid(): void {
    const { canvas } = this.store.document;
    const visible = !canvas.grid.visible;
    this.store.execute(
      setCanvasSettings(
        this.store.document,
        // Turning the grid on enables snapping too; a visible grid you cannot
        // snap to is a decoration, and separating the two is a setting nobody
        // asks for.
        { ...canvas, grid: { ...canvas.grid, visible, snap: visible } },
        visible ? 'Show grid' : 'Hide grid',
      ),
    );
  }

  private openSettings(): void {
    showSettingsDialog({ clientId: getClientId() }, (values) => {
      setClientId(values.clientId);
      toast('Settings saved.');
    });
  }

  // -------------------------------------------------------------------------
  // Google Drive
  // -------------------------------------------------------------------------

  private async openDrive(): Promise<void> {
    if (!isOriginSupported()) {
      toast(
        'Google Drive needs a real web address. This page was opened directly from disk, where sign-in is not possible. Use the hosted version, or run `npm run serve`.',
        'error',
      );
      return;
    }

    if (getClientId() === '') {
      toast('Add a Google OAuth Client ID in Settings to use Drive.', 'error');
      this.openSettings();
      return;
    }

    try {
      if (!this.driveFolder) {
        const proceed = await showDriveConnectDialog(defaultFolderName());
        if (!proceed) return;
        const folder = await resolveFolder();
        this.driveFolder = { id: folder.id, name: folder.name };
        if (folder.created) toast(`Created "${folder.name}" in your Google Drive.`);
      }

      const boards = await listBoards(this.driveFolder.id);
      showDriveDialog(this.driveFolder.name, boards, {
        onOpen: (board) => void this.openFromDrive(board),
        onSaveHere: () => void this.saveToDrive(),
        onDelete: (board) => void this.deleteFromDrive(board),
        onDisconnect: () => void this.disconnectDrive(),
        onOpenFolder: () => {
          if (this.driveFolder) window.open(folderUrl(this.driveFolder.id), '_blank', 'noopener');
        },
      });
    } catch (error) {
      toast(errorMessage(error, 'Could not reach Google Drive.'), 'error');
    }
  }

  private async openFromDrive(board: DriveBoard): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    try {
      const opened = await openBoard(board.id, board.name);
      this.applyLoad(opened.result, { kind: 'drive', fileId: opened.fileId, name: opened.name });
      void this.autosave.clear();
      toast(`Opened ${board.name} from Drive.`);
    } catch (error) {
      toast(errorMessage(error, 'Could not open that board from Drive.'), 'error');
    }
  }

  private async saveToDrive(fileId?: string, name?: string): Promise<void> {
    try {
      if (!this.driveFolder) {
        const folder = await resolveFolder();
        this.driveFolder = { id: folder.id, name: folder.name };
      }

      const state = this.store.getState();
      const saved = await saveBoard(this.store.documentForSave(), state.preserved, {
        folderId: this.driveFolder.id,
        fileId: fileId ?? (state.origin.kind === 'drive' ? state.origin.fileId : undefined),
        name,
      });

      this.store.markSaved({ kind: 'drive', fileId: saved.fileId, name: saved.name });
      void this.autosave.clear();
      toast(saved.created ? `Saved ${saved.name} to Drive.` : `Updated ${saved.name} in Drive.`);
    } catch (error) {
      toast(errorMessage(error, 'Could not save to Drive.'), 'error');
    }
  }

  private async deleteFromDrive(board: DriveBoard): Promise<void> {
    const confirmed = await confirmDialog({
      title: 'Move to Drive trash?',
      message: `"${board.name}" will be moved to your Google Drive trash. You can restore it from Drive.`,
      confirmLabel: 'Move to trash',
      destructive: true,
    });
    if (!confirmed) return;

    try {
      await deleteBoard(board.id);
      toast(`Moved ${board.name} to trash.`);
      void this.openDrive(); // Refresh the listing.
    } catch (error) {
      toast(errorMessage(error, 'Could not move that board to trash.'), 'error');
    }
  }

  private async disconnectDrive(): Promise<void> {
    await disconnect();
    forgetFolder();
    this.driveFolder = null;
    if (this.store.getState().origin.kind === 'drive') {
      this.store.setOrigin({ kind: 'new' });
    }
    toast('Disconnected from Google Drive.');
  }

  // -------------------------------------------------------------------------

  destroy(): void {
    for (const dispose of this.disposers) dispose();
    this.controller.destroy();
    this.renderer.destroy();
    this.images.clear();
    this.autosave.cancel();
  }

  /** Exposed for end-to-end tests to drive the app without synthesising input. */
  get testHooks(): { store: Store; actions: Actions; supportsFileSystemAccess: boolean } {
    return { store: this.store, actions: this.actions, supportsFileSystemAccess: supportsFileSystemAccess() };
  }
}

function confirmRecovery(name: string, savedAt: string): Promise<boolean> {
  return showRecoveryDialog(name, savedAt);
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

// Re-exported so `MindflowElement` stays available to consumers of this module
// without a second import path.
export type { MindflowElement };
