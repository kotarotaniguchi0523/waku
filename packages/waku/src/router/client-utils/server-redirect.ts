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

/**
 * The route and URL a response is shown at. The response names the route the
 * server rendered, which differs from the requested one after a redirect and
 * for a custom 404, which keeps the requested URL.
 */
export function resolveServerRedirect(
  elements: Record<string | symbol, unknown>,
  requested: { route: Pick<RouteProps, 'path' | 'query'>; url: URL },
  fallbackPath: string,
): { route: RouteProps; url: URL } {
  const serverRoute = getRouteFromElements(elements);
  const redirect =
    serverRoute &&
    (serverRoute.path !== requested.route.path ||
      (!isStaticFromElements(elements) &&
        serverRoute.query !== requested.route.query))
      ? serverRoute
      : undefined;
  if (redirect && redirect.path !== '/404') {
    return { route: redirect, url: getRouteUrl(redirect) };
  }
  return {
    route: {
      path: redirect?.path ?? serverRoute?.path ?? fallbackPath,
      query: requested.url.searchParams.toString(),
      hash: requested.url.hash,
    },
    url: requested.url,
  };
}
