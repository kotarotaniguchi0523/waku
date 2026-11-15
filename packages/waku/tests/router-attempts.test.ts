import { describe, expect, test } from 'vitest';
import { createAttempts } from '../src/router/client-utils/attempts.js';

const route = (path: string) => ({ path, query: '', hash: '' });

describe('attempts', () => {
  test('a navigation that has not moved the URL is dropped by the next one', () => {
    const attempts = createAttempts();
    const first = attempts.start(route('/a'));
    const second = attempts.start(route('/b'));
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(attempts.pending(0)).toBe(second);
  });

  test('a navigation that moved the URL outlives one that is only loading', () => {
    const attempts = createAttempts();
    const first = attempts.start(route('/a'));
    attempts.own(first);
    const second = attempts.start(route('/b'));
    expect(first.signal.aborted).toBe(false);
    second.abort();
    expect(first.signal.aborted).toBe(false);
    expect(attempts.pending(0)).toBe(first);
  });

  test('the next navigation to move the URL replaces the one before', () => {
    const attempts = createAttempts();
    const first = attempts.start(route('/a'));
    attempts.own(first);
    const second = attempts.start(route('/b'));
    attempts.own(second);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });

  test('a navigation whose content is shown is not dropped by later ones', () => {
    const attempts = createAttempts();
    const first = attempts.start(route('/a'));
    attempts.own(first);
    attempts.committed(first.id, true);
    expect(attempts.pending(first.id)).toBeUndefined();
    attempts.own(attempts.start(route('/b')));
    expect(first.signal.aborted).toBe(false);
  });

  test('a shown preview is no longer pending but can still be replaced', () => {
    const attempts = createAttempts();
    const first = attempts.start(route('/a'));
    attempts.own(first);
    attempts.committed(first.id, false);
    expect(attempts.pending(first.id)).toBeUndefined();
    attempts.own(attempts.start(route('/b')));
    expect(first.signal.aborted).toBe(true);
  });

  test('an update that moves the URL at once drops an older loading navigation', () => {
    const attempts = createAttempts();
    const loading = attempts.start(route('/a'));
    const inPlace = attempts.start(route('/'));
    attempts.own(inPlace);
    expect(loading.signal.aborted).toBe(true);
    expect(attempts.isLoading(inPlace)).toBe(false);
  });

  test('dropping the loading navigation leaves the owner', () => {
    const attempts = createAttempts();
    const owner = attempts.start(route('/a'));
    attempts.own(owner);
    const loading = attempts.start(route('/b'));
    attempts.dropLoading();
    expect(loading.signal.aborted).toBe(true);
    expect(owner.signal.aborted).toBe(false);
    attempts.dropAll();
    expect(owner.signal.aborted).toBe(true);
  });

  test('the queued route is that of the navigation that moved the URL', () => {
    const attempts = createAttempts();
    const owner = attempts.start(route('/a'));
    attempts.own(owner);
    expect(attempts.queuedRoute()).toBeUndefined();
    owner.queued = route('/a');
    expect(attempts.queuedRoute()).toEqual(route('/a'));
  });
});
