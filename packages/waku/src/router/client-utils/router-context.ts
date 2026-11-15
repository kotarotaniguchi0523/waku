import { createContext, startTransition } from 'react';
import type { TransitionFunction } from 'react';
import type { RouteProps } from '../isomorphic-utils/route-path.js';
import type { RouterState } from './router-state.js';

export type ChangeRouteOptions = {
  shouldScroll: boolean;
  adopt?: Promise<Readonly<Record<string | symbol, unknown>>> | undefined;
  refetch?: boolean; // true: force refetch, false: don't refetch, undefined: auto-decide based on route change
  history: 'push' | 'replace' | null;
  url?: URL | undefined;
  instant?: boolean | undefined;
  follows?: number | undefined;
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
  isCurrentRoute?: (
    source: Readonly<Record<string | symbol, unknown>>,
  ) => boolean;
  /** The request an element record was committed for. */
  getRouteState?: (
    source: Readonly<Record<string | symbol, unknown>>,
  ) => RouterState | undefined;
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
