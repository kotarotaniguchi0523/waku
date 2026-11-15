import { parseRoute } from '../client-core-utils/route-url.js';
import type { RouteProps } from '../isomorphic-utils/route-path.js';
import type { Attempt, Attempts } from './attempts.js';
import { isLeftToBrowser } from './browser-owned.js';
import type { Outcome, Shown } from './frame.js';
import { handOff } from './handoff.js';
import { startPreview } from './instant-preview.js';
import { abortError, ignoreRejection, isAbortError } from './promises.js';
import { RequestInfo, fetched, toRequest } from './request.js';
import type { Committed, Source } from './request.js';
import { resolve } from './resolve.js';
import type { ChangeRoute, ChangeRouteOptions } from './router-context.js';
import {
  scrollToHashWhenRendered,
  shouldScrollForRouteChange,
} from './scroll.js';
import { acceptReturn, guardTraversal } from './traversal-guard.js';

const quiet = { scroll: 'manual', focusReset: 'manual' } as const;

const runNow = (update: () => void) => update();

// A dropped update is expected. Anything else would otherwise disappear
// without a trace.
export const reportUnlessAborted = (error: unknown) => {
  if (!isAbortError(error)) {
    console.error('Error while applying a route update:', error);
  }
};

/** What the listener needs from the binding. */
export type Binding = {
  /** What the last commit showed. */
  at: () => Committed;
  attempts: Attempts;
  start: (route: RouteProps) => Attempt;
  /** Queues the frame for a result; settles when React has committed it. */
  show: (
    attempt: Attempt,
    result: Shown,
    schedule?: (update: () => void) => void,
  ) => Promise<void>;
  /** Asks the browser for a navigation with a known source. */
  navigate: (
    route: RouteProps,
    options: ChangeRouteOptions,
    url: URL,
    source: Source,
  ) => Promise<void>;
  changeRoute: ChangeRoute;
};

/**
 * What happens on a `navigate` event: decide whether the router takes it,
 * resolve the destination once, and show the result. Push and replace wait
 * for the result before the URL moves; Back, Forward and reload after.
 */
export function createNavigateListener({
  at,
  attempts,
  start,
  show,
  navigate,
  changeRoute,
}: Binding) {
  return (event: NavigateEvent) => {
    const info = event.info instanceof RequestInfo ? event.info : undefined;
    if (isLeftToBrowser(event, !!info) || acceptReturn(event)) {
      return;
    }
    if (event.hashChange) {
      // The browser scrolls to the fragment unless the caller opted out;
      // `currententrychange` below records the new hash.
      if (info && !info.options.shouldScroll) {
        event.intercept(quiet);
      }
      info?.settle.resolve();
      return;
    }
    const push = event.navigationType === 'push';
    const replace = event.navigationType === 'replace';
    const url = new URL(event.destination.url);
    const route = info?.route ?? parseRoute(url);
    const showInstead = (decided: RouteProps) => {
      ignoreRejection(
        changeRoute(decided, {
          shouldScroll: shouldScrollForRouteChange(decided, at().route),
          history: 'replace',
        }).catch(reportUnlessAborted),
      );
    };
    if (guardTraversal(event, route, at().interceptor, showInstead)) {
      return;
    }
    const options: ChangeRouteOptions = info?.options ?? {
      // Back and Forward between entries that differ only in the query stay
      // where the page is, like a query-only push.
      shouldScroll:
        event.navigationType !== 'traverse' ||
        shouldScrollForRouteChange(route, at().route),
      history: replace ? 'replace' : 'push',
    };

    const attempt = start(route);
    event.signal.addEventListener('abort', () => {
      // Once the URL has moved, only a later URL-taking navigation drops it.
      if (attempts.isLoading(attempt)) {
        attempt.abort();
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

    // Push and replace wait for the result before the URL moves, so the
    // address bar and the content change together and a redirect leaves no
    // entry of its own. Back, Forward and reload have already moved.
    const waitsBeforeCommit = event.cancelable && (push || replace);
    const source = info?.source ?? fetched;
    const request = toRequest(route, url, options, source);
    // With the destination's shell at hand, an instant navigation moves at
    // once, shows the shell, and lets the response fill in the rest.
    const instant =
      options.instant && waitsBeforeCommit && source.kind === 'fetch'
        ? startPreview(request, at(), at().cache, attempt.signal)
        : undefined;
    // The result is resolved once; both handlers below wait for it.
    const outcome =
      source.kind === 'resolved'
        ? Promise.resolve(source.outcome)
        : resolve(
            instant ? { ...request, adopt: instant.response } : request,
            at(),
            at().cache,
            attempt.signal,
          );
    ignoreRejection(outcome);
    let committedUrl = event.destination.url;

    // Shows a result and reports it to the caller of `push()` / `replace()`.
    const present = async (
      result: Shown,
      schedule?: (update: () => void) => void,
    ) => {
      const committed = show(attempt, result, schedule);
      // The frame is queued and the URL has moved: the caller can go on.
      if (result.kind === 'failed') {
        fail(result.error);
      } else {
        info?.settle.resolve();
      }
      // Read while this navigation is still the browser's current one.
      const transition = event.signal.aborted
        ? undefined
        : window.navigation.transition;
      await committed;
      if (
        result.kind !== 'failed' &&
        options.shouldScroll &&
        (push || replace)
      ) {
        // After the browser's own scroll, which a late target missed.
        transition?.finished.then(
          () => scrollToHashWhenRendered(at().route.hash),
          () => {},
        );
      }
    };

    // After the URL has moved: leave, replace the entry, or show.
    const finish = async (display: (result: Shown) => Promise<void> | void) => {
      const result = await outcome;
      if (result.kind === 'leave' || result.kind === 'reload') {
        handOff(result, push);
      } else if (result.kind === 'render' && result.url.href !== committedUrl) {
        // The response names another route than this entry asked for.
        // Replace the entry with a navigation that shows that response.
        ignoreRejection(
          navigate(
            result.route,
            { shouldScroll: options.shouldScroll, history: 'replace' },
            result.url,
            {
              kind: 'resolved',
              // Slots are compared with what is shown now, which an instant
              // preview has changed since the request started.
              outcome:
                result.source.kind === 'response'
                  ? {
                      ...result,
                      source: { ...result.source, base: at().elements },
                    }
                  : result,
            },
          ),
        );
      } else {
        await display(result);
      }
    };

    event.intercept({
      ...(options.shouldScroll ? {} : quiet),
      ...(waitsBeforeCommit && !instant
        ? {
            precommitHandler: async (controller) => {
              let result: Outcome;
              try {
                result = await outcome;
              } catch (e) {
                fail(e);
                throw e;
              }
              if (result.kind === 'leave' || result.kind === 'reload') {
                // Cancel this navigation first. A document navigation
                // started while it is still being cancelled can be
                // cancelled with it.
                setTimeout(() => handOff(result, push));
                throw abortError();
              }
              if (result.url.href !== committedUrl) {
                controller.redirect(result.url.href);
                committedUrl = result.url.href;
              }
            },
          }
        : {}),
      handler: async () => {
        attempts.own(attempt);
        if (instant) {
          const previewed = present(instant.preview, runNow);
          finish((result) => ignoreRejection(show(attempt, result))).catch(
            (e) => {
              if (!attempt.signal.aborted) {
                fail(e);
              }
            },
          );
          await previewed;
          return;
        }
        try {
          await finish(present);
        } catch (e) {
          fail(e);
          throw e;
        }
      },
    });
  };
}
