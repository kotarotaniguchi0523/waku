import { unstable_combineElements as combineElements } from 'waku/minimal/client';
import { buildMergePatch } from '../client-core-utils/merge-patch.js';
import { isSameRscRoute } from '../client-core-utils/route-url.js';
import type { RouteProps } from '../isomorphic-utils/route-path.js';
import { isMetaKey } from '../isomorphic-utils/router-protocol.js';

export type Elements = Readonly<Record<string | symbol, unknown>>;

/** The request a displayed route came from. */
export type Origin = {
  /** Pathname, search and hash of the URL the route is shown at. */
  readonly url: string;
  /** The route first asked for; a late redirect is judged against it. */
  readonly requested: readonly [path: string, query: string];
  /** Redirects and not-found pages followed to get here. */
  readonly follows: number;
  /** Whether the navigation scrolls. */
  readonly scroll: boolean;
};

/**
 * Identifies displayed content, for work that must not outlive it.
 * `navigation` changes with each navigation shown. `fragment` also changes
 * when only the fragment does.
 */
export type Scope = {
  readonly navigation: number;
  readonly fragment: number;
};

type Base = {
  readonly elements: Promise<Elements>;
  readonly scope: Scope;
};

type Routed = Base & {
  readonly route: RouteProps;
  readonly origin: Origin;
  /** Called each time React commits this frame. */
  readonly committed: () => void;
};

/**
 * The one piece of React state the router renders from. Each shape holds
 * exactly what exists in that state:
 * - `initial`: the document as the server rendered it; nothing has navigated.
 * - `preview`: an instant navigation shows the shell it already holds while
 *   its response is still arriving.
 * - `ready`: a navigation's response is shown.
 * - `failed`: a navigation could not load; the error boundary shows `error`.
 */
export type RenderFrame =
  | (Base & { readonly kind: 'initial' })
  | (Routed & { readonly kind: 'preview' })
  | (Routed & { readonly kind: 'ready' })
  | (Routed & { readonly kind: 'failed'; readonly error: unknown });

/** What a navigation resolved to. */
export type Outcome =
  | {
      readonly kind: 'render';
      readonly route: RouteProps;
      readonly url: URL;
      readonly origin: Origin;
      /** The elements this result contributes. */
      readonly patch: Elements;
      readonly source:
        | { readonly kind: 'known' }
        | {
            /** A server response for `requested`, asked for while `base` was shown. */
            readonly kind: 'response';
            readonly requested: RouteProps;
            readonly base: Elements;
          };
    }
  | {
      readonly kind: 'preview';
      readonly route: RouteProps;
      readonly url: URL;
      readonly origin: Origin;
      /** Builds the preview from what is shown; pure. */
      readonly merge: (current: Elements) => Elements;
    }
  | {
      readonly kind: 'failed';
      readonly route: RouteProps;
      readonly url: URL;
      readonly origin: Origin;
      readonly error: unknown;
    }
  /** The destination is another document. */
  | { readonly kind: 'leave'; readonly location: URL }
  /** The client is out of date; the requested URL is loaded as a document. */
  | { readonly kind: 'reload'; readonly url: URL };

/** An outcome that becomes a frame. */
export type Shown = Extract<Outcome, { kind: 'render' | 'preview' | 'failed' }>;

export const toOriginUrl = (url: URL) => url.pathname + url.search + url.hash;

export const originOf = (
  route: Pick<RouteProps, 'path' | 'query'>,
  url: URL,
  follows: number,
  scroll: boolean,
): Origin => ({
  url: toOriginUrl(url),
  requested: [route.path, route.query],
  follows,
  scroll,
});

const nothing = () => {};

export const initialFrame = (elements: Promise<Elements>): RenderFrame => ({
  kind: 'initial',
  elements,
  scope: { navigation: 0, fragment: 0 },
});

/** The displayed route. Only the initial frame takes it from the document. */
export const routeOf = (
  frame: RenderFrame,
  initial: RouteProps,
): RouteProps => {
  switch (frame.kind) {
    case 'initial':
      return initial;
    case 'preview':
    case 'ready':
    case 'failed':
      return frame.route;
    default:
      return frame satisfies never;
  }
};

export const originOfFrame = (frame: RenderFrame): Origin | undefined =>
  frame.kind === 'initial' ? undefined : frame.origin;

export const errorOf = (
  frame: RenderFrame,
): { readonly error: unknown } | undefined =>
  frame.kind === 'failed' ? frame : undefined;

// A fragment-only navigation can move the entry while its route is loading.
const withEntryHash = (
  route: RouteProps,
  url: URL,
  entryUrl: string | undefined,
): RouteProps => {
  if (!entryUrl) {
    return route;
  }
  const entry = new URL(entryUrl);
  return entry.pathname === url.pathname && entry.search === url.search
    ? { ...route, hash: entry.hash }
    : route;
};

/**
 * The frame that shows `outcome` after `prev`.
 *
 * `settled` is the route on screen and `entryUrl` the URL of the current
 * history entry, both read when the update runs.
 */
export function nextFrame(
  prev: RenderFrame,
  outcome: Shown,
  at: {
    navigation: number;
    settled: RouteProps;
    entryUrl: string | undefined;
    committed: () => void;
  },
): RenderFrame {
  const routed = {
    route: withEntryHash(outcome.route, outcome.url, at.entryUrl),
    origin: outcome.origin,
    scope: { navigation: at.navigation, fragment: prev.scope.fragment },
    committed: at.committed,
  };
  switch (outcome.kind) {
    case 'failed':
      return {
        ...routed,
        kind: 'failed',
        elements: prev.elements,
        error: outcome.error,
      };
    case 'preview':
      return {
        ...routed,
        kind: 'preview',
        elements: prev.elements.then(outcome.merge),
      };
    case 'render': {
      const { patch, source } = outcome;
      const fills =
        prev.kind === 'preview' && prev.scope.navigation === at.navigation;
      return {
        ...routed,
        kind: 'ready',
        elements: prev.elements.then((current) => {
          if (fills) {
            // The preview already reads the response where it left parts
            // pending; add only what it did not represent.
            return combineElements(current, patch, {
              filter: (key) =>
                typeof key === 'string' &&
                (isMetaKey(key) || !Object.hasOwn(current, key)),
            });
          }
          if (source.kind === 'known') {
            return combineElements(current, patch);
          }
          // A server function can have merged newer values while this
          // response was loading; those win.
          return combineElements(
            current,
            buildMergePatch(
              { route: source.requested, elements: patch },
              current,
              source.base,
              { settled: at.settled },
            ),
          );
        }),
      };
    }
    default:
      return outcome satisfies never;
  }
}

/** Replaces the elements of a frame and keeps everything else. */
export const withElements = (
  prev: RenderFrame,
  update: (elements: Promise<Elements>) => Promise<Elements>,
): RenderFrame => ({ ...prev, elements: update(prev.elements) });

/**
 * Records a fragment-only navigation, which the router does not intercept.
 * `url` is the new entry's URL; `initial` describes the initial frame.
 */
export function withFragment(
  prev: RenderFrame,
  initial: { route: RouteProps; url: URL },
  url: URL,
): RenderFrame {
  if (prev.kind === 'failed') {
    return prev;
  }
  const target = routeOf(prev, initial.route);
  const targetUrl =
    prev.kind === 'initial' ? initial.url : new URL(prev.origin.url, url);
  if (
    url.hash === target.hash ||
    url.pathname + url.search !== targetUrl.pathname + targetUrl.search
  ) {
    return prev;
  }
  const route = { ...target, hash: url.hash };
  // A later scope, so partial intents captured before this are stale.
  const scope = { ...prev.scope, fragment: prev.scope.fragment + 1 };
  if (prev.kind === 'initial') {
    return {
      kind: 'ready',
      elements: prev.elements,
      scope,
      route,
      origin: originOf(route, url, 0, false),
      committed: nothing,
    };
  }
  return {
    ...prev,
    scope,
    route,
    origin: { ...prev.origin, url: toOriginUrl(url), scroll: false },
  };
}

/** Shows `error` in place of the displayed route. */
export function failedHere(
  prev: RenderFrame,
  initial: RouteProps,
  url: URL,
  error: unknown,
): RenderFrame {
  const route = routeOf(prev, initial);
  return {
    kind: 'failed',
    elements: prev.elements,
    scope: prev.scope,
    route,
    origin: originOfFrame(prev) ?? originOf(route, url, 0, false),
    committed: nothing,
    error,
  };
}

/**
 * Adds a server function's rerender of `origin` to whatever is queued. A
 * frame that still shows that route takes all of it. A frame for another
 * route keeps its own route data and takes the rest, so the update is there
 * if a later navigation returns to `origin` without fetching it again.
 */
export function withRerender(
  prev: RenderFrame,
  initial: RouteProps,
  origin: Pick<RouteProps, 'path' | 'query'>,
  patch: Elements,
): RenderFrame {
  if (prev.kind === 'failed') {
    return prev;
  }
  const shown = isSameRscRoute(routeOf(prev, initial), origin);
  return {
    ...prev,
    elements: prev.elements.then((current) =>
      combineElements(current, patch, {
        filter: (key) => shown || (typeof key === 'string' && !isMetaKey(key)),
      }),
    ),
  };
}
