/**
 * The command registry — one list of everything the user can invoke by name.
 *
 * This exists so the command palette has a single source of truth rather than a
 * hand-maintained copy of what the toolbar and keyboard already do. Everything
 * here delegates to `Actions` or to the same app-level callbacks the toolbar
 * receives, so a command cannot behave differently depending on how it was
 * reached.
 *
 * It also gives the file actions a keyboard route again. `Cmd`/`Ctrl` + `N` is
 * claimed by every major browser for "new window" and never reaches the page, so
 * before the palette the New board button was the only way in.
 */

import type { Store, ToolId } from '../store/store.ts';
import type { Actions } from './actions.ts';
import type { ToolbarCallbacks } from '../ui/toolbar.ts';
import { MOD_KEY } from '../ui/dom.ts';

export interface Command {
  id: string;
  title: string;
  /** Section heading in the palette. */
  group: string;
  /** Display-only hint; the palette never binds keys itself. */
  shortcut?: string;
  /** Extra words to match against that do not appear in the title. */
  keywords?: string;
  run: () => void;
  /** False greys the entry out — it stays listed, so it stays discoverable. */
  enabled: () => boolean;
}

const TOOL_COMMANDS: { tool: ToolId; title: string; shortcut: string }[] = [
  { tool: 'select', title: 'Select tool', shortcut: 'V' },
  { tool: 'pan', title: 'Pan tool', shortcut: 'H' },
  { tool: 'rectangle', title: 'Rectangle tool', shortcut: 'R' },
  { tool: 'ellipse', title: 'Ellipse tool', shortcut: 'O' },
  { tool: 'line', title: 'Line tool', shortcut: 'L' },
  { tool: 'arrow', title: 'Arrow tool', shortcut: 'A' },
  { tool: 'draw', title: 'Draw tool', shortcut: 'P' },
  { tool: 'text', title: 'Text tool', shortcut: 'T' },
  { tool: 'sticky', title: 'Sticky note tool', shortcut: 'N' },
  { tool: 'table', title: 'Table tool', shortcut: 'B' },
  // Diamond and frame were missing here while being present in the toolbar and
  // the keyboard map — the palette is a hand-maintained third copy, and this is
  // exactly the drift that costs.
  { tool: 'diamond', title: 'Diamond tool', shortcut: 'D' },
  { tool: 'frame', title: 'Frame tool', shortcut: 'F' },
  { tool: 'eraser', title: 'Eraser tool', shortcut: 'E' },
];

export function buildCommands(
  store: Store,
  actions: Actions,
  callbacks: ToolbarCallbacks,
  extras: { onFind: () => void },
): Command[] {
  const hasSelection = () => store.selectedIds().length > 0;
  const unitCount = () =>
    new Set(store.selectedElements().filter((el) => !el.locked).map((el) => el.groupId ?? el.id)).size;

  return [
    // ---- File ------------------------------------------------------------
    {
      id: 'file.new',
      title: 'New board',
      group: 'File',
      // No shortcut hint on purpose: Cmd+N is swallowed by the browser, and
      // advertising a chord that opens a browser window would be a lie.
      run: callbacks.onNew,
      enabled: () => true,
    },
    { id: 'file.open', title: 'Open board…', group: 'File', shortcut: `${MOD_KEY}O`, run: callbacks.onOpen, enabled: () => true },
    { id: 'file.save', title: 'Save board', group: 'File', shortcut: `${MOD_KEY}S`, run: callbacks.onSave, enabled: () => true },
    {
      id: 'file.export',
      title: 'Export…',
      group: 'File',
      shortcut: `${MOD_KEY}⇧E`,
      keywords: 'png svg json image',
      run: callbacks.onExport,
      enabled: () => true,
    },
    { id: 'file.drive', title: 'Google Drive…', group: 'File', keywords: 'cloud sync', run: callbacks.onDrive, enabled: () => true },

    // ---- Edit ------------------------------------------------------------
    { id: 'edit.undo', title: 'Undo', group: 'Edit', shortcut: `${MOD_KEY}Z`, run: () => store.undo(), enabled: () => store.history.canUndo() },
    { id: 'edit.redo', title: 'Redo', group: 'Edit', shortcut: `${MOD_KEY}⇧Z`, run: () => store.redo(), enabled: () => store.history.canRedo() },
    { id: 'edit.selectAll', title: 'Select all', group: 'Edit', shortcut: `${MOD_KEY}A`, run: () => actions.selectAll(), enabled: () => true },
    { id: 'edit.duplicate', title: 'Duplicate', group: 'Edit', shortcut: `${MOD_KEY}D`, run: () => actions.duplicate(), enabled: hasSelection },
    { id: 'edit.delete', title: 'Delete selection', group: 'Edit', shortcut: 'Delete', run: () => actions.deleteSelection(), enabled: hasSelection },
    { id: 'edit.copyStyle', title: 'Copy style', group: 'Edit', shortcut: `${MOD_KEY}⌥C`, run: () => actions.copyStyle(), enabled: hasSelection },
    {
      id: 'edit.pasteStyle',
      title: 'Paste style',
      group: 'Edit',
      shortcut: `${MOD_KEY}⌥V`,
      run: () => actions.pasteStyle(),
      enabled: () => hasSelection() && actions.hasCopiedStyle,
    },
    { id: 'edit.find', title: 'Find on board…', group: 'Edit', shortcut: `${MOD_KEY}F`, keywords: 'search text', run: extras.onFind, enabled: () => true },

    // ---- Arrange ---------------------------------------------------------
    { id: 'arrange.group', title: 'Group', group: 'Arrange', shortcut: `${MOD_KEY}G`, run: () => actions.group(), enabled: () => unitCount() > 1 },
    { id: 'arrange.ungroup', title: 'Ungroup', group: 'Arrange', shortcut: `${MOD_KEY}⇧G`, run: () => actions.ungroup(), enabled: () => store.selectedElements().some((el) => el.groupId !== null) },
    { id: 'arrange.front', title: 'Bring to front', group: 'Arrange', shortcut: `${MOD_KEY}⇧]`, run: () => actions.reorder('front'), enabled: hasSelection },
    { id: 'arrange.back', title: 'Send to back', group: 'Arrange', shortcut: `${MOD_KEY}⇧[`, run: () => actions.reorder('back'), enabled: hasSelection },
    { id: 'arrange.lock', title: 'Lock selection', group: 'Arrange', run: () => actions.toggleLock(), enabled: hasSelection },

    { id: 'arrange.alignLeft', title: 'Align left', group: 'Arrange', run: () => actions.align('left'), enabled: () => unitCount() > 1 },
    { id: 'arrange.alignCenterX', title: 'Align horizontal centres', group: 'Arrange', run: () => actions.align('centerX'), enabled: () => unitCount() > 1 },
    { id: 'arrange.alignRight', title: 'Align right', group: 'Arrange', run: () => actions.align('right'), enabled: () => unitCount() > 1 },
    { id: 'arrange.alignTop', title: 'Align top', group: 'Arrange', run: () => actions.align('top'), enabled: () => unitCount() > 1 },
    { id: 'arrange.alignCenterY', title: 'Align vertical centres', group: 'Arrange', run: () => actions.align('centerY'), enabled: () => unitCount() > 1 },
    { id: 'arrange.alignBottom', title: 'Align bottom', group: 'Arrange', run: () => actions.align('bottom'), enabled: () => unitCount() > 1 },
    { id: 'arrange.distributeH', title: 'Distribute horizontally', group: 'Arrange', run: () => actions.distribute('horizontal'), enabled: () => unitCount() > 2 },
    { id: 'arrange.distributeV', title: 'Distribute vertically', group: 'Arrange', run: () => actions.distribute('vertical'), enabled: () => unitCount() > 2 },

    // ---- View ------------------------------------------------------------
    { id: 'view.zoomIn', title: 'Zoom in', group: 'View', shortcut: `${MOD_KEY}+`, run: () => actions.zoomBy(1.2), enabled: () => true },
    { id: 'view.zoomOut', title: 'Zoom out', group: 'View', shortcut: `${MOD_KEY}−`, run: () => actions.zoomBy(1 / 1.2), enabled: () => true },
    { id: 'view.resetZoom', title: 'Reset zoom', group: 'View', shortcut: `${MOD_KEY}0`, run: () => actions.resetZoom(), enabled: () => true },
    { id: 'view.zoomToFit', title: 'Zoom to fit', group: 'View', shortcut: `${MOD_KEY}1`, run: () => actions.zoomToFit(), enabled: () => true },
    { id: 'view.toggleGrid', title: 'Toggle grid', group: 'View', keywords: 'snap', run: callbacks.onToggleGrid, enabled: () => true },
    { id: 'view.shortcuts', title: 'Keyboard shortcuts', group: 'View', keywords: 'help keys', run: callbacks.onHelp, enabled: () => true },
    { id: 'view.settings', title: 'Settings…', group: 'View', keywords: 'preferences drive client id', run: callbacks.onSettings, enabled: () => true },

    // ---- Tools -----------------------------------------------------------
    ...TOOL_COMMANDS.map(({ tool, title, shortcut }) => ({
      id: `tool.${tool}`,
      title,
      group: 'Tools',
      shortcut,
      run: () => store.setTool(tool),
      enabled: () => true,
    })),
  ];
}

/**
 * Ranks commands against a query.
 *
 * Subsequence matching rather than exact substring, so "zf" finds "Zoom to fit"
 * — the abbreviation people reach for once they know the list. Contiguous
 * matches and matches at the start of a word rank above scattered ones, which is
 * what stops "se" putting "Sticky note tool" above "Select all".
 *
 * Pure and DOM-free so it can be unit-tested in the node environment.
 */
export function matchCommand(command: { title: string; keywords?: string }, query: string): number | null {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === '') return 0;

  const haystack = `${command.title} ${command.keywords ?? ''}`.toLowerCase();

  const exact = haystack.indexOf(trimmed);
  // A literal hit always outranks a scattered subsequence, and one at a word
  // boundary outranks one buried mid-word.
  if (exact === 0) return 1000;
  if (exact > 0) return haystack[exact - 1] === ' ' ? 900 : 700;

  let score = 500;
  let cursor = 0;
  for (const character of trimmed) {
    const found = haystack.indexOf(character, cursor);
    if (found === -1) return null;
    // Every gap between matched characters costs, so tighter matches win.
    score -= found - cursor;
    cursor = found + 1;
  }
  return score;
}
