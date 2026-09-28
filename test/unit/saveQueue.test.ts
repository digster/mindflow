/**
 * One save at a time.
 *
 * The queue is what gives the Save button's spinner a well-defined "in
 * progress", and what stops two overlapping saves of a new board from creating
 * two Drive files. A slow Drive round trip is hard to stage in the e2e suite,
 * so the orderings are pinned here with hand-resolved promises.
 */

import { describe, expect, it, vi } from 'vitest';

import { createSaveQueue } from '../../src/app/saveQueue.ts';

/** A promise the test settles by hand, standing in for a network write. */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A save task that stays in flight until its `finish` or `fail` is called. */
function slowTask() {
  const gate = deferred();
  const run = vi.fn(() => gate.promise);
  return { run, finish: gate.resolve, fail: gate.reject };
}

/** Lets every already-settled promise run its callbacks. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup() {
  const onBusyChange = vi.fn<(busy: boolean) => void>();
  return { onBusyChange, queue: createSaveQueue(onBusyChange) };
}

describe('createSaveQueue', () => {
  it('starts a save synchronously when nothing else is saving', () => {
    // Synchronously, not on a microtask: the file picker and the Google
    // sign-in popup both need the user's click to still be "active".
    const { queue } = setup();
    const task = slowTask();

    void queue.request(task.run);

    expect(task.run).toHaveBeenCalledTimes(1);
  });

  it('is busy for exactly as long as the save runs', async () => {
    const { onBusyChange, queue } = setup();
    const task = slowTask();

    expect(queue.busy).toBe(false);
    const done = queue.request(task.run);
    expect(queue.busy).toBe(true);
    expect(onBusyChange.mock.calls).toEqual([[true]]);

    task.finish();
    await done;

    expect(queue.busy).toBe(false);
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
  });

  it('is idle again by the time the requester resumes', async () => {
    // So code awaiting a save and the button it drives never disagree.
    const { queue } = setup();
    const task = slowTask();

    const done = queue.request(task.run);
    task.finish();
    await done;

    expect(queue.busy).toBe(false);
  });

  it('waits for the running save instead of starting a second one beside it', async () => {
    const { queue } = setup();
    const first = slowTask();
    const second = slowTask();

    void queue.request(first.run);
    void queue.request(second.run);
    expect(second.run).not.toHaveBeenCalled();

    first.finish();
    await flush();

    expect(second.run).toHaveBeenCalledTimes(1);
  });

  it('collapses every request made during a save into one follow-up, the latest', async () => {
    const { queue } = setup();
    const first = slowTask();
    const stale = [slowTask(), slowTask()];
    const latest = slowTask();

    void queue.request(first.run);
    const waiting = [...stale, latest].map((task) => queue.request(task.run));

    first.finish();
    await flush();
    latest.finish();
    await Promise.all(waiting);

    for (const task of stale) expect(task.run).not.toHaveBeenCalled();
    expect(latest.run).toHaveBeenCalledTimes(1);
  });

  it('stays busy across the handoff to a follow-up, so the spinner does not blink', async () => {
    const { onBusyChange, queue } = setup();
    const first = slowTask();
    const second = slowTask();

    void queue.request(first.run);
    const done = queue.request(second.run);
    first.finish();
    await flush();

    expect(queue.busy).toBe(true);

    second.finish();
    await done;

    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
  });

  it('settles a request when its own save finishes, not when a follow-up does', async () => {
    const { queue } = setup();
    const first = slowTask();
    const second = slowTask();
    const settled = vi.fn();

    void queue.request(first.run).then(settled);
    void queue.request(second.run);
    first.finish();
    await flush();

    expect(settled).toHaveBeenCalledTimes(1);
    expect(queue.busy).toBe(true);
  });

  it('passes a failure to its requester and is ready for the next save', async () => {
    const { queue } = setup();
    const failing = slowTask();

    const done = queue.request(failing.run);
    failing.fail(new Error('offline'));

    await expect(done).rejects.toThrow('offline');
    expect(queue.busy).toBe(false);

    const next = slowTask();
    void queue.request(next.run);
    expect(next.run).toHaveBeenCalledTimes(1);
  });

  it('survives a task that throws before it returns a promise', async () => {
    const { queue } = setup();

    const done = queue.request(() => {
      throw new Error('synchronous');
    });

    await expect(done).rejects.toThrow('synchronous');
    expect(queue.busy).toBe(false);
  });

  it('still runs the follow-up when the save ahead of it fails', async () => {
    // The follow-up is a separate request the user made; a failure it never
    // saw is no reason to drop it.
    const { queue } = setup();
    const failing = slowTask();
    const next = slowTask();

    void queue.request(failing.run).catch(() => {});
    const done = queue.request(next.run);
    failing.fail(new Error('offline'));
    await flush();

    expect(next.run).toHaveBeenCalledTimes(1);
    next.finish();
    await done;
    expect(queue.busy).toBe(false);
  });

  it('rejects every request a failed follow-up stood for', async () => {
    const { queue } = setup();
    const first = slowTask();
    const second = slowTask();
    const third = slowTask();

    void queue.request(first.run);
    const superseded = queue.request(second.run);
    const latest = queue.request(third.run);
    first.finish();
    await flush();
    third.fail(new Error('quota'));

    await expect(superseded).rejects.toThrow('quota');
    await expect(latest).rejects.toThrow('quota');
    expect(queue.busy).toBe(false);
  });
});
