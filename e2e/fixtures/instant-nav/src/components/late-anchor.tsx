'use client';

import { use } from 'react';

export function LateAnchor() {
  const gate = Reflect.get(globalThis, '__wakuAnchorGate') as
    Promise<void> | undefined;
  if (gate) {
    use(gate);
  }
  return <h2 id="late-anchor">Late anchor</h2>;
}
