// Server-side gates. A spec opens a gate to decide when a held render continues,
// so tests control timing without knowing how the router talks to the server.
const waiting = new Map<string, () => void>();
const released = new Set<string>();

export const waitForGate = (id: string) =>
  new Promise<void>((resolve) => {
    if (released.delete(id)) {
      resolve();
      return;
    }
    // A test that fails before releasing must not hold the render forever.
    const timeout = setTimeout(() => {
      waiting.delete(id);
      resolve();
    }, 30_000);
    waiting.set(id, () => {
      clearTimeout(timeout);
      resolve();
    });
  });

export const releaseGate = (id: string) => {
  const open = waiting.get(id);
  if (open) {
    waiting.delete(id);
    open();
  } else {
    released.add(id);
  }
};

export const isGateWaiting = (id: string) => waiting.has(id);
