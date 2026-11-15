'use server';

import {
  requestRefresh,
  unstable_rerenderRoute as rerenderRoute,
} from 'waku/router/server';
import { armRenderFailure, incrementCount } from './counter.js';
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

// Answers with a fresh render of the counter route itself.
export const incrementAndRerender = async () => {
  const next = incrementCount();
  rerenderRoute('/counter');
  return next;
};

// Refreshes the route, whose next render fails.
export const refreshIntoFailure = async () => {
  armRenderFailure();
  requestRefresh();
  return 'refreshed';
};
