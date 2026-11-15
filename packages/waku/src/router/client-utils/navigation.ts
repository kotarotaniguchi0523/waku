import { startTransition } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { RouterCache } from '../client-core-utils/caches.js';
import {
  getRouteUrl,
  isSameOrigin,
  otherOriginError,
} from '../client-core-utils/route-url.js';
import type { RouteProps } from '../isomorphic-utils/route-path.js';
import {
  getRouteFromElements,
  isStaticFromElements,
} from '../isomorphic-utils/router-protocol.js';
import { createAttempts } from './attempts.js';
import type { Attempt } from './attempts.js';
import {
  failedHere,
  nextFrame,
  originOfFrame,
  withFragment,
  withRerender,
} from './frame.js';
import type { Elements, RenderFrame, Scope, Shown } from './frame.js';
import { handOff } from './handoff.js';
import { createNavigateListener, navigate } from './navigate-listener.js';
import { abortError, ignoreRejection, isAbortError } from './promises.js';
import { fetched, resolve } from './resolve.js';
import type { Displayed, Source } from './resolve.js';
import { dispatchChangeRoute } from './router-context.js';
import type { ChangeRoute, ChangeRouteOptions } from './router-context.js';
import type { Interceptor } from './traversal-guard.js';

/** What the last commit showed. Decisions read this, never a render. */
export type Committed = Displayed & {
  readonly frame: RenderFrame;
  readonly cache: RouterCache;
  readonly interceptor: Interceptor;
};

const runNow = (update: () => void) => update();

// A dropped update is expected. Anything else would otherwise disappear
// without a trace.
const reportUnlessAborted = (error: unknown) => {
  if (!isAbortError(error)) {
    console.error('Error while applying a route update:', error);
  }
};

/**
 * The Navigation API binding. The browser owns the URL, history, scroll and
 * focus; this listens for navigations, resolves each one with `resolve()`,
 * and queues the frame that shows the result.
 *
 * `keepReloadTarget` is called when a navigation starts. During development
 * it keeps Minimal from refetching the initial route on a reload; the router
 * refetches the route it is showing instead.
 */
export function createNavigation(
  setFrame: Dispatch<SetStateAction<RenderFrame>>,
  first: Committed,
  keepReloadTarget: () => void,
) {
  let current = first;
  const attempts = createAttempts();

  // React can run an updater more than once for the same previous frame;
  // each run must return the same frame, and with it the same promise.
  const update = (
    schedule: (update: () => void) => void,
    compute: (prev: RenderFrame) => RenderFrame,
  ) => {
    const results = new WeakMap<RenderFrame, RenderFrame>();
    schedule(() => {
      setFrame((prev) => {
        let next = results.get(prev);
        if (!next) {
          next = compute(prev);
          results.set(prev, next);
        }
        return next;
      });
    });
  };

  const start = (route: RouteProps): Attempt => {
    keepReloadTarget();
    return attempts.start(route);
  };

  // Queues the frame for an outcome. The promise settles when React has
  // committed that frame, or rejects when the attempt is dropped first.
  const show = (attempt: Attempt, outcome: Shown): Promise<void> => {
    if (attempt.signal.aborted) {
      return Promise.reject(abortError());
    }
    const committed = Promise.withResolvers<void>();
    attempt.signal.addEventListener('abort', () =>
      committed.reject(abortError()),
    );
    ignoreRejection(committed.promise);
    if (outcome.kind !== 'failed') {
      attempts.queue(attempt, outcome.route);
    }
    // A transition keeps the current content until the new frame is ready.
    // An instant preview is meant to replace it at once.
    update(outcome.kind === 'preview' ? runNow : startTransition, (prev) =>
      attempt.signal.aborted
        ? prev
        : nextFrame(prev, outcome, {
            navigation: attempt.id,
            settled: current.route,
            entryUrl: window.navigation.currentEntry?.url ?? undefined,
            committed: () => committed.resolve(),
          }),
    );
    return committed.promise;
  };

  // An update that moves nothing in the browser: the same location with new
  // content, as after a server function rerenders the route.
  const applyInPlace = async (
    route: RouteProps,
    options: ChangeRouteOptions,
    source: Source,
  ) => {
    const attempt = start(route);
    attempts.own(attempt);
    try {
      const outcome = await resolve(
        {
          route,
          url: options.url ?? new URL(window.location.href),
          scroll: options.shouldScroll,
          refetch: options.refetch,
          source,
        },
        current,
        current.cache,
        attempt.signal,
      );
      if (outcome.kind === 'leave' || outcome.kind === 'reload') {
        handOff(outcome, false);
        return;
      }
      // A failed load becomes a failed frame, which the boundary shows.
      ignoreRejection(show(attempt, outcome));
    } catch (e) {
      if (attempt.signal.aborted) {
        options.onSuperseded?.();
        return;
      }
      throw e;
    }
  };

  // Every route change the router itself starts goes through here.
  const request = (
    route: RouteProps,
    options: ChangeRouteOptions,
    source: Source,
  ): Promise<void> => {
    const url = options.url ?? getRouteUrl(route);
    if (!isSameOrigin(url)) {
      const error = otherOriginError(url);
      update(runNow, (prev) =>
        failedHere(prev, current.route, new URL(window.location.href), error),
      );
      return Promise.reject(error);
    }
    return options.history === null
      ? applyInPlace(route, options, source)
      : navigate(route, url, options.history, options, source);
  };
  const changeRoute: ChangeRoute = (route, options) =>
    request(route, options, fetched);

  const onNavigate = createNavigateListener({
    at: () => current,
    attempts,
    start,
    show,
  });

  // Fragment-only navigations are not intercepted, so record their hash.
  const onEntryChange = () => {
    const entryUrl = window.navigation.currentEntry?.url;
    if (!entryUrl) {
      return;
    }
    const url = new URL(entryUrl);
    const initial = { route: current.route, url: getRouteUrl(current.route) };
    update(runNow, (prev) => withFragment(prev, initial, url));
  };

  return {
    changeRoute,
    /** Records what React committed. */
    commit(committed: Committed) {
      current = committed;
      const { frame } = committed;
      if (frame.kind !== 'preview') {
        // A preview is still waiting for the response that fills it in.
        attempts.release(frame.scope.navigation);
      }
      if (frame.kind !== 'failed') {
        committed.cache.learnStaticFromElements(committed.elements);
      }
      if (frame.kind !== 'initial') {
        // Lets the browser finish the navigation this frame belongs to.
        frame.committed();
      }
    },
    /**
     * Starts listening to the browser. The caller runs this from the first
     * layout effect under the router, so a navigation started by any other
     * layout effect during mount is already seen.
     */
    connect() {
      const { navigation } = window;
      navigation.addEventListener('navigate', onNavigate);
      navigation.addEventListener('currententrychange', onEntryChange);
      return () => {
        navigation.removeEventListener('navigate', onNavigate);
        navigation.removeEventListener('currententrychange', onEntryChange);
      };
    },
    disconnect: () => attempts.dropAll(),
    getElements: () => current.elements,
    getRoute: () => current.route,
    getOrigin: () => originOfFrame(current.frame),
    getScope: () => current.frame.scope,
    /**
     * Whether `scope` still describes what is on screen and no navigation is
     * loading. With `exact`, a fragment change since then also ends it.
     */
    isCurrentScope(scope: Scope, exact: boolean) {
      const shown = current.frame.scope;
      return (
        scope.navigation === shown.navigation &&
        (!exact || scope.fragment === shown.fragment) &&
        !attempts.pending(shown.navigation)
      );
    },
    getPendingRoute: () =>
      attempts.pending(current.frame.scope.navigation)?.target,
    // During development a reload refetches the route the user is heading
    // for: one already queued but not painted yet, or else the one shown.
    getRefetchRoute: () => attempts.queuedRoute() ?? current.route,
    // A navigation still waiting for its response was requested from code
    // that has since changed; its response must not be shown.
    dropLoading: () => attempts.dropLoading(),
    // Follows a redirect or not-found that settled after its page was
    // shown. It continues the navigation that page came from, so it counts
    // against the same limit of follows.
    followIntent: (route: RouteProps, url: URL, shouldScroll: boolean) =>
      request(
        route,
        { shouldScroll, history: 'replace', url },
        {
          kind: 'fetch',
          follows: (originOfFrame(current.frame)?.follows ?? 0) + 1,
        },
      ),
    // A server function's response that names a route.
    async applyRouteResponse(response: Elements) {
      const next = getRouteFromElements(response)!;
      const shown = current.route;
      const sameRoute =
        shown.path === next.path &&
        (isStaticFromElements(response) || shown.query === next.query);
      const is404 = next.path === '/404';
      const source: Source = {
        kind: 'response',
        response: Promise.resolve(response),
      };
      const apply: ChangeRoute = (route, options) =>
        request(route, options, source);
      await dispatchChangeRoute(apply, sameRoute ? shown : next, {
        shouldScroll: false,
        history: sameRoute || is404 ? null : 'push',
        ...(is404 ? { url: new URL(window.location.href) } : {}),
      }).catch(reportUnlessAborted);
    },
    // A server function rerendered the displayed route while a navigation
    // is loading. The navigation goes on; the rerender joins the queued
    // frames, so it is there if the user ends up on that route after all.
    applyOriginRerender(response: Elements) {
      const origin = current.route;
      update(startTransition, (prev) =>
        withRerender(prev, current.route, origin, response),
      );
    },
  };
}
