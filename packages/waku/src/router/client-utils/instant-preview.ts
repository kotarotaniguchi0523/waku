import {
  unstable_combineElements as combineElements,
  unstable_isImmutableElement as isImmutableElement,
} from 'waku/minimal/client';
import { createRscParams } from '../client-core-utils/caches.js';
import type { RouterCache } from '../client-core-utils/caches.js';
import { rejectOnAbort } from '../client-core-utils/load.js';
import { isSameRscRoute } from '../client-core-utils/route-url.js';
import {
  INTENT_ID,
  IS_STATIC_ID,
  ROUTE_ID,
  encodeRoutePath,
  isMetaKey,
  isStaticFromElements,
} from '../isomorphic-utils/router-protocol.js';
import { originOf } from './frame.js';
import type { Elements, Outcome } from './frame.js';
import type { Displayed, Request } from './resolve.js';

/**
 * Instant navigation: when the destination's shell is already held, it can
 * be shown at once with the parts that still need the server left pending.
 * Returns the preview and the response that fills it in, or nothing when
 * there is no shell to show. The router works the same without this file.
 */
export function startPreview(
  request: Request,
  shown: Displayed,
  cache: RouterCache,
  signal: AbortSignal,
):
  | {
      preview: Extract<Outcome, { kind: 'preview' }>;
      response: Promise<Elements>;
    }
  | undefined {
  const { route, url } = request;
  if (
    request.adopt !== undefined ||
    request.follows ||
    request.refetch === false ||
    isSameRscRoute(route, shown.route) ||
    cache.canReuseStaticRoute(route, shown.elements) ||
    !cache.hasCachedShell(route, shown.elements)
  ) {
    return;
  }
  const prefetched = cache.getPrefetchedElements(route);
  // Cancelled only until the response is in use; see `resolve()`.
  const fetching = new AbortController();
  const cancel = () => fetching.abort();
  signal.addEventListener('abort', cancel);
  const response = rejectOnAbort(
    cache.getPrefetch(route)?.promise ??
      cache.fetchRsc(
        encodeRoutePath(route.path),
        createRscParams(route.query),
        {
          signal: fetching.signal,
          ...(prefetched ? { unstable_base: prefetched } : {}),
        },
      ),
    fetching.signal,
  );
  response
    .catch(() => {})
    .finally(() => {
      signal.removeEventListener('abort', cancel);
    });
  const overlay: Elements = {
    [ROUTE_ID]: [route.path, route.query],
    [IS_STATIC_ID]: isStaticFromElements(shown.elements),
  };
  return {
    response,
    preview: {
      kind: 'preview',
      route,
      url,
      origin: originOf(route, url, 0, request.scroll),
      merge: (current) => {
        const arriving = response.catch(() => current);
        const available = prefetched
          ? combineElements(current, prefetched, {
              filter: (key) =>
                typeof key === 'string' && !Object.hasOwn(current, key),
            })
          : current;
        const pending: Record<string | symbol, unknown> = {};
        for (const key of Reflect.ownKeys(available)) {
          // Keep what cannot change; everything else waits for the response.
          const kept = Object.hasOwn(current, key)
            ? key !== INTENT_ID &&
              (typeof key === 'symbol' ||
                isMetaKey(key) ||
                isImmutableElement(current, key))
            : isImmutableElement(available, String(key));
          if (!kept) {
            pending[key] = arriving.then((elements) =>
              Object.hasOwn(elements, key)
                ? elements[key]
                : prefetched && Object.hasOwn(prefetched, key)
                  ? prefetched[key]
                  : current[key],
            );
          }
        }
        return combineElements(combineElements(available, pending), overlay);
      },
    },
  };
}
