import {
  startTransition,
  use,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
} from 'react';
import {
  unstable_combineElements as combineElements,
  useElementsPromise_UNSTABLE as useElementsPromise,
} from 'waku/minimal/client';
import { useRouterCache } from '../client-core-utils/caches.js';
import { observeRouteIntent } from '../client-core-utils/observe-route-intent.js';
import type { RouteIntentOutcome } from '../client-core-utils/observe-route-intent.js';
import { getRouteIntentDecision } from '../client-core-utils/route-follow.js';
import { parseRoute } from '../client-core-utils/route-url.js';
import {
  INTENT_ID,
  getRouteFromElements,
} from '../isomorphic-utils/router-protocol.js';
import { RouterContext } from './router-context.js';
import type { RouteScope } from './router-context.js';

type PendingIntent = PromiseLike<string | undefined>;

/**
 * Follows redirect and not-found intents that settle after their content is
 * on screen.
 *
 * An intent is acted on only while the place it came from is still current,
 * and never while another navigation is loading:
 * - The intent of the displayed route itself belongs to that route. It stays
 *   current across fragment changes, since those keep the user on the route,
 *   and ends when another navigation is shown.
 * - An intent from a partial response (a slice, or a server function that
 *   returned no route) belongs to the moment it was requested. Any later
 *   navigation, a fragment change included, makes it stale.
 */
export function RouteIntent({
  onError,
}: {
  onError: (error: unknown) => void;
}) {
  const elements = use(useElementsPromise());
  const router = use(RouterContext);
  const cache = useRouterCache();
  const getElements = router?.getElements;
  const getScope = router?.getScope;
  const handledIntents = useRef(new WeakSet<PendingIntent>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const settle = useEffectEvent(
    (
      outcome: RouteIntentOutcome,
      pending: PendingIntent,
      scope: RouteScope | undefined,
      partial: boolean,
    ) => {
      if (!router || !getElements) {
        return;
      }
      if (scope && !router.isCurrentScope?.(scope, partial)) {
        return;
      }
      const source = getElements();
      if (!partial && source[INTENT_ID] !== pending) {
        return;
      }
      if (handledIntents.current.has(pending)) {
        return;
      }
      handledIntents.current.add(pending);
      const state = router.getRouteState?.();
      try {
        const sourceRoute = getRouteFromElements(source);
        const requestedUrl = new URL(
          state?.url ?? window.location.href,
          window.location.href,
        );
        const requested = state?.requested;
        const attempt = {
          route: requested
            ? { path: requested[0], query: requested[1] }
            : (sourceRoute ?? parseRoute(requestedUrl)),
          url: requestedUrl,
          follows: state?.follows ?? 0,
        };
        const decision = getRouteIntentDecision(outcome, source, attempt);
        if (!decision) {
          return;
        }
        if (decision.type === 'leave') {
          window.location.replace(decision.url.href);
          return;
        }
        const { target, url } = decision;
        startTransition(() => {
          router
            .changeRoute(target, {
              shouldScroll: state
                ? state.scroll !== null
                : target.path !== sourceRoute?.path,
              history: 'replace',
              url,
              follows: (state?.follows ?? 0) + 1,
            })
            .catch(onError);
        });
      } catch (error) {
        onError(error);
      }
    },
  );

  // The displayed route's own intent.
  useEffect(() => {
    const pending = elements[INTENT_ID] as PendingIntent | null | undefined;
    if (!pending) {
      return;
    }
    const scope = getScope?.();
    return observeRouteIntent(pending, (outcome) => {
      settle(outcome, pending, scope, false);
    });
  }, [elements, getScope]);

  // Intents of partial responses, captured when their request starts.
  useLayoutEffect(() => {
    if (!getElements) {
      return;
    }
    const unregister = cache.connectRouteIntentObserver((signal) => {
      const scope = getScope?.();
      return (responseElements) => {
        const pending = responseElements[INTENT_ID] as
          PendingIntent | null | undefined;
        if (!pending) {
          return responseElements;
        }
        if (getRouteFromElements(responseElements)) {
          return responseElements;
        }
        observeRouteIntent(pending, (outcome) => {
          if (mounted.current && !signal?.aborted) {
            settle(outcome, pending, scope, true);
          }
        });
        return combineElements({}, responseElements, {
          filter: (key) => key !== INTENT_ID,
        });
      };
    });
    return () => {
      unregister();
    };
  }, [cache, getElements, getScope]);

  return null;
}
