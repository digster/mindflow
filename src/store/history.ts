/**
 * Undo / redo stack.
 *
 * Holds commands rather than document snapshots — see the rationale at the top
 * of `commands.ts`. Because {@link invertCommand} is correct by construction,
 * this file only has to get the *bookkeeping* right: what goes on which stack,
 * when a redo future becomes unreachable, and which consecutive edits collapse
 * into a single user-visible step.
 */

import type { MindflowDocument } from '../model/types.ts';
import type { Command } from './commands.ts';
import { applyCommand, invertCommand, isNoopCommand } from './commands.ts';

/**
 * Depth of the undo stack.
 *
 * Commands hold only the elements they touched, so entries are small and a
 * generous limit is affordable. The cap exists to bound a pathological session
 * (say, dragging an image around for an hour), not to save routine memory.
 */
const MAX_HISTORY = 200;

/**
 * Gestures emit a command per pointer-move. Consecutive commands with the same
 * label, flagged `coalesce`, merge into one undo step while they keep arriving
 * inside this window. The window matters: pausing mid-drag and resuming should
 * produce two undo steps, because the user perceives two movements.
 */
const COALESCE_WINDOW_MS = 600;

export class History {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private lastPushedAt = 0;

  /**
   * Records a command that has already been applied.
   *
   * Returns true if it changed the undo stack. No-ops are dropped so that, for
   * instance, clicking a shape and putting it back where it was does not leave a
   * useless undo entry.
   */
  push(command: Command): boolean {
    if (isNoopCommand(command) && !command.docAfter) return false;

    // Any new edit invalidates the redo branch. This is the standard linear
    // model: branching histories confuse far more than they help.
    this.redoStack.length = 0;

    const now = Date.now();
    const previous = this.undoStack[this.undoStack.length - 1];

    if (
      previous &&
      command.coalesce &&
      previous.coalesce &&
      previous.label === command.label &&
      now - this.lastPushedAt < COALESCE_WINDOW_MS
    ) {
      // Merge: keep the ORIGINAL `before` (where the gesture started) and adopt
      // the NEW `after` (where it is now). Getting this backwards is the classic
      // coalescing bug — undo would then jump to a point mid-gesture.
      const merged = new Map(previous.patches.map((patch) => [patch.id, patch]));
      for (const patch of command.patches) {
        const existing = merged.get(patch.id);
        if (existing) merged.set(patch.id, { ...existing, after: patch.after });
        else merged.set(patch.id, patch);
      }
      previous.patches = [...merged.values()];
      this.lastPushedAt = now;
      return true;
    }

    this.undoStack.push(command);
    this.lastPushedAt = now;

    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    return true;
  }

  /** Applies the inverse of the most recent command. Returns the new document, or null. */
  undo(document: MindflowDocument): MindflowDocument | null {
    const command = this.undoStack.pop();
    if (!command) return null;
    this.redoStack.push(command);
    // Break coalescing: an edit made straight after an undo must not merge into
    // whatever was on the stack before it.
    this.lastPushedAt = 0;
    return applyCommand(document, invertCommand(command));
  }

  /** Re-applies the most recently undone command. */
  redo(document: MindflowDocument): MindflowDocument | null {
    const command = this.redoStack.pop();
    if (!command) return null;
    this.undoStack.push(command);
    this.lastPushedAt = 0;
    return applyCommand(document, command);
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Label of the next undo step, for UI affordances. */
  undoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }

  redoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }

  /**
   * Ends any in-flight coalescing run, so the next command starts a fresh undo
   * step. Called on pointer-up and on tool changes.
   */
  breakCoalescing(): void {
    this.lastPushedAt = 0;
  }

  /** Clears both stacks. Called when a different document is loaded. */
  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.lastPushedAt = 0;
  }

  /** Diagnostics for the tests. */
  size(): { undo: number; redo: number } {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
  }
}
