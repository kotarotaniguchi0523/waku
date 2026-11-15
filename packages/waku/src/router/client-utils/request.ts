import type { RouterCache } from '../client-core-utils/caches.js';
import type { RouteProps } from '../isomorphic-utils/route-path.js';
import type { Elements, Outcome, RenderFrame } from './frame.js';
import type { Displayed, Request } from './resolve.js';
import type { ChangeRouteOptions } from './router-context.js';

export type Interceptor =
  ((route: RouteProps) => RouteProps | false) | undefined;

/** What the last commit showed. Decisions read this, never a render. */
export type Committed = Displayed & {
  readonly frame: RenderFrame;
  readonly cache: RouterCache;
  readonly interceptor: Interceptor;
};

/** Where a navigation's result comes from. */
export type Source =
  /** The route is fetched; `follows` counts what led here already. */
  | { readonly kind: 'fetch'; readonly follows: number }
  /** A response already on its way, as from a server function. */
  | { readonly kind: 'response'; readonly response: Promise<Elements> }
  /** A result resolved by the navigation this one replaces. */
  | {
      readonly kind: 'resolved';
      readonly outcome: Extract<Outcome, { kind: 'render' }>;
    };

export const fetched: Source = { kind: 'fetch', follows: 0 };

// Carried through `navigation.navigate()` so the navigate listener can tell
// a navigation this router started, and with which options and source.
export class RequestInfo {
  constructor(
    readonly route: RouteProps,
    readonly options: ChangeRouteOptions,
    readonly source: Source,
    readonly settle: PromiseWithResolvers<void>,
  ) {}
}

export const toRequest = (
  route: RouteProps,
  url: URL,
  options: ChangeRouteOptions,
  source: Source,
): Request => ({
  route,
  url,
  scroll: options.shouldScroll,
  follows: source.kind === 'fetch' ? source.follows : 0,
  refetch: options.refetch,
  adopt: source.kind === 'response' ? source.response : undefined,
});
