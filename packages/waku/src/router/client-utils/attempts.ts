import type { RouteProps } from '../isomorphic-utils/route-path.js';

/** One navigation, from its start until its content is shown or dropped. */
export type Attempt = {
  /** Also the `navigation` number of the frames it shows. */
  readonly id: number;
  readonly signal: AbortSignal;
  readonly abort: () => void;
  /** The route asked for. */
  readonly target: RouteProps;
  /** The route of the frame it has queued, once it has one. */
  queued: RouteProps | undefined;
};

/**
 * Keeps the navigations that can still change what is shown. There are at
 * most two:
 * - `loading` has not moved the URL. A newer navigation cancels it.
 * - `owner` has moved the URL and its content is not fully shown yet. Only a
 *   navigation that moves the URL after it replaces it, so the content
 *   always catches up with the address bar.
 */
export function createAttempts() {
  let nextId = 0;
  let loading: Attempt | undefined;
  let owner: Attempt | undefined;

  return {
    /** Starts a navigation that has not moved the URL yet. */
    start(target: RouteProps): Attempt {
      const controller = new AbortController();
      const attempt: Attempt = {
        id: ++nextId,
        signal: controller.signal,
        abort: () => controller.abort(),
        target,
        queued: undefined,
      };
      controller.signal.addEventListener('abort', () => {
        if (loading === attempt) {
          loading = undefined;
        }
        if (owner === attempt) {
          owner = undefined;
        }
      });
      loading?.abort();
      loading = attempt;
      return attempt;
    },
    /** The URL now belongs to `attempt`; older navigations give way. */
    own(attempt: Attempt) {
      if (loading && loading.id <= attempt.id) {
        const older = loading;
        loading = undefined;
        if (older !== attempt) {
          older.abort();
        }
      }
      if (owner !== attempt) {
        owner?.abort();
      }
      if (!attempt.signal.aborted) {
        owner = attempt;
      }
    },
    /** React committed a frame of navigation `id`. */
    committed(id: number, final: boolean) {
      if (final && owner?.id === id) {
        owner = undefined;
      }
    },
    /** The navigation whose content has not reached the screen at all. */
    pending(shownNavigation: number): Attempt | undefined {
      return loading ?? (owner?.id === shownNavigation ? undefined : owner);
    },
    /** Whether `attempt` is still waiting to move the URL. */
    isLoading(attempt: Attempt) {
      return loading === attempt;
    },
    /** The route of the frame waiting to be shown, if one is queued. */
    queuedRoute(): RouteProps | undefined {
      return owner?.queued;
    },
    /** Drops the navigation still waiting to move the URL. */
    dropLoading() {
      loading?.abort();
    },
    dropAll() {
      loading?.abort();
      owner?.abort();
    },
  };
}

export type Attempts = ReturnType<typeof createAttempts>;
