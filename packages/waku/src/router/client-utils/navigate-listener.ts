import type { RouterCache } from '../client-core-utils/caches.js';
import { getRouteUrl, parseRoute } from '../client-core-utils/route-url.js';
import type { RouteProps } from '../isomorphic-utils/route-path.js';
import { SUPERSEDED } from './attempts.js';
import type { Attempt, Attempts } from './attempts.js';
import { isLeftToBrowser } from './browser-owned.js';
import type { Outcome, Shown } from './frame.js';
import { handOff } from './handoff.js';
import { startPreview } from './instant-preview.js';
import { abortError, ignoreRejection, ignoreResult } from './promises.js';
import { fetched, resolve } from './resolve.js';
import type { Displayed, Request, Source } from './resolve.js';
import type { ChangeRouteOptions } from './router-context.js';
import {
  scrollToHashWhenRendered,
  shouldScrollForRouteChange,
} from './scroll.js';
import { acceptReturn, guardTraversal, quiet } from './traversal-guard.js';
import type { Interceptor } from './traversal-guard.js';

type Rendered = Extract<Outcome, { kind: 'render' }>;

/** The abort reason of a navigation that became a document load. */
const HANDED_OFF = Symbol('handed off');

/** The options that apply to a navigation the browser carries out. */
type Options = Pick<
  ChangeRouteOptions,
  'shouldScroll' | 'refetch' | 'instant' | 'onSuperseded'
>;

/** Where the result of a navigation the router asked for comes from. */
type NavigationSource =
  | Source
  /** Resolved already, by the navigation this one replaces. */
  | { readonly kind: 'resolved'; readonly outcome: Rendered };

// Carried through `navigation.navigate()` so the listener can tell a
// navigation this router asked for, and with which options and source.
class RequestInfo {
  constructor(
    readonly route: RouteProps,
    readonly options: Options,
    readonly source: NavigationSource,
    readonly settle: PromiseWithResolvers<void>,
  ) {}
}

/**
 * Asks the browser to navigate. The listener takes it from there and
 * settles the returned promise: resolved once the result is queued or the
 * navigation is dropped, rejected when the route fails to load.
 */
export function navigate(
  route: RouteProps,
  url: URL,
  history: 'push' | 'replace',
  options: Options,
  source: NavigationSource,
): Promise<void> {
  const settle = Promise.withResolvers<void>();
  ignoreResult(
    window.navigation.navigate(url.href, {
      history: history === 'replace' ? 'replace' : 'auto',
      info: new RequestInfo(route, options, source, settle),
    }),
  );
  return settle.promise;
}

/** What to do with a navigation's result. */
export type Step =
  /** Load the destination as a document. */
  | { kind: 'handOff'; outcome: Extract<Outcome, { kind: 'leave' | 'reload' }> }
  /** The result belongs at another URL than the entry is at. */
  | { kind: 'move'; outcome: Rendered }
  | { kind: 'show'; outcome: Shown };

/** Decides the step for `outcome`, given the URL of the navigation's entry. */
export const nextStep = (outcome: Outcome, entryUrl: string): Step => {
  if (outcome.kind === 'leave' || outcome.kind === 'reload') {
    return { kind: 'handOff', outcome };
  }
  return outcome.kind === 'render' && outcome.url.href !== entryUrl
    ? { kind: 'move', outcome }
    : { kind: 'show', outcome };
};

/** What the listener needs from the binding. */
export type Binding = {
  /** What the last commit showed. */
  at: () => Displayed & { cache: RouterCache; interceptor: Interceptor };
  attempts: Attempts;
  start: (route: RouteProps) => Attempt;
  /** Queues the frame for a result; settles when React has committed it. */
  show: (attempt: Attempt, result: Shown) => Promise<void>;
};

/**
 * What happens on a `navigate` event: decide whether the router takes it,
 * resolve the destination once, and show the result.
 *
 * Push and replace wait for the result before the URL moves, so the address
 * bar and the content change together and a redirect leaves no entry of its
 * own. Back, Forward and reload have already moved. An instant navigation
 * moves at once too, shows the shell it holds, and fills it in afterwards.
 */
export function createNavigateListener({ at, attempts, start, show }: Binding) {
  return (event: NavigateEvent) => {
    const info = event.info instanceof RequestInfo ? event.info : undefined;
    if (isLeftToBrowser(event, !!info) || acceptReturn(event)) {
      return;
    }
    if (event.hashChange) {
      // The browser scrolls to the fragment unless the caller opted out.
      // `currententrychange` records the new hash.
      if (info && !info.options.shouldScroll) {
        event.intercept(quiet);
      }
      info?.settle.resolve();
      return;
    }
    const url = new URL(event.destination.url);
    const route = info?.route ?? parseRoute(url);
    const showInstead = (decided: RouteProps) => {
      const shouldScroll = shouldScrollForRouteChange(decided, at().route);
      ignoreRejection(
        navigate(
          decided,
          getRouteUrl(decided),
          'replace',
          { shouldScroll },
          fetched,
        ),
      );
    };
    if (guardTraversal(event, route, at().interceptor, showInstead)) {
      return;
    }

    const push = event.navigationType === 'push';
    const pushOrReplace = push || event.navigationType === 'replace';
    const options: Options = info?.options ?? {
      // Back and Forward between entries that differ only in the query stay
      // where the page is, like a query-only push.
      shouldScroll:
        event.navigationType !== 'traverse' ||
        shouldScrollForRouteChange(route, at().route),
    };
    const waitsBeforeCommit = event.cancelable && pushOrReplace;

    const attempt = start(route);
    event.signal.addEventListener('abort', () => {
      // Once the URL has moved, only a later URL-taking navigation drops it.
      if (attempts.isLoading(attempt)) {
        attempt.abort();
      }
    });
    attempt.signal.addEventListener('abort', () => {
      if (attempt.signal.reason === SUPERSEDED) {
        options.onSuperseded?.();
      }
      // A dropped navigation counts as handled, unless it already failed.
      info?.settle.resolve();
    });
    // Tells the caller of `push()` / `replace()`; without one, logs.
    const fail = (error: unknown) => {
      if (info) {
        info.settle.reject(error);
      } else if (!attempt.signal.aborted) {
        console.error('Error while navigating:', error);
      }
    };
    // An error ends the navigation; no other navigation took its place.
    const reporting =
      <Args extends unknown[]>(run: (...args: Args) => Promise<void>) =>
      async (...args: Args) => {
        try {
          await run(...args);
        } catch (error) {
          fail(error);
          attempt.abort(error);
          throw error;
        }
      };

    // The result is resolved once; both handlers below wait for it. With
    // the destination's shell at hand, an instant navigation also gets a
    // preview to show until the response has arrived.
    const source = info?.source ?? fetched;
    let instant: ReturnType<typeof startPreview>;
    let outcome: Promise<Outcome>;
    if (source.kind === 'resolved') {
      outcome = Promise.resolve(source.outcome);
    } else {
      const request: Request = {
        route,
        url,
        scroll: options.shouldScroll,
        refetch: options.refetch,
        source,
      };
      const { cache } = at();
      if (options.instant && waitsBeforeCommit) {
        instant = startPreview(request, at(), cache, attempt.signal);
      }
      outcome = resolve(
        instant
          ? {
              ...request,
              source: { kind: 'response', response: instant.response },
            }
          : request,
        at(),
        cache,
        attempt.signal,
      );
    }
    ignoreRejection(outcome);
    // The URL this navigation's entry is at, or will be once it commits.
    let entryUrl = event.destination.url;

    // Queues the frame for a result. With that, the caller can go on.
    const present = (result: Shown) => {
      const committed = show(attempt, result);
      if (result.kind === 'failed') {
        fail(result.error);
      } else {
        info?.settle.resolve();
      }
      return committed;
    };

    // After the URL has moved: leave, replace the entry, or show.
    const finish = async () => {
      const step = nextStep(await outcome, entryUrl);
      switch (step.kind) {
        case 'handOff':
          // The entry is there already, so the document takes its place.
          return handOff(step.outcome, false);
        case 'move': {
          const { outcome: result } = step;
          // Replace the entry with a navigation that shows this result.
          // Its slots are compared with what is shown now, which an instant
          // preview has changed since the request started.
          return ignoreRejection(
            navigate(
              result.route,
              result.url,
              'replace',
              { shouldScroll: options.shouldScroll },
              {
                kind: 'resolved',
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
        }
        case 'show':
          return present(step.outcome);
        default:
          return step satisfies never;
      }
    };

    event.intercept({
      ...(options.shouldScroll ? {} : quiet),
      ...(waitsBeforeCommit && !instant
        ? {
            precommitHandler: reporting(async (controller) => {
              const step = nextStep(await outcome, entryUrl);
              if (step.kind === 'handOff') {
                // Cancel this navigation first. A document navigation
                // started while it is still being cancelled can be
                // cancelled with it.
                setTimeout(() => handOff(step.outcome, push));
                attempt.abort(HANDED_OFF);
                throw abortError();
              }
              if (step.kind === 'move') {
                entryUrl = step.outcome.url.href;
                controller.redirect(entryUrl);
              }
            }),
          }
        : {}),
      handler: reporting(async () => {
        attempts.own(attempt);
        // This navigation's, read while it is the browser's current one.
        const { transition } = window.navigation;
        if (instant) {
          await present(instant.preview);
          finish().catch((error) => {
            if (!attempt.signal.aborted) {
              fail(error);
            }
          });
        } else {
          await finish();
        }
        if (options.shouldScroll && pushOrReplace) {
          // After the browser's own scroll, which misses a fragment target
          // that renders late.
          transition?.finished.then(
            () => scrollToHashWhenRendered(at().route.hash),
            () => {},
          );
        }
      }),
    });
  };
}
