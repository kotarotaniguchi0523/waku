'use server';

import { requestRefresh } from 'waku/router/server';
import { incrementCount } from './counter.js';
import { waitForGate } from './gate.js';

export const increment = async () => {
  const next = incrementCount();
  requestRefresh();
  return next;
};

// Finishes only after the spec opens the gate.
export const gatedIncrement = async (gateId: string) => {
  await waitForGate(gateId);
  const next = incrementCount();
  requestRefresh();
  return next;
};
