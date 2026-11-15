import { createContext, startTransition } from 'react';
import type { TransitionFunction } from 'react';
import type { RouteProps } from '../isomorphic-utils/route-path.js';
import type { Origin, Scope } from './frame.js';

export type ChangeRouteOptions = {
  shouldScroll: boolean;
  refetch?: boolean; // true: force refetch, false: don't refetch, undefined: auto-decide based on route change
  history: 'push' | 'replace' | null;
  url?: URL | undefined;
  instant?: boolean | undefined;
  onSuperseded?: (() => void) | undefined;
};

export type ChangeRoute = (
  route: RouteProps,
  options: ChangeRouteOptions,
) => Promise<void>;

export const RouterContext = createContext<{
  route: RouteProps;
  changeRoute: ChangeRoute;
  getElements?: () => Record<string, unknown>;
  /** Identifies what is on screen now, for work that must not outlive it. */
  getScope?: () => Scope;
  /**
   * Whether `scope` still describes what is on screen and no navigation is
   * loading. With `exact`, a fragment change since then also ends it.
   */
  isCurrentScope?: (scope: Scope, exact: boolean) => boolean;
  /** Follows a redirect or not-found that settled after its page was shown. */
  followIntent?: (
    route: RouteProps,
    url: URL,
    shouldScroll: boolean,
  ) => Promise<void>;
  /** The request the displayed route came from; none before a navigation. */
  getOrigin?: () => Origin | undefined;
} | null>(null);

export function dispatchChangeRoute(
  changeRoute: ChangeRoute,
  route: RouteProps,
  options: ChangeRouteOptions,
  startTransitionFn: (fn: TransitionFunction) => void = startTransition,
): Promise<void> {
  if (options.instant) {
    // An instant navigation shows its preview at once, so it does not wait
    // inside a transition.
    return changeRoute(route, options);
  }
  // a transition keeps the current tree up while the destination loads
  return new Promise<void>((resolve, reject) => {
    startTransitionFn(async () => {
      try {
        await changeRoute(route, options);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
}
