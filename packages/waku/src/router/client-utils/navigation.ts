import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  unstable_combineElements as combineElements,
  unstable_isBuildIdMismatch as isBuildIdMismatch,
  unstable_isImmutableElement as isImmutableElement,
  useRegisterRscReloadListener_UNSTABLE as useRegisterRscReloadListener,
} from 'waku/minimal/client';
import {
  createRscParams,
  useRouterCache,
} from '../client-core-utils/caches.js';
import { useHmrRefetch } from '../client-core-utils/hmr.js';
import { useInitialRoute } from '../client-core-utils/initial-route.js';
import { rejectOnAbort } from '../client-core-utils/load.js';
import { buildMergePatch } from '../client-core-utils/merge-patch.js';
import {
  getRouteUrl,
  isSameOrigin,
  isSameRoute,
  isSameRscRoute,
  otherOriginError,
  parseRoute,
} from '../client-core-utils/route-url.js';
import type { ServerFunctionRouting } from '../client-core-utils/server-function-routing.js';
import { useServerFunctionRouting } from '../client-core-utils/server-function-routing.js';
import type { RouteProps } from '../isomorphic-utils/route-path.js';
import {
  INTENT_ID,
  IS_STATIC_ID,
  ROUTE_ID,
  encodeRoutePath,
  getRouteFromElements,
  has404FromElements,
  isMetaKey,
  isStaticFromElements,
} from '../isomorphic-utils/router-protocol.js';
import { dispatchChangeRoute } from './router-context.js';
import type { ChangeRoute, ChangeRouteOptions } from './router-context.js';
import { createRouterState, resolveServerRedirect } from './router-state.js';
import type { RouterState } from './router-state.js';
import { shouldScrollForRouteChange } from './scroll.js';

type Elements = Readonly<Record<string | symbol, unknown>>;

/**
 * The one piece of React state the router renders from: the displayed route
 * and the elements that belong to it change in the same update.
 */
export type RenderFrame = {
  /** `undefined` until the first navigation; the initial route shows then. */
  route: RouteProps | undefined;
  elements: Promise<Elements>;
  /** Identifies the navigation whose commit the browser is waiting for. */
  commitId: number;
  /** The request this frame came from; its identity scopes late intents. */
  state: RouterState | undefined;
  error: { error: unknown } | undefined;
};

type Prepared =
  | {
      kind: 'render';
      route: RouteProps;
      url: URL;
      state: RouterState;
      /** What the response contributed, for a navigation that adopts it. */
      patch: Elements;
      /** Applies this result to the newest elements; pure. */
      merge: (current: Elements, settled: RouteProps) => Elements;
      /** Whether the result carries a response fetched for it. */
      fetched: boolean;
    }
  | { kind: 'failed'; route: RouteProps; url: URL; error: unknown }
  | { kind: 'leave'; location: URL }
  | { kind: 'reload'; url: URL };

type Attempt = {
  id: number;
  controller: AbortController;
  signal: AbortSignal;
  target: Pick<RouteProps, 'path' | 'query'>;
  /**
   * Whether the browser URL already belongs to this attempt. Until then a
   * newer navigation cancels it. Afterwards only a newer attempt that takes
   * the URL itself does, so the content always catches up with the URL.
   */
  ownsUrl: boolean;
};

// Carried through `navigation.navigate()` so the navigate listener can tell
// a navigation this router started, and with which options.
class RequestInfo {
  constructor(
    readonly route: RouteProps,
    readonly options: ChangeRouteOptions,
    readonly settle: PromiseWithResolvers<void>,
  ) {}
}

// Marks a navigation the router hands to the browser as a document load.
const HANDOFF = { wakuHandoff: true } as const;

// A fragment-only navigation can move the entry while its route is loading.
const withEntryHash = (route: RouteProps, url: URL): RouteProps => {
  const entryUrl = window.navigation.currentEntry?.url;
  if (!entryUrl) {
    return route;
  }
  const entry = new URL(entryUrl);
  return entry.pathname === url.pathname && entry.search === url.search
    ? { ...route, hash: entry.hash }
    : route;
};

// `<a rel="external">` opts a same-origin link out of client navigation.
const isExternalLink = (element: Element | null | undefined) =>
  !!element
    ?.closest('a, area')
    ?.getAttribute('rel')
    ?.split(/\s+/)
    .includes('external');

const runNow = (update: () => void) => update();

// A result that only adds its patch on top of the newest elements.
const withPatch = (patch: Elements) => ({
  patch,
  merge: (current: Elements) => combineElements(current, patch),
  fetched: false,
});

const abortError = () => new DOMException('Navigation aborted', 'AbortError');

const ignoreRejection = (promise: Promise<unknown> | undefined) => {
  promise?.catch(() => {});
};

export function useNavigation(
  frame: RenderFrame,
  setFrame: Dispatch<SetStateAction<RenderFrame>>,
  elements: Elements,
  fallbackRoute: RouteProps,
  serverFunctionRouting: ServerFunctionRouting,
  routeInterceptor: ((route: RouteProps) => RouteProps | false) | undefined,
) {
  const routeInterceptorRef = useRef(routeInterceptor);
  useLayoutEffect(() => {
    routeInterceptorRef.current = routeInterceptor;
  }, [routeInterceptor]);
  const cache = useRouterCache();
  const initialRoute = useInitialRoute(fallbackRoute);
  const route = frame.route ?? initialRoute;
  const has404 = has404FromElements(elements);

  const registerRscReloadListener = useRegisterRscReloadListener();
  useEffect(() => {
    if (import.meta.hot) {
      // Router owns the HMR target; replace Minimal's initial-path listener.
      registerRscReloadListener(() => {}, { replace: true });
    }
  }, [registerRscReloadListener]);

  // What the last commit showed. Navigation decisions read this, never the
  // render in progress.
  const committedRef = useRef({ elements, route, state: frame.state });
  const [stateByElements] = useState(
    () => new WeakMap<Elements, RouterState | undefined>(),
  );
  const pendingRef = useRef<Attempt>(undefined);
  const liveAttemptsRef = useRef(new Set<Attempt>());
  const queuedRouteRef = useRef<{ id: number; route: RouteProps }>(undefined);
  // Set when a server function's refresh of this route arrived during a
  // navigation and was therefore not applied. If that navigation ends up
  // abandoned, the route is refetched so the refresh is not lost.
  const refreshOwedRef = useRef(false);
  const refreshAbandonedRef = useRef<() => void>(undefined);
  const nextIdRef = useRef(0);
  const commitWaitersRef = useRef(new Map<number, () => void>());
  const { commitId, error } = frame;
  useLayoutEffect(() => {
    committedRef.current = { elements, route, state: frame.state };
    stateByElements.set(elements, frame.state);
    if (pendingRef.current?.id === commitId) {
      pendingRef.current = undefined;
    }
    if (queuedRouteRef.current?.id === commitId) {
      queuedRouteRef.current = undefined;
    }
    if (!error) {
      cache.learnStaticFromElements(elements);
    }
    // Lets the browser finish the navigation this frame belongs to.
    commitWaitersRef.current.get(commitId)?.();
    commitWaitersRef.current.delete(commitId);
  }, [cache, elements, route, frame.state, commitId, error, stateByElements]);

  const getElements = useCallback(() => committedRef.current.elements, []);
  const getSettledRoute = useCallback(() => committedRef.current.route, []);
  const getRouteState = useCallback(
    (source: Elements) => stateByElements.get(source),
    [stateByElements],
  );
  const isCurrentRoute = useCallback(
    (source: Elements) => {
      const committed = committedRef.current;
      return (
        committed.state === stateByElements.get(source) &&
        committed.elements[INTENT_ID] === source[INTENT_ID] &&
        !pendingRef.current
      );
    },
    [stateByElements],
  );

  // During development a reload refetches the route the user is heading
  // for: one already accepted but not painted yet, or else the one shown.
  const getRefetchRoute = useCallback(
    () => queuedRouteRef.current?.route ?? committedRef.current.route,
    [],
  );
  // A navigation still waiting for its response was requested from code
  // that has since changed; its response must not be shown.
  const retireUnanswered = useCallback(() => {
    for (const attempt of [...liveAttemptsRef.current]) {
      if (!attempt.ownsUrl) {
        attempt.controller.abort();
      }
    }
  }, []);
  useHmrRefetch({
    getSettledRoute: getRefetchRoute,
    onBeforeRefetch: retireUnanswered,
  });

  // Fetches and follows the route. Touches neither the browser nor React.
  const prepare = useCallback(
    async (
      attempt: Attempt,
      nextRoute: RouteProps,
      url: URL,
      options: ChangeRouteOptions,
    ): Promise<Prepared> => {
      const committed = committedRef.current;
      const settled = committed.route;
      const base = committed.elements;
      const follows = options.follows ?? 0;
      const stateFor = (
        target: { route: RouteProps; url: URL },
        count: number,
      ) =>
        createRouterState(target.route, target.url, {
          history: options.history,
          scroll: options.shouldScroll,
          pathChanged:
            nextRoute.path !== settled.path ||
            target.route.path !== settled.path,
          follows: count,
        });
      const shouldRefetch =
        options.adopt !== undefined ||
        (options.refetch ??
          (!isSameRscRoute(nextRoute, settled) || refreshOwedRef.current));
      const canReuseStatic =
        options.adopt === undefined &&
        cache.canReuseStaticRoute(nextRoute, base);
      if (canReuseStatic || !shouldRefetch) {
        return {
          kind: 'render',
          route: nextRoute,
          url,
          state: stateFor({ route: nextRoute, url }, follows),
          ...withPatch({
            [ROUTE_ID]: [nextRoute.path, nextRoute.query],
            [INTENT_ID]: isSameRscRoute(nextRoute, settled)
              ? base[INTENT_ID]
              : null,
            ...(canReuseStatic ? { [IS_STATIC_ID]: true } : {}),
          }),
        };
      }
      // The request is cancelled only while nothing of it has been used.
      // Once its response is handed to React, the stream runs to the end even
      // if the attempt is dropped, since content on screen may read from it.
      const request = new AbortController();
      const cancelRequest = () => request.abort();
      attempt.signal.addEventListener('abort', cancelRequest);
      const outcome = await cache
        .load(nextRoute, {
          signal: request.signal,
          refetch: shouldRefetch,
          has404,
          base,
          url,
          follows,
          ...(options.adopt ? { adopt: options.adopt } : {}),
        })
        .finally(() => {
          attempt.signal.removeEventListener('abort', cancelRequest);
        });
      if (outcome.type === 'aborted' || attempt.signal.aborted) {
        throw abortError();
      }
      if (outcome.type === 'leave') {
        return { kind: 'leave', location: outcome.location };
      }
      if (outcome.type === 'failed') {
        return isBuildIdMismatch(outcome.error)
          ? { kind: 'reload', url: outcome.url }
          : {
              kind: 'failed',
              route: outcome.route,
              url: outcome.url,
              error: outcome.error,
            };
      }
      const responsePatch: Elements =
        outcome.type === 'reused'
          ? {
              [ROUTE_ID]: [outcome.route.path, outcome.route.query],
              [INTENT_ID]: null,
              [IS_STATIC_ID]:
                cache.canReuseStaticRoute(outcome.route, base) ||
                isStaticFromElements(base),
            }
          : outcome.elements;
      // The response names the route the server rendered, which differs from
      // the requested one after a redirect or for a custom 404.
      const destination = resolveServerRedirect(
        responsePatch,
        stateFor(outcome, outcome.follows),
        outcome.route.path,
      );
      attempt.target = destination.route;
      return {
        kind: 'render',
        route: destination.route,
        url: destination.url,
        state: stateFor(destination, outcome.follows),
        ...(outcome.type === 'loaded'
          ? {
              patch: responsePatch,
              // An action can have merged newer values while this response
              // was loading; those win.
              merge: (current, shown) =>
                combineElements(
                  current,
                  buildMergePatch(
                    { route: outcome.route, elements: responsePatch },
                    current,
                    base,
                    { settled: shown },
                  ),
                ),
              fetched: true,
            }
          : withPatch(responsePatch)),
      };
    },
    [cache, has404],
  );

  // Instant navigation: when the destination's shell is already held, show
  // it at once with the parts that still need the server left pending, and
  // let the response fill them in. Returns nothing when there is no shell.
  const startPreview = useCallback(
    (
      attempt: Attempt,
      nextRoute: RouteProps,
      url: URL,
      options: ChangeRouteOptions,
    ) => {
      const committed = committedRef.current;
      const shown = committed.elements;
      if (
        options.adopt !== undefined ||
        options.follows ||
        options.refetch === false ||
        isSameRscRoute(nextRoute, committed.route) ||
        cache.canReuseStaticRoute(nextRoute, shown) ||
        !cache.hasCachedShell(nextRoute, shown)
      ) {
        return;
      }
      const prefetched = cache.getPrefetchedElements(nextRoute);
      const request = new AbortController();
      const cancelRequest = () => request.abort();
      attempt.signal.addEventListener('abort', cancelRequest);
      const response = rejectOnAbort(
        cache.getPrefetch(nextRoute)?.promise ??
          cache.fetchRsc(
            encodeRoutePath(nextRoute.path),
            createRscParams(nextRoute.query),
            {
              signal: request.signal,
              ...(prefetched ? { unstable_base: prefetched } : {}),
            },
          ),
        request.signal,
      );
      response
        .catch(() => {})
        .finally(() => {
          attempt.signal.removeEventListener('abort', cancelRequest);
        });
      const overlay: Elements = {
        [ROUTE_ID]: [nextRoute.path, nextRoute.query],
        [IS_STATIC_ID]: isStaticFromElements(shown),
      };
      const preview: Prepared & { kind: 'render' } = {
        kind: 'render',
        route: nextRoute,
        url,
        state: createRouterState(nextRoute, url, {
          history: options.history,
          scroll: options.shouldScroll,
          pathChanged: nextRoute.path !== committed.route.path,
          follows: 0,
        }),
        patch: overlay,
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
        fetched: false,
      };
      return { preview, response };
    },
    [cache],
  );

  // Queues the frame for a prepared route. Returns once React has committed
  // it when `waitForCommit` is set.
  const accept = useCallback(
    (
      attempt: Attempt,
      prepared: Prepared & { kind: 'render' | 'failed' },
      // A transition keeps the current content until the new frame is ready.
      // An instant preview is meant to replace it at once.
      schedule: (update: () => void) => void = startTransition,
    ) => {
      if (attempt.signal.aborted) {
        throw abortError();
      }
      const committed = new Promise<void>((resolve, reject) => {
        commitWaitersRef.current.set(attempt.id, resolve);
        attempt.signal.addEventListener('abort', () => {
          commitWaitersRef.current.delete(attempt.id);
          reject(abortError());
        });
      });
      ignoreRejection(committed);
      if (prepared.kind === 'render') {
        queuedRouteRef.current = { id: attempt.id, route: prepared.route };
        if (prepared.fetched) {
          refreshOwedRef.current = false;
        }
      }
      // React can run the updater more than once for the same previous
      // frame; each run must return the same elements promise.
      const results = new WeakMap<RenderFrame, RenderFrame>();
      schedule(() => {
        setFrame((prev) => {
          if (attempt.signal.aborted) {
            return prev;
          }
          const replayed = results.get(prev);
          if (replayed) {
            return replayed;
          }
          const next = createFrame(prev);
          results.set(prev, next);
          return next;
        });
      });
      return committed;

      function createFrame(prev: RenderFrame): RenderFrame {
        if (prepared.kind === 'failed') {
          return {
            ...prev,
            route: prepared.route,
            commitId: attempt.id,
            state: undefined,
            error: { error: prepared.error },
          };
        }
        const settled = committedRef.current.route;
        return {
          route: withEntryHash(prepared.route, prepared.url),
          elements: prev.elements.then((current) =>
            prepared.merge(current, settled),
          ),
          commitId: attempt.id,
          state: prepared.state,
          error: undefined,
        };
      }
    },
    [setFrame],
  );

  const startAttempt = useCallback(
    (target: Pick<RouteProps, 'path' | 'query'>): Attempt => {
      const controller = new AbortController();
      const attempt: Attempt = {
        id: ++nextIdRef.current,
        controller,
        signal: controller.signal,
        target,
        ownsUrl: false,
      };
      liveAttemptsRef.current.add(attempt);
      pendingRef.current = attempt;
      if (import.meta.hot) {
        // Router owns the HMR target; keep Minimal's listener replaced.
        registerRscReloadListener(() => {}, { replace: true });
      }
      controller.signal.addEventListener('abort', () => {
        liveAttemptsRef.current.delete(attempt);
        if (queuedRouteRef.current?.id === attempt.id) {
          queuedRouteRef.current = undefined;
        }
        if (pendingRef.current === attempt) {
          pendingRef.current = undefined;
          if (refreshOwedRef.current) {
            refreshAbandonedRef.current?.();
          }
        }
      });
      return attempt;
    },
    [registerRscReloadListener],
  );
  // The attempt now decides what the current URL shows; older ones give way.
  const takeUrl = useCallback((attempt: Attempt) => {
    attempt.ownsUrl = true;
    for (const other of [...liveAttemptsRef.current]) {
      if (other.id < attempt.id) {
        other.controller.abort();
      }
    }
  }, []);
  // Drop the attempts when the router goes away. StrictMode runs effects
  // twice on mount, so wait a tick and skip the drop if the effect is back.
  const unmountRef = useRef<{ cancelled: boolean }>(undefined);
  useEffect(() => {
    if (unmountRef.current) {
      unmountRef.current.cancelled = true;
    }
    const liveAttempts = liveAttemptsRef.current;
    return () => {
      const unmount = { cancelled: false };
      unmountRef.current = unmount;
      queueMicrotask(() => {
        if (unmount.cancelled) {
          return;
        }
        refreshAbandonedRef.current = undefined;
        for (const attempt of [...liveAttempts]) {
          attempt.controller.abort();
        }
      });
    };
  }, []);

  // An update that moves nothing in the browser: the same location with new
  // content, as after a server function rerenders the route.
  const applyInPlace = useCallback(
    async (nextRoute: RouteProps, options: ChangeRouteOptions) => {
      const attempt = startAttempt(nextRoute);
      takeUrl(attempt);
      const url = options.url ?? new URL(window.location.href);
      try {
        const prepared = await prepare(attempt, nextRoute, url, options);
        if (prepared.kind === 'leave') {
          void window.navigation.navigate(prepared.location.href, {
            info: HANDOFF,
            history: 'replace',
          });
          return;
        }
        if (prepared.kind === 'reload') {
          void window.navigation.reload({ info: HANDOFF });
          return;
        }
        ignoreRejection(accept(attempt, prepared));
        if (prepared.kind === 'failed') {
          throw prepared.error;
        }
      } catch (e) {
        if (attempt.signal.aborted) {
          options.onSuperseded?.();
          return;
        }
        throw e;
      }
    },
    [accept, prepare, startAttempt, takeUrl],
  );

  const changeRoute: ChangeRoute = useCallback(
    (nextRoute, options) => {
      const url = options.url ?? getRouteUrl(nextRoute);
      if (!isSameOrigin(url)) {
        const error = otherOriginError(url);
        setFrame((prev) => ({ ...prev, error: { error } }));
        return Promise.reject(error);
      }
      if (options.history === null) {
        return applyInPlace(nextRoute, options);
      }
      const settle = Promise.withResolvers<void>();
      const result = window.navigation.navigate(url.href, {
        history: options.history === 'replace' ? 'replace' : 'auto',
        info: new RequestInfo(nextRoute, options, settle),
      });
      // The router reports the outcome through `settle`.
      ignoreRejection(result.committed);
      ignoreRejection(result.finished);
      return settle.promise;
    },
    [applyInPlace, setFrame],
  );

  const applyRouteResponse = useCallback(
    async (responseElements: Elements) => {
      const nextRoute = getRouteFromElements(responseElements)!;
      const current = getSettledRoute();
      const sameRoute =
        current.path === nextRoute.path &&
        (isStaticFromElements(responseElements) ||
          current.query === nextRoute.query);
      const is404 = nextRoute.path === '/404';
      await dispatchChangeRoute(changeRoute, sameRoute ? current : nextRoute, {
        adopt: Promise.resolve(responseElements),
        shouldScroll: false,
        history: sameRoute || is404 ? null : 'push',
        ...(is404 ? { url: new URL(window.location.href) } : {}),
      }).catch(() => {});
    },
    [changeRoute, getSettledRoute],
  );
  const getPendingRoute = useCallback(() => {
    const target = pendingRef.current?.target;
    if (target) {
      // The caller drops a refresh of the shown route while this is set.
      refreshOwedRef.current = true;
    }
    return target;
  }, []);
  useEffect(() => {
    refreshAbandonedRef.current = () => {
      startTransition(() => {
        void applyInPlace(committedRef.current.route, {
          refetch: true,
          shouldScroll: false,
          history: null,
        }).catch(() => {});
      });
    };
  }, [applyInPlace]);
  useServerFunctionRouting(serverFunctionRouting, {
    getSettledRoute,
    getPendingRoute,
    applyRouteResponse,
  });

  // Starts listening to the browser. The caller runs this from the first
  // layout effect under the router, so a navigation started by any other
  // layout effect during mount is already seen.
  const connect = useCallback(() => {
    const { navigation } = window;

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
      if (isExternalLink(event.sourceElement)) {
        // The author asked for a document load, for example to sign out.
        return;
      }
      const info = event.info instanceof RequestInfo ? event.info : undefined;
      if (event.hashChange) {
        // The browser scrolls to the fragment unless the caller opted out;
        // `currententrychange` below records the new hash.
        if (info && !info.options.shouldScroll) {
          event.intercept({ scroll: 'manual', focusReset: 'manual' });
        }
        info?.settle.resolve();
        return;
      }
      if (
        !info &&
        event.destination.sameDocument &&
        (event.navigationType === 'push' || event.navigationType === 'replace')
      ) {
        // `history.pushState()` or `replaceState()` from other code: that
        // code changed the URL for its own purposes and shows its own content.
        return;
      }
      const url = new URL(event.destination.url);
      const requestedRoute = info?.route ?? parseRoute(url);
      const nextRoute = requestedRoute;
      const options: ChangeRouteOptions = info?.options ?? {
        shouldScroll: true,
        history: event.navigationType === 'replace' ? 'replace' : 'push',
      };
      const attempt = startAttempt(nextRoute);
      event.signal.addEventListener('abort', () => {
        if (!attempt.ownsUrl) {
          attempt.controller.abort();
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

      // Tagged, so this listener lets the browser load the document.
      const handOff = (prepared: Prepared & { kind: 'leave' | 'reload' }) => {
        const result = navigation.navigate(
          prepared.kind === 'leave'
            ? prepared.location.href
            : // Another build answered: load its document at this URL.
              prepared.url.href,
          {
            info: HANDOFF,
            history: event.navigationType === 'push' ? 'push' : 'replace',
          },
        );
        ignoreRejection(result.committed);
        ignoreRejection(result.finished);
      };

      const show = async (
        prepared: Prepared & { kind: 'render' | 'failed' },
        schedule?: (update: () => void) => void,
      ) => {
        const committed = accept(attempt, prepared, schedule);
        // The frame is queued and the URL has moved: the caller can go on.
        if (prepared.kind === 'failed') {
          fail(prepared.error);
        } else {
          info?.settle.resolve();
        }
        await committed;
      };

      const behavior = options.shouldScroll
        ? {}
        : ({ scroll: 'manual', focusReset: 'manual' } as const);
      const canPrepareFirst =
        event.cancelable &&
        (event.navigationType === 'push' || event.navigationType === 'replace');

      // The route the response names is not the one this entry asked for.
      // Replace the entry with a navigation that shows that response.
      const redirectTo = (result: Prepared & { kind: 'render' }) => {
        startTransition(() => {
          void changeRoute(result.route, {
            adopt: Promise.resolve(result.patch),
            shouldScroll: options.shouldScroll,
            history: 'replace',
            url: result.url,
          }).catch(() => {});
        });
      };

      const instant =
        options.instant && canPrepareFirst
          ? startPreview(attempt, nextRoute, url, options)
          : undefined;
      if (instant) {
        // The shell is already here: move at once, show it, and let the
        // response fill in the rest.
        const fill = async () => {
          let result: Prepared;
          try {
            result = await prepare(attempt, nextRoute, url, {
              ...options,
              adopt: instant.response,
            });
          } catch (e) {
            if (!attempt.signal.aborted) {
              fail(e);
            }
            return;
          }
          if (result.kind === 'leave' || result.kind === 'reload') {
            handOff(result);
          } else if (result.kind === 'failed') {
            ignoreRejection(accept(attempt, result));
          } else if (result.url.href !== url.href) {
            redirectTo(result);
          } else {
            const { patch } = result;
            ignoreRejection(
              accept(attempt, {
                ...result,
                // The preview already reads the response where it left
                // parts pending; add only what it did not represent.
                merge: (current) =>
                  combineElements(current, patch, {
                    filter: (key) =>
                      typeof key === 'string' &&
                      (isMetaKey(key) || !Object.hasOwn(current, key)),
                  }),
              }),
            );
          }
        };
        event.intercept({
          ...behavior,
          handler: async () => {
            takeUrl(attempt);
            const shown = show(instant.preview, runNow);
            void fill();
            await shown;
          },
        });
        return;
      }

      if (canPrepareFirst) {
        // Load before the URL moves, so the address bar and the content
        // change together and a redirect leaves no entry of its own.
        let prepared: (Prepared & { kind: 'render' | 'failed' }) | undefined;
        event.intercept({
          ...behavior,
          precommitHandler: async (controller) => {
            let result: Prepared;
            try {
              result = await prepare(attempt, nextRoute, url, options);
            } catch (e) {
              fail(e);
              throw e;
            }
            if (result.kind === 'leave' || result.kind === 'reload') {
              handOff(result);
              throw abortError();
            }
            if (result.url.href !== event.destination.url) {
              controller.redirect(result.url.href);
            }
            prepared = result;
          },
          handler: () => {
            takeUrl(attempt);
            return show(prepared!);
          },
        });
        return;
      }

      // The browser has already decided to move (Back, Forward, reload).
      const interceptor =
        event.navigationType === 'traverse'
          ? routeInterceptorRef.current
          : undefined;
      event.intercept({
        // With an interceptor the outcome is not known yet, so the browser
        // must not scroll on its own.
        ...(interceptor
          ? ({ scroll: 'manual', focusReset: 'manual' } as const)
          : behavior),
        handler: async () => {
          if (interceptor) {
            // The address bar has moved; the app decides what it shows.
            const decided = interceptor(nextRoute);
            if (!decided || !isSameRoute(decided, nextRoute)) {
              attempt.controller.abort();
              if (decided) {
                startTransition(() => {
                  void changeRoute(decided, {
                    shouldScroll: shouldScrollForRouteChange(
                      decided,
                      committedRef.current.route,
                    ),
                    history: 'replace',
                  }).catch(() => {});
                });
              }
              return;
            }
          }
          takeUrl(attempt);
          let result: Prepared;
          try {
            result = await prepare(attempt, nextRoute, url, options);
          } catch (e) {
            fail(e);
            throw e;
          }
          if (result.kind === 'leave' || result.kind === 'reload') {
            handOff(result);
            return;
          }
          if (
            result.kind === 'render' &&
            result.url.href !== event.destination.url
          ) {
            redirectTo(result);
            return;
          }
          await show(result);
          if (interceptor && options.shouldScroll) {
            event.scroll();
          }
        },
      });
    };

    // Fragment-only navigations are not intercepted, so record their hash
    // here. A new state object makes intents captured before it stale.
    const onEntryChange = () => {
      const entryUrl = navigation.currentEntry?.url;
      if (!entryUrl) {
        return;
      }
      const url = new URL(entryUrl);
      const shown = committedRef.current.route;
      setFrame((prev) => {
        // The newest frame, which may still be waiting to commit.
        const target = prev.route ?? shown;
        const targetUrl = prev.state
          ? new URL(prev.state.url, url)
          : getRouteUrl(target);
        if (
          prev.error ||
          url.hash === target.hash ||
          url.pathname + url.search !== targetUrl.pathname + targetUrl.search
        ) {
          return prev;
        }
        const route = { ...target, hash: url.hash };
        return {
          ...prev,
          route,
          // A new object, so intents captured before this are stale.
          state: {
            ...createRouterState(route, url, {
              history: null,
              scroll: false,
              pathChanged: false,
              follows: prev.state?.follows ?? 0,
            }),
            ...(prev.state ? { requested: prev.state.requested } : {}),
          },
        };
      });
    };

    navigation.addEventListener('navigate', onNavigate);
    navigation.addEventListener('currententrychange', onEntryChange);
    return () => {
      navigation.removeEventListener('navigate', onNavigate);
      navigation.removeEventListener('currententrychange', onEntryChange);
    };
  }, [
    accept,
    changeRoute,
    prepare,
    setFrame,
    startAttempt,
    startPreview,
    takeUrl,
  ]);

  return {
    route,
    connect,
    changeRoute,
    getElements,
    getRouteState,
    isCurrentRoute,
  };
}
