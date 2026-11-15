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
  useRegisterRscReloadListener_UNSTABLE as useRegisterRscReloadListener,
} from 'waku/minimal/client';
import { useRouterCache } from '../client-core-utils/caches.js';
import { useHmrRefetch } from '../client-core-utils/hmr.js';
import { useInitialRoute } from '../client-core-utils/initial-route.js';
import { buildMergePatch } from '../client-core-utils/merge-patch.js';
import {
  getRouteUrl,
  isSameOrigin,
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
  getRouteFromElements,
  has404FromElements,
  isStaticFromElements,
} from '../isomorphic-utils/router-protocol.js';
import { dispatchChangeRoute } from './router-context.js';
import type { ChangeRoute, ChangeRouteOptions } from './router-context.js';
import { createRouterState, resolveServerRedirect } from './router-state.js';
import type { RouterState } from './router-state.js';

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
      patch: Elements;
      /** The response to check against updates made while it was loading. */
      loaded: { route: RouteProps; base: Elements } | undefined;
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

const abortError = () => new DOMException('Navigation aborted', 'AbortError');

const ignoreRejection = (promise: Promise<unknown> | undefined) => {
  promise?.catch(() => {});
};

export function useNativeNavigation(
  frame: RenderFrame,
  setFrame: Dispatch<SetStateAction<RenderFrame>>,
  elements: Elements,
  fallbackRoute: RouteProps,
  serverFunctionRouting: ServerFunctionRouting,
) {
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

  useHmrRefetch({ getSettledRoute });

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
          patch: {
            [ROUTE_ID]: [nextRoute.path, nextRoute.query],
            [INTENT_ID]: isSameRscRoute(nextRoute, settled)
              ? base[INTENT_ID]
              : null,
            ...(canReuseStatic ? { [IS_STATIC_ID]: true } : {}),
          },
          loaded: undefined,
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
        patch: responsePatch,
        loaded:
          outcome.type === 'loaded'
            ? { route: outcome.route, base }
            : undefined,
      };
    },
    [cache, has404],
  );

  // Queues the frame for a prepared route. Returns once React has committed
  // it when `waitForCommit` is set.
  const accept = useCallback(
    (attempt: Attempt, prepared: Prepared & { kind: 'render' | 'failed' }) => {
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
      if (prepared.kind === 'render' && prepared.loaded) {
        refreshOwedRef.current = false;
      }
      startTransition(() => {
        setFrame((prev) => {
          if (attempt.signal.aborted) {
            return prev;
          }
          if (prepared.kind === 'failed') {
            return {
              ...prev,
              route: prepared.route,
              commitId: attempt.id,
              state: undefined,
              error: { error: prepared.error },
            };
          }
          const { patch, loaded } = prepared;
          const settled = committedRef.current.route;
          return {
            route: withEntryHash(prepared.route, prepared.url),
            elements: prev.elements.then((current) =>
              combineElements(
                current,
                loaded
                  ? // An action can have merged newer values while this
                    // response was loading; those win.
                    buildMergePatch(
                      { route: loaded.route, elements: patch },
                      current,
                      loaded.base,
                      { settled },
                    )
                  : patch,
              ),
            ),
            commitId: attempt.id,
            state: prepared.state,
            error: undefined,
          };
        });
      });
      return committed;
    },
    [setFrame],
  );

  const liveAttemptsRef = useRef(new Set<Attempt>());
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
      controller.signal.addEventListener('abort', () => {
        liveAttemptsRef.current.delete(attempt);
        if (pendingRef.current === attempt) {
          pendingRef.current = undefined;
          if (refreshOwedRef.current) {
            refreshAbandonedRef.current?.();
          }
        }
      });
      return attempt;
    },
    [],
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
  useEffect(() => {
    const liveAttempts = liveAttemptsRef.current;
    return () => {
      refreshAbandonedRef.current = undefined;
      for (const attempt of [...liveAttempts]) {
        attempt.controller.abort();
      }
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
          window.location.replace(prepared.location.href);
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

  useLayoutEffect(() => {
    const { navigation } = window;

    const onNavigate = (event: NavigateEvent) => {
      if (
        event.info === HANDOFF ||
        !event.canIntercept ||
        event.downloadRequest !== null ||
        event.formData
      ) {
        return;
      }
      if (event.hashChange) {
        // The browser scrolls to the fragment; `currententrychange` below
        // records the new hash.
        return;
      }
      const info = event.info instanceof RequestInfo ? event.info : undefined;
      const url = new URL(event.destination.url);
      const nextRoute = info?.route ?? parseRoute(url);
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

      const handOff = (prepared: Prepared & { kind: 'leave' | 'reload' }) => {
        if (prepared.kind === 'leave') {
          if (event.navigationType === 'push') {
            window.location.assign(prepared.location.href);
          } else {
            window.location.replace(prepared.location.href);
          }
        } else {
          // Another build answered: load its document at the requested URL.
          void navigation.navigate(prepared.url.href, {
            info: HANDOFF,
            history: event.navigationType === 'push' ? 'push' : 'replace',
          });
        }
      };

      const show = async (
        prepared: Prepared & { kind: 'render' | 'failed' },
      ) => {
        const committed = accept(attempt, prepared);
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
      event.intercept({
        ...behavior,
        handler: async () => {
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
            // This entry now redirects. Replace it with a navigation that
            // shows the response already loaded.
            const { route: redirected, patch } = result;
            startTransition(() => {
              void changeRoute(redirected, {
                adopt: Promise.resolve(patch),
                shouldScroll: options.shouldScroll,
                history: 'replace',
                url: result.url,
              }).catch(() => {});
            });
            return;
          }
          await show(result);
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
  }, [accept, changeRoute, prepare, setFrame, startAttempt, takeUrl]);

  return {
    route,
    changeRoute,
    getElements,
    getRouteState,
    isCurrentRoute,
  };
}
