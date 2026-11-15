/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { FetchRsc } from '../src/router/client-core-utils/caches.js';
import { getRouterCacheForTest } from '../src/router/client-core-utils/caches.js';
import { fetched, resolve } from '../src/router/client-utils/resolve.js';
import type { Request } from '../src/router/client-utils/resolve.js';
import {
  INTENT_ID,
  IS_STATIC_ID,
  ROUTE_ID,
  encodeRoutePath,
  getRouteSlotId,
} from '../src/router/isomorphic-utils/router-protocol.js';

type Elements = Record<string, unknown>;

const route = (path: string, query = '', hash = '') => ({ path, query, hash });
const urlOf = (path: string) => new URL(path, window.location.origin);

// The server: answers each route path with the elements it would render.
const serve = (pages: Record<string, Elements | Error>) => {
  const fetchRsc = vi.fn<FetchRsc>(async (rscPath) => {
    for (const [path, page] of Object.entries(pages)) {
      if (encodeRoutePath(path) === rscPath) {
        if (page instanceof Error) {
          throw page;
        }
        return page;
      }
    }
    throw new Error('unexpected request: ' + rscPath);
  });
  return { fetchRsc, cache: getRouterCacheForTest(fetchRsc) };
};

const page = (path: string, extra: Elements = {}): Elements => ({
  [ROUTE_ID]: [path, ''],
  [getRouteSlotId(path)]: path,
  ...extra,
});

const request = (path: string, more: Partial<Request> = {}): Request => ({
  route: route(path),
  url: urlOf(path),
  scroll: true,
  refetch: undefined,
  source: fetched,
  ...more,
});

const shown = (path: string, elements: Elements = page(path)) => ({
  route: route(path),
  elements,
  has404: false,
});

const live = () => new AbortController().signal;

beforeEach(() => {
  vi.stubEnv('WAKU_CONFIG_BASE_PATH', '/');
});

describe('resolve', () => {
  test('another route is fetched and shown at the requested URL', async () => {
    const { cache } = serve({ '/a': page('/a') });
    const outcome = await resolve(request('/a'), shown('/'), cache, live());
    expect(outcome).toMatchObject({
      kind: 'render',
      route: route('/a'),
      origin: { url: '/a', requested: ['/a', ''], follows: 0, scroll: true },
      source: { kind: 'response' },
    });
    expect(outcome.kind === 'render' && outcome.patch).toEqual(page('/a'));
  });

  test('the route already shown is not fetched again', async () => {
    const { cache, fetchRsc } = serve({});
    const outcome = await resolve(request('/'), shown('/'), cache, live());
    expect(fetchRsc).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      kind: 'render',
      route: route('/'),
      source: { kind: 'known' },
    });
  });

  test('a refetch of the route already shown asks the server', async () => {
    const { cache, fetchRsc } = serve({ '/': page('/', { fresh: true }) });
    const outcome = await resolve(
      request('/', { refetch: true }),
      shown('/'),
      cache,
      live(),
    );
    expect(fetchRsc).toHaveBeenCalledTimes(1);
    expect(outcome.kind === 'render' && outcome.patch).toMatchObject({
      fresh: true,
    });
  });

  test('a static route whose content is already held is not fetched', async () => {
    const { cache, fetchRsc } = serve({});
    cache.learnStaticFromElements(page('/s', { [IS_STATIC_ID]: true }));
    const outcome = await resolve(
      request('/s'),
      shown('/', { ...page('/'), [getRouteSlotId('/s')]: 'held' }),
      cache,
      live(),
    );
    expect(fetchRsc).not.toHaveBeenCalled();
    expect(outcome.kind === 'render' && outcome.patch).toMatchObject({
      [ROUTE_ID]: ['/s', ''],
      [IS_STATIC_ID]: true,
    });
    cache.clearCaches();
  });

  test('a response for another route moves the route and the URL', async () => {
    const { cache } = serve({ '/old': page('/new') });
    const outcome = await resolve(request('/old'), shown('/'), cache, live());
    expect(outcome).toMatchObject({ kind: 'render', route: route('/new') });
    expect(outcome.kind === 'render' && outcome.url.pathname).toBe('/new');
  });

  test('a response already on its way is used in place of a fetch', async () => {
    const { cache, fetchRsc } = serve({});
    const outcome = await resolve(
      request('/a', {
        source: {
          kind: 'response',
          response: Promise.resolve(page('/a')),
          follows: 1,
        },
      }),
      shown('/'),
      cache,
      live(),
    );
    expect(fetchRsc).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      kind: 'render',
      route: route('/a'),
      origin: { follows: 1 },
    });
  });

  test('the follows already made are carried into the result', async () => {
    const { cache } = serve({ '/a': page('/a') });
    const outcome = await resolve(
      request('/a', { source: { kind: 'fetch', follows: 2 } }),
      shown('/'),
      cache,
      live(),
    );
    expect(outcome).toMatchObject({ kind: 'render', origin: { follows: 2 } });
  });

  test('a redirect to another origin becomes a leave outcome', async () => {
    const { cache } = serve({
      '/out': page('/out', {
        [INTENT_ID]: Promise.resolve(
          JSON.stringify({ location: 'https://other.example/x', status: 307 }),
        ),
      }),
    });
    const outcome = await resolve(request('/out'), shown('/'), cache, live());
    expect(outcome.kind).toBe('leave');
    expect(outcome.kind === 'leave' && outcome.location.href).toBe(
      'https://other.example/x',
    );
  });

  test('a failed request becomes a failed outcome for the requested route', async () => {
    const error = new Error('down');
    const { cache } = serve({ '/a': error });
    const outcome = await resolve(request('/a'), shown('/'), cache, live());
    expect(outcome).toMatchObject({
      kind: 'failed',
      route: route('/a'),
      error,
      origin: { url: '/a' },
    });
  });

  test('a navigation dropped while its request is out rejects as aborted', async () => {
    const fetchRsc = vi.fn<FetchRsc>(() => new Promise(() => {}));
    const cache = getRouterCacheForTest(fetchRsc);
    const controller = new AbortController();
    const outcome = resolve(
      request('/a'),
      shown('/'),
      cache,
      controller.signal,
    );
    controller.abort();
    await expect(outcome).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('the request is cancelled when the navigation is dropped before the response', async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchRsc = vi.fn<FetchRsc>((_path, _params, options) => {
      requestSignal = options?.signal;
      return new Promise(() => {});
    });
    const cache = getRouterCacheForTest(fetchRsc);
    const controller = new AbortController();
    const outcome = resolve(
      request('/a'),
      shown('/'),
      cache,
      controller.signal,
    );
    outcome.catch(() => {});
    await Promise.resolve();
    controller.abort();
    expect(requestSignal?.aborted).toBe(true);
  });

  test('the request is left running when the navigation is dropped after the response', async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchRsc = vi.fn<FetchRsc>(async (_path, _params, options) => {
      requestSignal = options?.signal;
      return page('/a');
    });
    const cache = getRouterCacheForTest(fetchRsc);
    const controller = new AbortController();
    await resolve(request('/a'), shown('/'), cache, controller.signal);
    controller.abort();
    expect(requestSignal?.aborted).toBe(false);
  });
});
