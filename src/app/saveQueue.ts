/**
 * One save at a time.
 *
 * A save can take a while. A Drive round trip is a metadata read and an upload,
 * and a local save may wait on the file picker. While one is running, the user
 * can press Save again: a double click, a reflexive Cmd/Ctrl+S, the command
 * palette, or "Save this board here" in the Drive dialog. Letting those run
 * side by side caused two problems:
 *
 *   - The first save of a board to Drive has no file id yet, so two overlapping
 *     saves each *create* a file, and the folder ends up with two copies.
 *   - The Save button's spinner needs a clear "in progress". With overlapping
 *     saves, the first to finish would switch it off while the second was
 *     still uploading.
 *
 * So saves run one after another. A request made while a save is running
 * becomes the single follow-up that runs when it finishes, and any later
 * request replaces it. Each task reads the board when it *starts*, so the
 * latest request saves everything the earlier ones would have, and one extra
 * round trip is enough however many times the user pressed Save.
 *
 * Free of any DOM, like `input/pasteGate.ts`, so the orderings can be
 * unit-tested with hand-resolved promises instead of a slow network.
 */

/** Performs one save. Resolves when the board has been written. */
export type SaveTask = () => Promise<void>;

export interface SaveQueue {
  /**
   * True from the moment a save starts until the last follow-up finishes,
   * without a gap between them.
   */
  readonly busy: boolean;
  /**
   * Runs `task` now if nothing is saving, and otherwise once the running save
   * finishes, replacing any follow-up already waiting. Resolves or rejects
   * with the task that actually ran for this request: its own, or the later
   * request that replaced it.
   */
  request(task: SaveTask): Promise<void>;
}

/** The single request waiting behind the running save. */
interface FollowUp {
  task: SaveTask;
  readonly settled: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

export function createSaveQueue(onBusyChange: (busy: boolean) => void = () => {}): SaveQueue {
  let busy = false;
  let followUp: FollowUp | null = null;

  const setBusy = (value: boolean): void => {
    if (busy === value) return;
    busy = value;
    onBusyChange(value);
  };

  /**
   * Starts `task`, then hands over to the follow-up (if any) once it settles.
   *
   * The task starts synchronously, inside the caller's click or keydown. It is
   * not deferred to a microtask. `showSaveFilePicker` and the Google sign-in
   * popup both require the user's gesture to still count as active, and
   * deferring the start would put that at risk for no gain.
   */
  const run = (task: SaveTask): Promise<void> => {
    setBusy(true);

    let done: Promise<void>;
    try {
      done = task();
    } catch (error) {
      // A task that throws before returning a promise must still release the
      // queue, or the button would spin forever.
      done = Promise.reject(error);
    }

    // Registered before the caller can attach its own callbacks, so `busy` is
    // already false by the time an `await queue.request(…)` resumes.
    const advance = (): void => {
      const next = followUp;
      followUp = null;
      if (next) run(next.task).then(next.resolve, next.reject);
      else setBusy(false);
    };
    done.then(advance, advance);

    return done;
  };

  return {
    get busy() {
      return busy;
    },

    request(task) {
      if (!busy) return run(task);

      if (followUp) {
        followUp.task = task;
      } else {
        let resolve!: () => void;
        let reject!: (error: unknown) => void;
        const settled = new Promise<void>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        followUp = { task, settled, resolve, reject };
      }
      return followUp.settled;
    },
  };
}
