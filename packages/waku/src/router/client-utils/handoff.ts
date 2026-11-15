import { isSameOrigin } from '../client-core-utils/route-url.js';
import type { Outcome } from './frame.js';
import { ignoreResult } from './promises.js';

/** Marks a navigation the router hands to the browser as a document load. */
export const HANDOFF = { wakuHandoff: true } as const;

/**
 * Loads the destination as a document: a redirect out of the app, or the
 * requested URL itself when the client is out of date. `push` adds a history
 * entry; otherwise the current one is replaced.
 */
export function handOff(
  outcome: Extract<Outcome, { kind: 'leave' | 'reload' }>,
  push: boolean,
) {
  if (outcome.kind === 'leave' && !isSameOrigin(outcome.location)) {
    // Another origin is never intercepted; `location` is the one way to
    // leave that every browser honours here.
    if (push) {
      window.location.assign(outcome.location.href);
    } else {
      window.location.replace(outcome.location.href);
    }
    return;
  }
  // Same origin: tagged, so the router's listener lets the browser load it.
  if (outcome.kind === 'reload' && outcome.url.href === window.location.href) {
    // Navigating to the URL already shown would not load a document when
    // it has a fragment.
    ignoreResult(window.navigation.reload({ info: HANDOFF }));
    return;
  }
  ignoreResult(
    window.navigation.navigate(
      outcome.kind === 'leave' ? outcome.location.href : outcome.url.href,
      { info: HANDOFF, history: push ? 'push' : 'replace' },
    ),
  );
}
