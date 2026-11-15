import { describe, expect, test } from 'vitest';
import {
  errorOf,
  failedHere,
  initialFrame,
  nextFrame,
  originOf,
  routeOf,
  withFragment,
  withRerender,
} from '../src/router/client-utils/frame.js';
import type {
  Elements,
  Outcome,
  RenderFrame,
} from '../src/router/client-utils/frame.js';
import {
  INTENT_ID,
  ROUTE_ID,
  getRouteSlotId,
} from '../src/router/isomorphic-utils/router-protocol.js';

const route = (path: string, query = '', hash = '') => ({ path, query, hash });
const urlOf = (path: string) => new URL(path, 'http://localhost');
const home = route('/');

const start = (elements: Elements = { [getRouteSlotId('/')]: 'home' }) =>
  initialFrame(Promise.resolve(elements));

const at = (navigation: number, settled = home) => ({
  navigation,
  settled,
  entryUrl: undefined,
  committed: () => {},
});

const known = (
  path: string,
  patch: Elements = {},
): Outcome & { kind: 'render' } => ({
  kind: 'render',
  route: route(path),
  url: urlOf(path),
  origin: originOf(route(path), urlOf(path), 0, true),
  patch: { [ROUTE_ID]: [path, ''], ...patch },
  source: { kind: 'known' },
});

const response = (
  path: string,
  patch: Elements,
  base: Elements,
): Outcome & { kind: 'render' } => ({
  ...known(path, patch),
  source: { kind: 'response', route: route(path), base },
});

const preview = (
  path: string,
  shell: Elements,
): Outcome & { kind: 'preview' } => ({
  kind: 'preview',
  route: route(path),
  url: urlOf(path),
  origin: originOf(route(path), urlOf(path), 0, true),
  merge: (current) => ({ ...current, ...shell }),
});

const failed = (
  path: string,
  error: unknown,
): Outcome & { kind: 'failed' } => ({
  kind: 'failed',
  route: route(path),
  url: urlOf(path),
  origin: originOf(route(path), urlOf(path), 0, true),
  error,
});

describe('the initial frame', () => {
  test('shows the route of the document and no error', () => {
    const frame = start();
    expect(routeOf(frame, home)).toBe(home);
    expect(errorOf(frame)).toBeUndefined();
    expect(frame.scope).toEqual({ navigation: 0, fragment: 0 });
  });
});

describe('nextFrame', () => {
  test('a result shows its route and adds its elements to those on screen', async () => {
    const frame = nextFrame(
      start(),
      known('/a', { [getRouteSlotId('/a')]: 'A' }),
      at(1),
    );
    expect(frame.kind).toBe('ready');
    expect(routeOf(frame, home)).toEqual(route('/a'));
    expect(frame.scope.navigation).toBe(1);
    expect(await frame.elements).toMatchObject({
      [getRouteSlotId('/')]: 'home',
      [getRouteSlotId('/a')]: 'A',
      [ROUTE_ID]: ['/a', ''],
    });
  });

  test('the route takes the fragment of the current entry when it is the same page', () => {
    const frame = nextFrame(start(), known('/a'), {
      ...at(1),
      entryUrl: 'http://localhost/a#later',
    });
    expect(routeOf(frame, home).hash).toBe('#later');
  });

  test('a fragment on another page is not taken', () => {
    const frame = nextFrame(start(), known('/a'), {
      ...at(1),
      entryUrl: 'http://localhost/b#later',
    });
    expect(routeOf(frame, home).hash).toBe('');
  });

  test('a value a server function changed while the response was loading is kept', async () => {
    const base = { shared: 'old', [getRouteSlotId('/')]: 'home' };
    const shown = initialFrame(
      Promise.resolve({ ...base, shared: 'from action' }),
    );
    const frame = nextFrame(
      shown,
      response(
        '/a',
        { shared: 'from response', [getRouteSlotId('/a')]: 'A' },
        base,
      ),
      at(1),
    );
    expect(await frame.elements).toMatchObject({
      shared: 'from action',
      [getRouteSlotId('/a')]: 'A',
    });
  });

  test('an unchanged value is replaced by the response', async () => {
    const base = { shared: 'old' };
    const frame = nextFrame(
      initialFrame(Promise.resolve(base)),
      response('/a', { shared: 'from response' }, base),
      at(1),
    );
    expect(await frame.elements).toMatchObject({ shared: 'from response' });
  });

  test('a failure keeps the elements and carries the error', async () => {
    const error = new Error('no');
    const before = start();
    const frame = nextFrame(before, failed('/a', error), at(1));
    expect(errorOf(frame)?.error).toBe(error);
    expect(frame.elements).toBe(before.elements);
    expect(routeOf(frame, home)).toEqual(route('/a'));
  });

  test('a result after a failure shows no error', () => {
    const broken = nextFrame(start(), failed('/a', new Error('no')), at(1));
    expect(errorOf(nextFrame(broken, known('/b'), at(2)))).toBeUndefined();
  });

  test('the response of an instant navigation adds only what its preview left out', async () => {
    const slot = getRouteSlotId('/a');
    const shown = nextFrame(start(), preview('/a', { [slot]: 'shell' }), at(1));
    expect(shown.kind).toBe('preview');
    const filled = nextFrame(
      shown,
      known('/a', { [slot]: 'from response', extra: 'new', [INTENT_ID]: null }),
      at(1),
    );
    expect(filled.kind).toBe('ready');
    expect(await filled.elements).toMatchObject({
      [slot]: 'shell',
      extra: 'new',
      [INTENT_ID]: null,
    });
  });

  test('a result of another navigation replaces what a preview showed', async () => {
    const slot = getRouteSlotId('/a');
    const shown = nextFrame(start(), preview('/a', { [slot]: 'shell' }), at(1));
    const next = nextFrame(shown, known('/a', { [slot]: 'fresh' }), at(2));
    expect(await next.elements).toMatchObject({ [slot]: 'fresh' });
  });
});

describe('withFragment', () => {
  const initial = { route: home, url: urlOf('/') };

  test('records a new fragment on the initial page', () => {
    const before = start();
    const frame = withFragment(before, initial, urlOf('/#top'));
    expect(routeOf(frame, home)).toEqual(route('/', '', '#top'));
    expect(frame.elements).toBe(before.elements);
    expect(frame.scope).toEqual({ navigation: 0, fragment: 1 });
  });

  test('keeps the navigation and the requested route of a shown page', () => {
    const shown = nextFrame(start(), known('/a'), at(1));
    const frame = withFragment(shown, initial, urlOf('/a#x'));
    expect(frame.scope).toEqual({ navigation: 1, fragment: 1 });
    expect(frame.kind === 'ready' && frame.origin).toMatchObject({
      url: '/a#x',
      requested: ['/a', ''],
    });
  });

  test('changes nothing for the same fragment or another page', () => {
    const shown = nextFrame(start(), known('/a'), at(1));
    expect(withFragment(shown, initial, urlOf('/a'))).toBe(shown);
    expect(withFragment(shown, initial, urlOf('/b#x'))).toBe(shown);
  });

  test('leaves a failed frame alone', () => {
    const broken = nextFrame(start(), failed('/a', new Error('no')), at(1));
    expect(withFragment(broken, initial, urlOf('/a#x'))).toBe(broken);
  });
});

describe('failedHere', () => {
  test('shows the error over the displayed route without a new navigation', () => {
    const shown = nextFrame(start(), known('/a'), at(1));
    const error = new Error('other origin');
    const frame = failedHere(shown, home, urlOf('/a'), error);
    expect(errorOf(frame)?.error).toBe(error);
    expect(routeOf(frame, home)).toEqual(route('/a'));
    expect(frame.scope).toBe(shown.scope);
  });
});

describe('withRerender', () => {
  const slot = getRouteSlotId('/');
  const rerender = { [slot]: 'updated', [ROUTE_ID]: ['/', ''] };

  test('a frame that shows the route takes the whole rerender', async () => {
    const frame = withRerender(start(), home, home, rerender);
    expect(await frame.elements).toMatchObject(rerender);
  });

  test('a frame queued for another route keeps its route and takes the content', async () => {
    const queued: RenderFrame = nextFrame(start(), known('/a'), at(1));
    const frame = withRerender(queued, home, home, rerender);
    expect(routeOf(frame, home)).toEqual(route('/a'));
    expect(await frame.elements).toMatchObject({
      [slot]: 'updated',
      [ROUTE_ID]: ['/a', ''],
    });
  });

  test('a failed frame is left alone', () => {
    const broken = nextFrame(start(), failed('/a', new Error('no')), at(1));
    expect(withRerender(broken, home, home, rerender)).toBe(broken);
  });
});
