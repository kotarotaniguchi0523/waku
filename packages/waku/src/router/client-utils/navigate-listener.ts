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
type Previewed = Extract<Outcome, { kind: 'preview' }>;

/** The abort reason of a navigation that became a document load. */
const HANDED_OFF = Symbol('handed off');

/** The abort reason of a navigation whose result another one carries on. */
const CONTINUED = Symbol('continued');

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

/**
 * Starts resolving a navigation. With `wantsPreview` and the destination's
 * shell at hand, it also returns a preview to show until the response has
 * arrived; the response then comes from the request the preview started.
 */
function begin(
  request: Omit<Request, 'source'>,
  source: NavigationSource,
  wantsPreview: boolean,
  shown: Displayed & { cache: RouterCache },
  signal: AbortSignal,
): { outcome: Promise<Outcome>; preview: Previewed | undefined } {
  if (source.kind === 'resolved') {
    return { outcome: Promise.resolve(source.outcome), preview: undefined };
  }
  const instant = wantsPreview
    ? startPreview({ ...request, source }, shown, shown.cache, signal)
    : undefined;
  const outcome = resolve(
    {
      ...request,
      source: instant
        ? { kind: 'response', response: instant.response, follows: 0 }
        : source,
    },
    shown,
    shown.cache,
    signal,
  );
  // Both handlers of the listener wait for it; neither may be reached.
  ignoreRejection(outcome);
  return { outcome, preview: instant?.preview };
}

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
 * own. Back and Forward have already moved. An instant navigation
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
        attempt.abort(SUPERSEDED);
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
    const stop = (error: unknown) => {
      fail(error);
      attempt.abort(error);
      throw error;
    };

    // The result is resolved once; both handlers below wait for it.
    const source = info?.source ?? fetched;
    const { outcome, preview } = begin(
      { route, url, scroll: options.shouldScroll, refetch: options.refetch },
      source,
      !!options.instant && waitsBeforeCommit,
      at(),
      attempt.signal,
    );

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
    const finish = async (entryUrl: string) => {
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
              {
                shouldScroll: options.shouldScroll,
                onSuperseded: options.onSuperseded,
              },
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

    const beforeCommit = async (controller: NavigationPrecommitController) => {
      const step = nextStep(await outcome, event.destination.url);
      if (step.kind === 'handOff') {
        // Cancel this navigation first. A document navigation started
        // while it is still being cancelled can be cancelled with it.
        setTimeout(() => handOff(step.outcome, push));
        attempt.abort(HANDED_OFF);
        throw abortError();
      }
      if (step.kind === 'move') {
        controller.redirect(step.outcome.url.href);
      }
    };

    const afterCommit = async () => {
      // A navigation that carries on from the one it replaces does not
      // supersede it.
      attempts.own(
        attempt,
        source.kind === 'resolved' ? CONTINUED : SUPERSEDED,
      );
      // Both belong to this navigation while it is the browser's current
      // one. The entry is where a redirect before the commit has put it.
      const { transition, currentEntry } = window.navigation;
      const entryUrl = currentEntry?.url ?? event.destination.url;
      let failed = false;
      if (preview) {
        await present(preview);
        finish(entryUrl)
          .catch(stop)
          .catch(() => {});
      } else {
        await finish(entryUrl);
        failed = (await outcome).kind === 'failed';
      }
      if (options.shouldScroll && pushOrReplace && !failed) {
        // After the browser's own scroll, which misses a fragment target
        // that renders late.
        transition?.finished.then(
          () => scrollToHashWhenRendered(at().route.hash),
          () => {},
        );
      }
    };

    event.intercept({
      ...(options.shouldScroll ? {} : quiet),
      ...(waitsBeforeCommit && !preview
        ? {
            precommitHandler: (controller) =>
              beforeCommit(controller).catch(stop),
          }
        : {}),
      handler: () => afterCommit().catch(stop),
    });
  };
}
