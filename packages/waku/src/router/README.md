# Router internals

Six rules describe the client router. Read them before changing it.

1. `NavigateEvent` is authoritative for navigation. The browser owns the URL,
   history, scroll and focus.
2. Resolving a route returns an outcome; it does not write browser state.
3. `RenderFrame` is the single React-owned snapshot for the displayed route
   and the element updates.
4. Minimal owns Flight transport and Slot rendering, not navigation.
5. Acknowledging a frame's layout commit lets the browser finish the
   navigation.
6. Caching and instant navigation change how a route is fetched or
   previewed, not these rules.

## Reading order

A normal navigation is these files:

1. `client-utils/navigate-listener.ts`: what happens on a `navigate` event.
   It starts an attempt, resolves the route once, and shows the result.
   `nextStep()` decides what a result calls for: show it, move the entry to
   another URL, or hand the destination to the browser. Push and replace
   wait for the result before the URL moves; Back, Forward, reload and an
   instant navigation after.
2. `client-utils/resolve.ts`: request to outcome. It fetches and follows the
   route and touches neither the browser nor React.
3. `client-utils/frame.ts`: `RenderFrame` and the functions that produce the
   next frame from the previous one and an outcome. All pure.
4. `client-utils/attempts.ts`: which navigations can still change the screen.
5. `client-utils/navigation.ts`: the binding that holds these together. It
   queues frames, applies updates that move nothing in the browser, and is
   what the rest of the router calls. `use-navigation.ts` creates it and
   reports each commit to it.

Then, as needed:

- `client-core-utils/load.ts`: redirect and 404 follows inside `resolve()`.
- `client.tsx` and `../minimal/client-runtime.tsx` (`ControlledRoot`): where
  the frame is held and handed to Minimal.
- `client-core-utils/server-function-routing.ts`: what a server function
  response may do to the route.
- `client-utils/route-intent.tsx`: redirects and not-found that settle after
  their page is shown.

Each of these is used from one place and can be read on its own:
`browser-owned.ts` (navigations the router leaves alone),
`instant-preview.ts` (instant navigation), `traversal-guard.ts` (refusing
Back and Forward), `handoff.ts` (leaving for a document load), `scroll.ts`
(a fragment target that renders late). Prefetching and SSR are separate as
well.

## State

`RenderFrame` is a union. Each shape holds only what exists in that state,
so a combination that cannot happen cannot be written:

| `kind`    | Meaning                                        | Has                               |
| --------- | ---------------------------------------------- | --------------------------------- |
| `initial` | The document as served; nothing has navigated  | elements, scope                   |
| `preview` | An instant navigation shows the shell it holds | + route, origin, committed        |
| `ready`   | A navigation's response is shown               | + route, origin, committed        |
| `failed`  | A navigation could not load                    | + route, origin, committed, error |

Code that needs a field switches on `kind`; add a shape and the compiler
points at every place that has to decide about it. Frames are created only by
the functions in `frame.ts`.

The same goes for the other types a navigation passes through. A request's
`source` says where its elements come from: a fetch, or a response already on
its way. An outcome is `render`, `preview`, `failed`, `leave` or `reload`. A
step is `show`, `move` or `handOff`.

An attempt is in one of two slots. `loading` has not moved the URL and is
dropped by any newer navigation. `owner` has moved the URL and is replaced
only by the next navigation that moves it. An attempt leaves its slot when
its content is fully shown (for an instant navigation, when the response has
filled in the preview); nothing aborts it after that. An attempt's abort
reason says whether another navigation took its place, which is the only
case reported as superseded.

## Tests

- `tests/router-frame.test.ts`, `router-resolve.test.ts`,
  `router-attempts.test.ts` and `router-next-step.test.ts` check the pure
  parts through their inputs and
  outputs, with a fake server as the only stand-in. Start here: they run in
  a second.
- `e2e/navigation-contract.spec.ts` checks the rules below from the outside:
  the address bar, the visible content, scroll, Back and Forward, and the
  public router API.

## What must stay true

- The router never writes history or scrolls. A navigation it wants goes
  through `navigation.navigate()`. The exception is a fragment target that
  renders after the navigation finished: the router scrolls to it once if it
  appears within two seconds, unless another navigation starts or the page
  is scrolled first.
- One commit never shows a route with elements from another frame.
- The intercepted navigation finishes when React commits the frame's shell,
  not when every streamed part has arrived.
- An older navigation, action or late intent cannot replace newer content.
- A server function's rerender of the displayed route is not lost to a
  navigation that is loading: it joins the queued frames, so it is shown if
  the user stays on, or returns to, that route.
- Once a navigation has moved the URL, only a later navigation that moves the
  URL can drop it.
- A response is cancelled only until React has it.
- A late redirect or not-found is followed only from the place it came from:
  the displayed route's own intent survives a fragment change, an intent from
  a partial response does not, and neither is followed while another
  navigation is loading.
- When Back or Forward is refused, the address bar stays on, or returns to,
  the entry whose content is shown.
- Every attempt settles: abort, error and unmount leave nothing pending.
- Navigation works with prefetching and instant navigation turned off.
- A slot the server omitted because the client already holds it is kept.

## Decided limits

- There is no timeout on a frame that React has not committed. The
  navigation stays pending, which is what the browser's busy indicator should
  show, until the frame commits or a newer navigation takes over.
- Streamed content that fails after its page is shown is handled by React's
  error boundaries, not by the router. Without a boundary in the app the
  router's own boundary replaces the page with the error.
- Several `Router` instances may be mounted. Each listens to the same
  `navigate` event and renders the destination itself; they share the
  document's URL and history. Server function calls go to the most recently
  mounted one.
- `push()` and `replace()` resolve when the frame is queued or the navigation
  is superseded, and reject when the route fails to load. They do not report
  a frame that was queued and then abandoned before it was shown.

## Checks that need a real device

Automated browsers cannot perform these, so run them by hand before a release
that touches navigation:

- Swipe back and forward on a touch device or trackpad. The browser shows its
  own preview of the destination and reports `hasUAVisualTransition`; the page
  must not animate a second time, and each entry's scroll position must be
  restored.
- Navigate with a `<ViewTransition>` around the route on a slow connection.
  The transition must finish and focus must land on the new page.
  (`e2e/router-client.spec.ts` covers the fast case.)
