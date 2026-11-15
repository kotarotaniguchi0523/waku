import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useRegisterRscReloadListener_UNSTABLE as useRegisterRscReloadListener } from 'waku/minimal/client';
import { useRouterCache } from '../client-core-utils/caches.js';
import { useHmrRefetch } from '../client-core-utils/hmr.js';
import { useInitialRoute } from '../client-core-utils/initial-route.js';
import type { ServerFunctionRouting } from '../client-core-utils/server-function-routing.js';
import { useServerFunctionRouting } from '../client-core-utils/server-function-routing.js';
import type { RouteProps } from '../isomorphic-utils/route-path.js';
import { has404FromElements } from '../isomorphic-utils/router-protocol.js';
import { routeOf } from './frame.js';
import type { Elements, RenderFrame } from './frame.js';
import { createNavigation } from './navigation.js';
import type { Committed, Interceptor } from './request.js';

/**
 * Creates the navigation binding for one Router and tells it what each
 * commit showed. All the logic is in `navigation.ts`.
 */
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
