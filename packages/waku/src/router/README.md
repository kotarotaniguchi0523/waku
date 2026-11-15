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
  through `navigation.navigate()`.
- One commit never shows a route with elements from another frame.
- The intercepted navigation finishes when React commits the frame's shell,
  not when every streamed part has arrived.
- An older navigation, action or late intent cannot replace newer content.
- Once a navigation has moved the URL, only a later navigation that moves the
  URL can drop it.
- A response is cancelled only until React has it.
- Every attempt settles: abort, error and unmount leave nothing pending.
- Navigation works with prefetching and instant navigation turned off.
- A slot the server omitted because the client already holds it is kept.

`e2e/navigation-contract.spec.ts` checks these from the outside: the address
bar, the visible content, scroll, Back and Forward, and the public router API.
