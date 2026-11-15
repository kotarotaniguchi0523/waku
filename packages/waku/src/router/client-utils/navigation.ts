import {
  startTransition,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useRegisterRscReloadListener_UNSTABLE as useRegisterRscReloadListener } from 'waku/minimal/client';
import { useRouterCache } from '../client-core-utils/caches.js';
import type { RouterCache } from '../client-core-utils/caches.js';
import { useHmrRefetch } from '../client-core-utils/hmr.js';
import { useInitialRoute } from '../client-core-utils/initial-route.js';
import {
  getRouteUrl,
  isSameOrigin,
  otherOriginError,
  parseRoute,
} from '../client-core-utils/route-url.js';
import type { ServerFunctionRouting } from '../client-core-utils/server-function-routing.js';
import { useServerFunctionRouting } from '../client-core-utils/server-function-routing.js';
import type { RouteProps } from '../isomorphic-utils/route-path.js';
import {
  getRouteFromElements,
  has404FromElements,
  isStaticFromElements,
} from '../isomorphic-utils/router-protocol.js';
import { createAttempts } from './attempts.js';
import type { Attempt } from './attempts.js';
import {
  failedHere,
  nextFrame,
  originOfFrame,
  routeOf,
  withFragment,
  withRerender,
} from './frame.js';
import type { Elements, Outcome, RenderFrame, Scope, Shown } from './frame.js';
import { HANDOFF, handOff } from './handoff.js';
import { startPreview } from './instant-preview.js';
import { abortError, ignoreRejection, isAbortError } from './promises.js';
import { resolve } from './resolve.js';
import type { Displayed, Request } from './resolve.js';
import { dispatchChangeRoute } from './router-context.js';
import type { ChangeRoute, ChangeRouteOptions } from './router-context.js';
import {
  scrollToHashWhenRendered,
  shouldScrollForRouteChange,
} from './scroll.js';
import { acceptReturn, guardTraversal } from './traversal-guard.js';

type Interceptor = ((route: RouteProps) => RouteProps | false) | undefined;

/** What the last commit showed. Decisions read this, never a render. */
type Committed = Displayed & {
  readonly frame: RenderFrame;
  readonly cache: RouterCache;
  readonly interceptor: Interceptor;
};

// Carried through `navigation.navigate()` so the navigate listener can tell
// a navigation this router started, with which options, and whether its
// result is already known.
class RequestInfo {
  constructor(
    readonly route: RouteProps,
    readonly options: ChangeRouteOptions,
    readonly settle: PromiseWithResolvers<void>,
    readonly carried: Extract<Outcome, { kind: 'render' }> | undefined,
  ) {}
}

const quiet = { scroll: 'manual', focusReset: 'manual' } as const;

const runNow = (update: () => void) => update();

// A dropped update is expected. Anything else would otherwise disappear
// without a trace.
const reportUnlessAborted = (error: unknown) => {
  if (!isAbortError(error)) {
    console.error('Error while applying a route update:', error);
  }
};

// `<a rel="external">` opts a same-origin link out of client navigation, and
// a `download` link is the browser's to handle. The event's own
// `downloadRequest` is checked too, but one browser follows it with a second
// event that does not carry it.
const isExternalLink = (element: Element | null | undefined) => {
  const anchor = element?.closest('a, area');
  return (
    !!anchor &&
    (anchor.hasAttribute('download') ||
      !!anchor.getAttribute('rel')?.split(/\s+/).includes('external'))
  );
};

const toRequest = (
  route: RouteProps,
  url: URL,
  options: ChangeRouteOptions,
): Request => ({
  route,
  url,
  scroll: options.shouldScroll,
  follows: options.follows ?? 0,
  refetch: options.refetch,
  adopt: options.adopt,
});

/**
 * The Navigation API binding. The browser owns the URL, history, scroll and
 * focus; this listens for navigations, resolves each one with `resolve()`,
 * and queues the frame that shows the result.
 */
function createNavigation(
  setFrame: Dispatch<SetStateAction<RenderFrame>>,
  first: Committed,
  onAttemptStart: () => void,
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
    onAttemptStart();
    return attempts.start(route);
  };

  // Queues the frame for an outcome. The promise settles when React has
  // committed that frame, or rejects when the attempt is dropped first.
  const show = (
    attempt: Attempt,
    outcome: Shown,
    // A transition keeps the current content until the new frame is ready.
    // An instant preview is meant to replace it at once.
    schedule: (update: () => void) => void = startTransition,
  ): Promise<void> => {
    if (attempt.signal.aborted) {
      throw abortError();
    }
    const committed = Promise.withResolvers<void>();
    attempt.signal.addEventListener('abort', () =>
      committed.reject(abortError()),
    );
    ignoreRejection(committed.promise);
    if (outcome.kind !== 'failed') {
      attempt.queued = outcome.route;
    }
    update(schedule, (prev) =>
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
  ) => {
    const attempt = start(route);
    attempts.own(attempt);
    const url = options.url ?? new URL(window.location.href);
    try {
      const outcome = await resolve(
        toRequest(route, url, options),
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

  // Asks the browser to navigate; the listener below takes it from there.
  const navigate = (
    route: RouteProps,
    options: ChangeRouteOptions,
    url: URL,
    carried: RequestInfo['carried'],
  ) => {
    const settle = Promise.withResolvers<void>();
    const result = window.navigation.navigate(url.href, {
      history: options.history === 'replace' ? 'replace' : 'auto',
      info: new RequestInfo(route, options, settle, carried),
    });
    // The router reports the outcome through `settle`.
    ignoreRejection(result.committed);
    ignoreRejection(result.finished);
    return settle.promise;
  };

  const changeRoute: ChangeRoute = (route, options) => {
    const url = options.url ?? getRouteUrl(route);
    if (!isSameOrigin(url)) {
      const error = otherOriginError(url);
      update(runNow, (prev) =>
        failedHere(prev, current.route, new URL(window.location.href), error),
      );
      return Promise.reject(error);
    }
    return options.history === null
      ? applyInPlace(route, options)
      : navigate(route, options, url, undefined);
  };

  const onNavigate = (event: NavigateEvent) => {
    if (
      event.info === HANDOFF ||
      // React navigates to the current URL while a transition is pending,
      // only to make the browser show that the page is busy.
      event.info === 'react-transition' ||
      !event.canIntercept ||
      event.downloadRequest !== null ||
      event.formData
    ) {
      return;
    }
    if (acceptReturn(event)) {
      return;
    }
    if (isExternalLink(event.sourceElement)) {
      // The author asked for a document load, for example to sign out.
      return;
    }
    const info = event.info instanceof RequestInfo ? event.info : undefined;
    if (event.hashChange) {
      // The browser scrolls to the fragment unless the caller opted out;
      // `currententrychange` below records the new hash.
      if (info && !info.options.shouldScroll) {
        event.intercept(quiet);
      }
      info?.settle.resolve();
      return;
    }
    const push = event.navigationType === 'push';
    const replace = event.navigationType === 'replace';
    if (!info && event.destination.sameDocument && (push || replace)) {
      // `history.pushState()` or `replaceState()` from other code: that
      // code changed the URL for its own purposes and shows its own content.
      return;
    }
    const url = new URL(event.destination.url);
    const route = info?.route ?? parseRoute(url);
    const showInstead = (decided: RouteProps) => {
      ignoreRejection(
        changeRoute(decided, {
          shouldScroll: shouldScrollForRouteChange(decided, current.route),
          history: 'replace',
        }).catch(reportUnlessAborted),
      );
    };
    if (guardTraversal(event, route, current.interceptor, showInstead)) {
      return;
    }
    const options: ChangeRouteOptions = info?.options ?? {
      // Back and Forward between entries that differ only in the query stay
      // where the page is, like a query-only push.
      shouldScroll:
        event.navigationType !== 'traverse' ||
        shouldScrollForRouteChange(route, current.route),
      history: replace ? 'replace' : 'push',
    };

    const attempt = start(route);
    event.signal.addEventListener('abort', () => {
      // Once the URL has moved, only a later URL-taking navigation drops it.
      if (attempts.isLoading(attempt)) {
        attempt.abort();
      }
    });
    attempt.signal.addEventListener('abort', () => {
      options.onSuperseded?.();
      // A superseded navigation counts as handled.
      info?.settle.resolve();
    });
    const fail = (error: unknown) => {
      if (info) {
        info.settle.reject(error);
      } else if (!attempt.signal.aborted) {
        console.error('Error while navigating:', error);
      }
    };

    // Push and replace wait for the result before the URL moves, so the
    // address bar and the content change together and a redirect leaves no
    // entry of its own. Back, Forward and reload have already moved.
    const waitsBeforeCommit = event.cancelable && (push || replace);
    const request = toRequest(route, url, options);
    // With the destination's shell at hand, an instant navigation moves at
    // once, shows the shell, and lets the response fill in the rest.
    const instant =
      options.instant && waitsBeforeCommit && !info?.carried
        ? startPreview(request, current, current.cache, attempt.signal)
        : undefined;
    // The result is resolved once; both handlers below wait for it.
    const outcome = info?.carried
      ? Promise.resolve(info.carried)
      : resolve(
          instant ? { ...request, adopt: instant.response } : request,
          current,
          current.cache,
          attempt.signal,
        );
    ignoreRejection(outcome);
    let committedUrl = event.destination.url;

    // Shows a result and reports it to the caller of `push()` / `replace()`.
    const present = async (
      result: Shown,
      schedule?: (update: () => void) => void,
    ) => {
      const committed = show(attempt, result, schedule);
      // The frame is queued and the URL has moved: the caller can go on.
      if (result.kind === 'failed') {
        fail(result.error);
      } else {
        info?.settle.resolve();
      }
      // Read while this navigation is still the browser's current one.
      const transition = event.signal.aborted
        ? undefined
        : window.navigation.transition;
      await committed;
      if (
        result.kind !== 'failed' &&
        options.shouldScroll &&
        (push || replace)
      ) {
        // After the browser's own scroll, which a late target missed.
        transition?.finished.then(
          () => scrollToHashWhenRendered(current.route.hash),
          () => {},
        );
      }
    };

    // After the URL has moved: leave, replace the entry, or show.
    const finish = async (display: (result: Shown) => Promise<void> | void) => {
      const result = await outcome;
      if (result.kind === 'leave' || result.kind === 'reload') {
        handOff(result, push);
      } else if (result.kind === 'render' && result.url.href !== committedUrl) {
        // The response names another route than this entry asked for.
        // Replace the entry with a navigation that shows that response.
        ignoreRejection(
          navigate(
            result.route,
            { shouldScroll: options.shouldScroll, history: 'replace' },
            result.url,
            // Slots are compared with what is shown now, which an instant
            // preview has changed since the request started.
            result.source.kind === 'response'
              ? {
                  ...result,
                  source: { ...result.source, base: current.elements },
                }
              : result,
          ),
        );
      } else {
        await display(result);
      }
    };

    event.intercept({
      ...(options.shouldScroll ? {} : quiet),
      ...(waitsBeforeCommit && !instant
        ? {
            precommitHandler: async (controller) => {
              let result: Outcome;
              try {
                result = await outcome;
              } catch (e) {
                fail(e);
                throw e;
              }
              if (result.kind === 'leave' || result.kind === 'reload') {
                // Cancel this navigation first. A document navigation
                // started while it is still being cancelled can be
                // cancelled with it.
                setTimeout(() => handOff(result, push));
                throw abortError();
              }
              if (result.url.href !== committedUrl) {
                controller.redirect(result.url.href);
                committedUrl = result.url.href;
              }
            },
          }
        : {}),
      handler: async () => {
        attempts.own(attempt);
        if (instant) {
          const previewed = present(instant.preview, runNow);
          finish((result) => ignoreRejection(show(attempt, result))).catch(
            (e) => {
              if (!attempt.signal.aborted) {
                fail(e);
              }
            },
          );
          await previewed;
          return;
        }
        try {
          await finish(present);
        } catch (e) {
          fail(e);
          throw e;
        }
      },
    });
  };

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
      attempts.committed(frame.scope.navigation, frame.kind !== 'preview');
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
    // A server function's response that names a route.
    async applyRouteResponse(response: Elements) {
      const next = getRouteFromElements(response)!;
      const shown = current.route;
      const sameRoute =
        shown.path === next.path &&
        (isStaticFromElements(response) || shown.query === next.query);
      const is404 = next.path === '/404';
      await dispatchChangeRoute(changeRoute, sameRoute ? shown : next, {
        adopt: Promise.resolve(response),
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

export function useNavigation(
  frame: RenderFrame,
  setFrame: Dispatch<SetStateAction<RenderFrame>>,
  elements: Elements,
  fallbackRoute: RouteProps,
  serverFunctionRouting: ServerFunctionRouting,
  interceptor: Interceptor,
) {
  const cache = useRouterCache();
  const route = routeOf(frame, useInitialRoute(fallbackRoute));
  const has404 = has404FromElements(elements);
  const committed: Committed = {
    frame,
    elements,
    route,
    has404,
    cache,
    interceptor,
  };

  const registerRscReloadListener = useRegisterRscReloadListener();
  // Router owns the HMR target; keep Minimal's initial-path listener replaced.
  const [keepReloadTarget] = useState(() => () => {
    if (import.meta.hot) {
      registerRscReloadListener(() => {}, { replace: true });
    }
  });
  useEffect(keepReloadTarget, [keepReloadTarget]);

  const [navigation] = useState(() =>
    createNavigation(setFrame, committed, keepReloadTarget),
  );
  useLayoutEffect(() => {
    navigation.commit({ frame, elements, route, has404, cache, interceptor });
  }, [navigation, frame, elements, route, has404, cache, interceptor]);

  // Drop the attempts when the router goes away. StrictMode runs effects
  // twice on mount, so wait a tick and skip the drop if the effect is back.
  const unmountRef = useRef<{ cancelled: boolean }>(undefined);
  useEffect(() => {
    if (unmountRef.current) {
      unmountRef.current.cancelled = true;
    }
    return () => {
      const unmount = { cancelled: false };
      unmountRef.current = unmount;
      queueMicrotask(() => {
        if (!unmount.cancelled) {
          navigation.disconnect();
        }
      });
    };
  }, [navigation]);

  useHmrRefetch({
    getSettledRoute: navigation.getRefetchRoute,
    onBeforeRefetch: navigation.dropLoading,
  });
  useServerFunctionRouting(serverFunctionRouting, {
    getSettledRoute: navigation.getRoute,
    getPendingRoute: navigation.getPendingRoute,
    applyRouteResponse: navigation.applyRouteResponse,
    onOriginRerenderDropped: navigation.applyOriginRerender,
  });

  return { route, navigation };
}
