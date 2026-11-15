import { isSameRoute } from '../client-core-utils/route-url.js';
import type { RouteProps } from '../isomorphic-utils/route-path.js';
import { ignoreRejection } from './promises.js';

/** Marks the traversal that returns to the shown entry after a refused one. */
const RETURN = { wakuReturn: true } as const;

const quiet = { scroll: 'manual', focusReset: 'manual' } as const;

/** The traversal that undoes a refused one changes nothing on screen. */
export function acceptReturn(event: NavigateEvent): boolean {
  if (event.info !== RETURN) {
    return false;
  }
  event.intercept(quiet);
  return true;
}

/**
 * Lets the application refuse a Back or Forward, or point it at another
 * route. The decision is made now, before the address bar moves. Returns
 * whether the event has been dealt with.
 */
export function guardTraversal(
  event: NavigateEvent,
  requested: RouteProps,
  decide: ((route: RouteProps) => RouteProps | false) | undefined,
  showInstead: (route: RouteProps) => void,
): boolean {
  if (event.navigationType !== 'traverse' || !decide) {
    return false;
  }
  const decided = decide(requested);
  if (decided && isSameRoute(decided, requested)) {
    return false;
  }
  if (decided) {
    event.intercept({ ...quiet, handler: async () => showInstead(decided) });
    return true;
  }
  if (event.cancelable) {
    event.preventDefault();
    return true;
  }
  // The browser moves regardless. Go along, then return to the entry still
  // on screen, so the address bar keeps matching it.
  const { navigation } = window;
  const shown = navigation.currentEntry?.key;
  event.intercept({
    ...quiet,
    handler: async () => {
      if (shown !== undefined) {
        setTimeout(() => {
          const back = navigation.traverseTo(shown, { info: RETURN });
          ignoreRejection(back.committed);
          ignoreRejection(back.finished);
        });
      }
    },
  });
  return true;
}
