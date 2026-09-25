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
import { roughOutlineFor } from '../render/rough.ts';
import { labelBoxOf } from '../model/registry.ts';
import { layoutText } from '../render/shapes/shared.ts';
import { InteractionController } from '../input/controller.ts';
import { installKeyboardShortcuts, isTypingTarget } from '../input/keyboard.ts';
import { createPasteGate } from '../input/pasteGate.ts';
import { blockPageZoom } from '../input/pageZoom.ts';
import { screenToScene } from '../model/geometry.ts';
import { PALETTE } from '../model/defaults.ts';
import { loadDocument, serializeDocument, type LoadResult } from '../model/document.ts';
import { Actions } from './actions.ts';
import { Toolbar, type ToolbarCallbacks } from '../ui/toolbar.ts';
import { showCommandPalette } from '../ui/commandPalette.ts';
import { showRecentBoardsMenu } from '../ui/recentBoards.ts';
import { showFindBar } from '../ui/findBar.ts';
import { buildCommands } from './commands.ts';
import { StylePanel } from '../ui/stylePanel.ts';
import { TextEditor } from '../ui/textEditor.ts';
import { showContextMenu } from '../ui/contextMenu.ts';
import { closePopover } from '../ui/popover.ts';
import { openColorPopover } from '../ui/colorPicker.ts';
import {
  confirmDialog,
  showDriveConnectDialog,
  showDriveDialog,
  showExportDialog,
  isModalDialogOpen,
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
import { Autosave, type BoardSnapshot, type RecentBoard } from '../io/autosave.ts';
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
  /** Shared by the toolbar and the command palette; see the constructor. */
  private readonly appCallbacks: ToolbarCallbacks;
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
      // The element under the open text editor is painted without the text the
      // editor is showing, so there is only ever one copy of it on screen.
      displayed: (element) => this.textEditor.displayed(element),
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
      onEditText: (element, regionKey) => this.textEditor.open(element, regionKey),
      onCommitText: () => this.textEditor.commit(),
      onOverlayChange: () => this.renderer.invalidate(),
      onRequestImage: (point) => void this.insertImageAtPoint(point),
      onContextMenu: ({ scene, screen, hit }) =>
        showContextMenu({ store: this.store, actions: this.actions, scene, screen, hit }),
    });

    // Held as a field rather than passed inline: the command palette renders the
    // same actions, and a second copy of these callbacks is a second place for
    // them to drift.
    this.appCallbacks = {
      onNew: () => void this.newBoard(),
      onOpen: () => void this.openBoardFile(),
      onSave: () => void this.save(),
      onExport: () => void this.exportBoard(),
      onDrive: () => void this.openDrive(),
      onHelp: () => showShortcutsDialog(),
      onSettings: () => this.openSettings(),
      onToggleGrid: () => this.toggleGrid(),
      onBackground: (at) => this.openBackgroundPicker(at),
      onRename: (name) => this.store.execute(renameBoard(this.store.document, name)),
      onRecentBoards: () => void this.openRecentBoards(),
    };

    this.toolbar = new Toolbar(this.store, this.actions, this.appCallbacks);

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
          // A load is written too, not only an edit: that is what puts a board
          // opened from a file or from Drive into the recent-boards menu.
          this.autosave.schedule(this.snapshot());
        }
        if (reason === 'saved') {
          // Immediately rather than debounced. The only change is the copy's
          // `unsaved` flag, and a tab closed within the debounce would otherwise
          // offer a board that was just saved as unsaved work on next launch.
          void this.autosave.saveNow(this.snapshot());
        }
        if (reason === 'load') {
          this.images.prune(state.document);
          void this.autosave.markOpen(state.document.id);
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

    // ---- Page zoom -------------------------------------------------------
    // A pinch on a touchscreen zooms the board, never the page around it. The
    // CSS and the viewport meta do most of this. This covers iOS Safari, which
    // ignores both in places. See `input/pageZoom.ts` for which layer covers what.
    this.disposers.push(blockPageZoom(document, navigator.maxTouchPoints > 0));

    // ---- Resize ----------------------------------------------------------
    const resizeObserver = new ResizeObserver(() => {
      this.renderer.resize();
      this.textEditor.reposition();
    });
    resizeObserver.observe(this.canvas);
    this.disposers.push(() => resizeObserver.disconnect());

    // ---- Keyboard --------------------------------------------------------
    // Shared by the Cmd+V shortcut and the native `paste` listener below, which
    // can both fire for one keypress; the gate lets exactly one of them paste.
    const pasteGate = createPasteGate({ fallback: () => void this.actions.paste() });
    this.disposers.push(() => pasteGate.dispose());

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
        onCommandPalette: () => this.openCommandPalette(),
        onFind: () => showFindBar(this.store, this.actions),
        onToggleStylePanel: () => this.stylePanel.toggleCollapsed(),
        onCommitText: () => this.textEditor.commit(),
        onPasteShortcut: () => pasteGate.shortcut(),
      }),
    );

    // ---- Clipboard -------------------------------------------------------
    // Native clipboard events carry image data that the keyboard handler cannot
    // reach, which is what makes pasting a screenshot work.
    //
    // The listener is on `window` because a canvas has nothing focusable to
    // attach to, which means it also sees pastes that bubbled up out of a
    // focused field in the chrome — the board name, the find bar, the command
    // palette, the Settings client ID. Those must fall through untouched: the
    // `preventDefault` below cancels the browser's own text insertion, so
    // claiming them would leave a field that can be typed into but not pasted
    // into, and would drop a stray copy of the board clipboard on the canvas
    // besides.
    //
    // When this event arrives it takes the press from the keyboard fallback,
    // which is what stops Cmd+V pasting twice. One that arrives after the
    // fallback has already pasted is claimed and discarded instead.
    const onPaste = (event: ClipboardEvent) => {
      if (isTypingTarget(event.target) || this.textEditor.isEditing) return;
      event.preventDefault();
      if (!pasteGate.native()) return;

      const image = findImageFile(event.clipboardData?.items ?? null);
      if (image) void this.insertImageFile(image, this.viewportCenter());
      else void this.actions.paste();
    };
    window.addEventListener('paste', onPaste);
    this.disposers.push(() => window.removeEventListener('paste', onPaste));

    // ---- Drag and drop ---------------------------------------------------
    // On `window` rather than the canvas, and that is the entire point: the
    // browser's default action for a file dropped on a page is to *navigate to
    // that file*, taking the app and any unsaved board with it. Listening on the
    // canvas alone leaves the top bar, the tool rail, the style panel and every
    // dialog as live minefields, where a drop a few pixels wide of the board is
    // indistinguishable from a crash.
    //
    // A drag carrying no files is left completely alone. Dragging selected text
    // into the board-name field is the browser's business, and claiming every
    // drag in order to catch the file ones would break it for nothing — the same
    // rule the paste handler and the keyboard shortcuts follow.
    const isFileDrag = (event: DragEvent): boolean =>
      event.dataTransfer?.types.includes('Files') ?? false;

    const onDragOver = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      // Not optional: without a prevented `dragover` there is no `drop` event to
      // handle, and the navigation happens regardless.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };

    const onDrop = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();

      // Claimed above, then deliberately discarded: replacing the board out from
      // under an open Settings or Drive dialog is worse than ignoring the drop.
      // The `preventDefault` still had to run — swallowing is the point.
      if (isModalDialogOpen()) return;

      const file = event.dataTransfer?.files?.[0];
      if (!file) return;

      // Dropped on the chrome rather than the board, there is no meaningful
      // scene point under the cursor, so an image lands at the viewport centre —
      // the same fallback pasting an image already uses. A board file replaces
      // the document wholesale and ignores the point entirely.
      const rect = this.canvas.getBoundingClientRect();
      const point =
        event.target === this.canvas
          ? screenToScene(
              { x: event.clientX - rect.left, y: event.clientY - rect.top },
              this.store.viewport,
            )
          : this.viewportCenter();

      if (file.type.startsWith('image/')) void this.insertImageFile(file, point);
      else void this.openDroppedBoard(file);
    };

    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    this.disposers.push(() => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    });

    // ---- Unsaved-work guard ----------------------------------------------
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      // Flushed whether or not the board is dirty: a save a moment ago may
      // still be waiting to record itself, and the menu should see it.
      void this.autosave.flush();
      if (!this.store.getState().dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    this.disposers.push(() => window.removeEventListener('beforeunload', onBeforeUnload));

    // `beforeunload` never fires when a mobile browser discards a backgrounded
    // tab, or when an iPad's app switcher closes it. Becoming hidden is the last
    // moment a page is reliably given, so pending edits are written then too.
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') void this.autosave.flush();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    this.disposers.push(() => document.removeEventListener('visibilitychange', onVisibilityChange));
  }

  private pushScene(): void {
    this.renderer.setScene(this.store.document, this.store.viewport, this.images.images);
  }

  private viewportCenter(): Point {
    const { width, height } = this.renderer.size;
    return screenToScene({ x: width / 2, y: height / 2 }, this.store.viewport);
  }

  /**
   * Offers back the board that was open when the last session ended, if it was
   * left with unsaved changes.
   *
   * Only that board, never an older one. Every board keeps a copy now, so "is
   * there unsaved work anywhere" is almost always yes. Asking about all of it on
   * every launch would turn a recovery prompt into a nag. Older boards wait in
   * the recent-boards menu instead.
   */
  private async startup(): Promise<void> {
    try {
      const board = await this.autosave.unsavedFromLastSession();
      if (!board) return;
      // Declining leaves the board where it is. See `showRecoveryDialog`.
      if (!(await showRecoveryDialog(board.name, board.savedAt))) return;
      if (await this.loadRecent(board)) toast('Recovered your unsaved board.');
    } finally {
      // Whatever is on screen now is the board a crash would interrupt. Without
      // this, declining would leave the marker on the old board and the same
      // prompt would come back on every launch.
      void this.autosave.markOpen(this.store.document.id);
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

  /**
   * Opens the command palette.
   *
   * Commands are rebuilt per invocation rather than cached, because each one's
   * `enabled()` closes over live state — whether anything is selected, whether
   * there is history to undo. A cached list would grey out the wrong entries.
   */
  private openCommandPalette(): void {
    showCommandPalette(
      buildCommands(this.store, this.actions, this.appCallbacks, {
        onFind: () => showFindBar(this.store, this.actions),
        onToggleStylePanel: () => this.stylePanel.toggleCollapsed(),
      }),
    );
  }

  /**
   * Asks before leaving a board with unsaved changes.
   *
   * Two wordings, because whether anything is actually lost depends on local
   * storage. Normally the board keeps its copy in the recent-boards menu, so
   * the prompt says so rather than threatening a loss that will not happen.
   * Where storage is refused, or the board is empty and so not kept, the
   * changes really are discarded and the prompt says that instead.
   */
  private async confirmDiscard(): Promise<boolean> {
    const state = this.store.getState();
    if (!state.dirty) return true;

    const kept =
      this.autosave.available && state.document.elements.length + state.preserved.length > 0;
    if (kept) {
      return confirmDialog({
        title: 'Leave unsaved changes?',
        message:
          'This board has changes that have not been saved to a file. A copy stays under Recent boards ' +
          'in this browser — click the logo at the top left to reopen it.',
        confirmLabel: 'Continue',
      });
    }
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
  // Recent boards
  // -------------------------------------------------------------------------

  /** What autosave writes: the board as it would be saved, plus its dirty flag. */
  private snapshot(): BoardSnapshot {
    const state = this.store.getState();
    return {
      // With the live viewport folded in, so a reopened board comes back
      // looking at the same spot.
      document: this.store.documentForSave(),
      preserved: state.preserved,
      unsaved: state.dirty,
    };
  }

  private async openRecentBoards(): Promise<void> {
    const boards = await this.autosave.recentBoards();
    showRecentBoardsMenu({
      anchor: this.toolbar.brandButton,
      boards,
      currentId: this.store.document.id,
      onOpen: (board) => void this.openRecent(board),
      onRemove: (board) => void this.removeRecent(board),
    });
  }

  private async openRecent(board: RecentBoard): Promise<void> {
    // Same order as `newBoard`, and for the same reason: a pending text edit is
    // part of the board being left, so it lands before the user is asked.
    this.textEditor.commit();
    closePopover();
    if (!(await this.confirmDiscard())) return;
    if (await this.loadRecent(board)) toast(`Opened ${board.name}`);
  }

  /**
   * Replaces the board with a stored copy. Shared by the menu and startup
   * recovery, which differ only in what they ask first and what they report.
   *
   * The copy reopens as a board with no file: Save asks where to put it, like a
   * new board. Linking it back to its file or Drive entry would risk quietly
   * overwriting a newer version saved from elsewhere since the copy was made.
   */
  private async loadRecent(board: RecentBoard): Promise<boolean> {
    try {
      const contents = await this.autosave.readBoard(board.boardId);
      if (contents === null) {
        // Listed but gone — evicted by the browser, or removed in another tab.
        // Drop the row so the menu stops offering it.
        await this.autosave.remove(board.boardId);
        toast(`"${board.name}" is no longer stored in this browser.`, 'error');
        return false;
      }
      this.applyLoad(loadDocument(contents), { kind: 'new' });
      // A copy that was never saved elsewhere comes back as exactly that.
      if (board.unsaved) this.store.markDirty();
      return true;
    } catch (error) {
      console.error('[mindflow] could not open a recent board', error);
      toast(errorMessage(error, 'Could not open that board.'), 'error');
      return false;
    }
  }

  /**
   * Deletes a board's copy from this browser, then shows the menu again.
   *
   * Asks first only when the copy is the sole home of some work. A board saved
   * to a file loses nothing but a shortcut. The menu is closed for the question
   * because a popover and a modal cannot share the screen: the popover claims
   * Escape and closes on any click inside the dialog.
   */
  private async removeRecent(board: RecentBoard): Promise<void> {
    if (board.unsaved) {
      closePopover();
      const confirmed = await confirmDialog({
        title: 'Remove unsaved board?',
        message:
          `"${board.name}" has changes that were never saved to a file or to Drive. ` +
          'Removing it from this browser deletes them permanently.',
        confirmLabel: 'Remove',
        destructive: true,
      });
      if (!confirmed) {
        void this.openRecentBoards();
        return;
      }
    }

    try {
      await this.autosave.remove(board.boardId);
    } catch (error) {
      toast(errorMessage(error, 'Could not remove that board.'), 'error');
    }
    void this.openRecentBoards();
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

  /**
   * Board background.
   *
   * Goes through `setCanvasSettings` like the grid toggle above, which is what
   * makes it undoable — the command carries the whole `canvas` block before and
   * after, so no separate history handling is needed for document-level state.
   *
   * Note that a dark background (the palette offers one) leaves the default
   * near-black stroke almost invisible. That is left as the user's call rather
   * than second-guessed: recolouring their elements because they changed the
   * paper would be a far worse surprise than a board that needs a lighter pen.
   */
  private openBackgroundPicker(at: { x: number; y: number }): void {
    openColorPopover({
      at,
      label: 'Background',
      palette: PALETTE.canvas,
      current: this.store.document.canvas.background,
      onPreview: (background) => this.setBackground(background, true),
      onCommit: (background) => this.setBackground(background, false),
    });
  }

  private setBackground(background: string, coalesce: boolean): void {
    const { canvas } = this.store.document;
    if (canvas.background === background) return;
    this.store.execute({
      ...setCanvasSettings(this.store.document, { ...canvas, background }, 'Change background'),
      coalesce,
    });
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
  get testHooks(): {
    store: Store;
    actions: Actions;
    supportsFileSystemAccess: boolean;
    exportToSVG: typeof exportToSVG;
    roughOutlineFor: typeof roughOutlineFor;
    labelBoxOf: typeof labelBoxOf;
    layoutText: typeof layoutText;
  } {
    return {
      store: this.store,
      actions: this.actions,
      supportsFileSystemAccess: supportsFileSystemAccess(),
      // Exposed so the e2e suite can assert that the SVG exporter and the canvas
      // renderer consume the SAME generated outline for a rough shape. They are
      // two independent renderers, and that shared call is the only thing making
      // them agree — worth a test that would notice if it stopped being true.
      exportToSVG,
      roughOutlineFor,
      // Same reasoning: a solid's label box is read by the canvas, this app's
      // text editor and the SVG exporter, and the suite asserts they agree.
      labelBoxOf,
      // And line breaks: the canvas and SVG take theirs from `layoutText`, the
      // text editor from the browser's own line breaker. The suite compares the
      // two for the cases where they have disagreed, such as a hyphen at the edge.
      layoutText,
    };
  }
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

// Re-exported so `MindflowElement` stays available to consumers of this module
// without a second import path.
export type { MindflowElement };
