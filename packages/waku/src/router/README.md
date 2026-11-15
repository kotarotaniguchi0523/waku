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

1. `client-utils/navigation.ts`: the `navigate` listener, attempts, and the
   frame updates.
2. `client-core-utils/load.ts`: fetch, redirect and 404 follows.
3. `client.tsx` and `../minimal/client-runtime.tsx` (`ControlledRoot`): where
   the frame is held and handed to Minimal.
4. `client-core-utils/server-function-routing.ts`: what a server function
   response may do to the route.

Prefetching, instant navigation and SSR are separate; read them only when a
change touches them.

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

`e2e/navigation-contract.spec.ts` checks these from the outside: the address
bar, the visible content, scroll, Back and Forward, and the public router API.

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
