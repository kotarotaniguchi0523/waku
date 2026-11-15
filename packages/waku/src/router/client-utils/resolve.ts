import { unstable_isBuildIdMismatch as isBuildIdMismatch } from 'waku/minimal/client';
import type { RouterCache } from '../client-core-utils/caches.js';
import { isSameRscRoute } from '../client-core-utils/route-url.js';
import type { RouteProps } from '../isomorphic-utils/route-path.js';
import {
  INTENT_ID,
  IS_STATIC_ID,
  ROUTE_ID,
  isStaticFromElements,
} from '../isomorphic-utils/router-protocol.js';
import { originOf } from './frame.js';
import type { Elements, Outcome } from './frame.js';
import { abortError } from './promises.js';
import { resolveServerRedirect } from './server-redirect.js';

/**
 * Where the elements of a request come from. `follows` counts the redirects
 * and not-found pages that led to this request.
 */
export type Source =
  /** The route is fetched. */
  | { readonly kind: 'fetch'; readonly follows: number }
  /** A response already on its way, as from a server function. */
  | {
      readonly kind: 'response';
      readonly response: Promise<Elements>;
      readonly follows: number;
    };

/** A fetch that follows on nothing. */
export const fetched: Source = { kind: 'fetch', follows: 0 };

/** What a navigation asks for. */
export type Request = {
  readonly route: RouteProps;
  readonly url: URL;
  readonly scroll: boolean;
  /** `true` fetches, `false` does not, `undefined` fetches a changed route. */
  readonly refetch: boolean | undefined;
  readonly source: Source;
};

/** What is on screen when the navigation starts. */
export type Displayed = {
  readonly route: RouteProps;
  readonly elements: Elements;
  readonly has404: boolean;
};

/**
 * Fetches the requested route and follows it to the route to show. It reads
 * and changes nothing in the browser or in React, and rejects with an
 * `AbortError` when `signal` aborts first.
 */
export async function resolve(
  request: Request,
  shown: Displayed,
  cache: Pick<RouterCache, 'load' | 'canReuseStaticRoute'>,
  signal: AbortSignal,
): Promise<Outcome> {
  const { route, url, scroll, source } = request;
  const adopt = source.kind === 'response' ? source.response : undefined;
  const { follows } = source;
  const base = shown.elements;
  const sameRoute = isSameRscRoute(route, shown.route);
  const shouldRefetch = adopt !== undefined || (request.refetch ?? !sameRoute);
  const canReuseStatic =
    adopt === undefined && cache.canReuseStaticRoute(route, base);
  if (canReuseStatic || !shouldRefetch) {
    return {
      kind: 'render',
      route,
      url,
      origin: originOf(route, url, follows, scroll),
      patch: {
        [ROUTE_ID]: [route.path, route.query],
        [INTENT_ID]: sameRoute ? base[INTENT_ID] : null,
        ...(canReuseStatic ? { [IS_STATIC_ID]: true } : {}),
      },
      source: { kind: 'known' },
    };
  }
  // The request is cancelled only while nothing of it has been used. Once
  // its response is handed to React, the stream runs to the end even if the
  // navigation is dropped, since content on screen may read from it.
  const fetching = new AbortController();
  const cancel = () => fetching.abort();
  signal.addEventListener('abort', cancel);
  const loaded = await cache
    .load(route, {
      signal: fetching.signal,
      refetch: shouldRefetch,
      has404: shown.has404,
      base,
      url,
      follows,
      ...(adopt ? { adopt } : {}),
    })
    .finally(() => {
      signal.removeEventListener('abort', cancel);
    });
  if (loaded.type === 'aborted' || signal.aborted) {
    throw abortError();
  }
  if (loaded.type === 'leave') {
    return { kind: 'leave', location: loaded.location };
  }
  if (loaded.type === 'failed') {
    return isBuildIdMismatch(loaded.error)
      ? { kind: 'reload', url: loaded.url }
      : {
          kind: 'failed',
          route: loaded.route,
          url: loaded.url,
          origin: originOf(loaded.route, loaded.url, loaded.follows, scroll),
          error: loaded.error,
        };
  }
  const patch: Elements =
    loaded.type === 'reused'
      ? {
          [ROUTE_ID]: [loaded.route.path, loaded.route.query],
          [INTENT_ID]: null,
          [IS_STATIC_ID]:
            cache.canReuseStaticRoute(loaded.route, base) ||
            isStaticFromElements(base),
        }
      : loaded.elements;
  const destination = resolveServerRedirect(patch, loaded, loaded.route.path);
  return {
    kind: 'render',
    route: destination.route,
    url: destination.url,
    origin: originOf(
      destination.route,
      destination.url,
      loaded.follows,
      scroll,
    ),
    patch,
    source:
      loaded.type === 'loaded'
        ? { kind: 'response', requested: loaded.route, base }
        : { kind: 'known' },
  };
}
