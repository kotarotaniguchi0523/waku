/** @vitest-environment happy-dom */
import { describe, expect, test } from 'vitest';
import { originOf } from '../src/router/client-utils/frame.js';
import type { Outcome } from '../src/router/client-utils/frame.js';
import { nextStep } from '../src/router/client-utils/navigate-listener.js';

const route = (path: string) => ({ path, query: '', hash: '' });
const urlOf = (path: string) => new URL(path, 'http://localhost');

const rendered = (path: string): Outcome => ({
  kind: 'render',
  route: route(path),
  url: urlOf(path),
  origin: originOf(route(path), urlOf(path), 0, true),
  patch: {},
  source: { kind: 'known' },
});

const failed = (path: string): Outcome => ({
  kind: 'failed',
  route: route(path),
  url: urlOf(path),
  origin: originOf(route(path), urlOf(path), 0, true),
  error: new Error('no'),
});

describe('nextStep', () => {
  test('a result for the URL of the entry is shown', () => {
    expect(nextStep(rendered('/a'), 'http://localhost/a').kind).toBe('show');
  });

  test('a result for another URL moves the entry there', () => {
    const step = nextStep(rendered('/b'), 'http://localhost/a');
    expect(step.kind).toBe('move');
    expect(step.kind === 'move' && step.outcome.url.pathname).toBe('/b');
  });

  test('a failure is shown where the navigation is', () => {
    expect(nextStep(failed('/b'), 'http://localhost/a').kind).toBe('show');
  });

  test('a destination outside the app is handed to the browser', () => {
    const leave: Outcome = {
      kind: 'leave',
      location: new URL('https://other.example/'),
    };
    expect(nextStep(leave, 'http://localhost/a').kind).toBe('handOff');
  });

  test('an out-of-date client hands the requested URL to the browser', () => {
    const reload: Outcome = { kind: 'reload', url: urlOf('/a') };
    expect(nextStep(reload, 'http://localhost/a').kind).toBe('handOff');
  });
});
