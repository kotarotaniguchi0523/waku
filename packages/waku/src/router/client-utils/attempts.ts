import type { RouteProps } from '../isomorphic-utils/route-path.js';

/** The abort reason of a navigation that another one took the place of. */
export const SUPERSEDED = Symbol('superseded');

/** One navigation, from its start until its content is shown or dropped. */
export type Attempt = {
  /** Also the `navigation` number of the frames it shows. */
  readonly id: number;
  /** Aborts when the navigation is dropped; the reason says why. */
  readonly signal: AbortSignal;
  /** Drops the navigation for `reason`. */
  readonly abort: (reason: unknown) => void;
  /** The route asked for. */
  readonly target: RouteProps;
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
  let owner: { attempt: Attempt; queued: RouteProps | undefined } | undefined;

  return {
    /** Starts a navigation that has not moved the URL yet. */
    start(target: RouteProps): Attempt {
      const controller = new AbortController();
      const attempt: Attempt = {
        id: ++nextId,
        signal: controller.signal,
        abort: (reason) => controller.abort(reason),
        target,
      };
      controller.signal.addEventListener('abort', () => {
        if (loading === attempt) {
          loading = undefined;
        }
        if (owner?.attempt === attempt) {
          owner = undefined;
        }
      });
      loading?.abort(SUPERSEDED);
      loading = attempt;
      return attempt;
    },
    /**
     * The URL now belongs to `attempt`; older navigations give way. `reason`
     * is why the navigation that had the URL is dropped.
     */
    own(attempt: Attempt, reason: unknown = SUPERSEDED) {
      if (loading && loading.id <= attempt.id) {
        const older = loading;
        loading = undefined;
        if (older !== attempt) {
          older.abort(SUPERSEDED);
        }
      }
      if (owner?.attempt !== attempt) {
        owner?.attempt.abort(reason);
        owner = attempt.signal.aborted
          ? undefined
          : { attempt, queued: undefined };
      }
    },
    /** `attempt` has queued a frame that shows `route`. */
    queue(attempt: Attempt, route: RouteProps) {
      if (owner?.attempt === attempt) {
        owner.queued = route;
      }
    },
    /** Navigation `id` is fully shown; nothing can drop it any more. */
    release(id: number) {
      if (owner?.attempt.id === id) {
        owner = undefined;
      }
    },
    /** The navigation whose content has not reached the screen at all. */
    pending(shownNavigation: number): Attempt | undefined {
      return (
        loading ??
        (owner?.attempt.id === shownNavigation ? undefined : owner?.attempt)
      );
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
    dropLoading(reason: unknown) {
      loading?.abort(reason);
    },
    dropAll(reason: unknown) {
      loading?.abort(reason);
      owner?.attempt.abort(reason);
    },
  };
}

export type Attempts = ReturnType<typeof createAttempts>;
