import {
  unstable_combineElements as combineElements,
  unstable_formatRscUrl as formatRscUrl,
} from 'waku/minimal/client';
import type { Unstable_RscEnhancer } from 'waku/minimal/client';
import { getRouteUrl } from '../client-core-utils/route-url.js';
import type { RouteProps } from '../isomorphic-utils/route-path.js';
import {
  ROUTE_ID,
  encodeRoutePath,
  getRouteFromElements,
  isStaticFromElements,
} from '../isomorphic-utils/router-protocol.js';
import type { RouteData } from '../isomorphic-utils/router-protocol.js';

export const serverRedirectEnhancer: Unstable_RscEnhancer =
  (next) => async (rscPath, rscParams, options) => {
    if (options.type !== 'rsc') {
      return next(rscPath, rscParams, options);
    }
    let redirectedUrl: URL | undefined;
    const result = await next(rscPath, rscParams, {
      ...options,
      fetch: async (input, init) => {
        const response = await options.fetch(input, init);
        redirectedUrl = response.redirected ? new URL(response.url) : undefined;
        return response;
      },
    });
    const route = getRouteFromElements(result.elements);
    if (!redirectedUrl || !route || !isStaticFromElements(result.elements)) {
      return result;
    }
    if (
      redirectedUrl.pathname !==
      formatRscUrl(encodeRoutePath(route.path), redirectedUrl).pathname
    ) {
      return result;
    }
    return {
      ...result,
      elements: combineElements(result.elements, {
        [ROUTE_ID]: [
          route.path,
          redirectedUrl.searchParams.get('query') ?? '',
        ] satisfies RouteData,
      }),
    };
  };

export type RouterState = {
  readonly url: string; // pathname + search + hash, with the base path
  readonly requested: readonly [path: string, query: string];
  readonly history: 'push' | 'replace' | null;
  readonly scroll: { readonly pathChanged: boolean } | null;
  readonly follows: number;
};

export function createRouterState(
  route: RouteProps,
  url: URL,
  options: {
    history: 'push' | 'replace' | null;
    scroll: boolean;
    pathChanged: boolean;
    follows: number;
  },
): RouterState {
  return {
    url: url.pathname + url.search + url.hash,
    requested: [route.path, route.query],
    history: options.history,
    scroll: options.scroll ? { pathChanged: options.pathChanged } : null,
    follows: options.follows,
  };
}

export function resolveServerRedirect(
  elements: Record<string | symbol, unknown>,
  routerState: RouterState,
  fallbackPath: string,
): { route: RouteProps; url: URL } {
  const stateUrl = new URL(routerState.url, window.location.href);
  const serverRoute = getRouteFromElements(elements);
  const redirect =
    serverRoute &&
    (serverRoute.path !== routerState.requested[0] ||
      (!isStaticFromElements(elements) &&
        serverRoute.query !== routerState.requested[1]))
      ? serverRoute
      : undefined;
  if (redirect && redirect.path !== '/404') {
    return { route: redirect, url: getRouteUrl(redirect) };
  }
  return {
    route: {
      path: redirect?.path ?? serverRoute?.path ?? fallbackPath,
      query: stateUrl.searchParams.toString(),
      hash: stateUrl.hash,
    },
    url: stateUrl,
  };
}
