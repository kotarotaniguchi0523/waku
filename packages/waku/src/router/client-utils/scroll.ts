import { pathnameToCurrentRoutePath } from '../client-core-utils/route-url.js';
import type { RouteProps } from '../isomorphic-utils/route-path.js';

// a run decodes together, so a multi byte character survives
const decodeHash = (raw: string) =>
  raw.replace(/(?:%[0-9A-Fa-f]{2})+/g, (escapes) => {
    try {
      return decodeURIComponent(escapes);
    } catch {
      return escapes;
    }
  });

const getHashElement = (hash: string): HTMLElement | null => {
  const raw = hash.slice(1);
  const decoded = decodeHash(raw);
  for (const name of new Set([raw, decoded])) {
    const byId = document.getElementById(name);
    if (byId) {
      return byId;
    }
    // the spec counts anchors only, not a meta or an input
    for (const named of document.getElementsByName(name)) {
      if (named.localName === 'a') {
        return named;
      }
    }
  }
  return decoded.toLowerCase() === 'top' ? document.documentElement : null;
};
export const getHashElementForTest = getHashElement;

export function scrollToHash(
  hash: string,
  behavior: ScrollBehavior,
  scrollTopForMissingHash: boolean,
) {
  if (hash) {
    const element = getHashElement(hash);
    if (!element) {
      if (!scrollTopForMissingHash) {
        return;
      }
      window.scrollTo({
        left: 0,
        top: 0,
        behavior,
      });
      return;
    }
    const scrollMarginTop =
      Number.parseFloat(window.getComputedStyle(element).scrollMarginTop) || 0;
    window.scrollTo({
      left: 0,
      top:
        element.getBoundingClientRect().top + window.scrollY - scrollMarginTop,
      behavior,
    });
    return;
  }
  window.scrollTo({
    left: 0,
    top: 0,
    behavior,
  });
}

const LATE_HASH_TIMEOUT = 2000;

/**
 * The browser scrolls to a fragment when the navigation finishes. A target
 * that renders later, such as one inside `<Suspense>`, is scrolled to once it
 * appears. The wait ends after a timeout, when another navigation starts, or
 * when the page is scrolled away from where the navigation left it.
 */
export function scrollToHashWhenRendered(hash: string) {
  if (!hash || getHashElement(hash)) {
    return;
  }
  const { navigation } = window;
  const left = window.scrollX;
  const top = window.scrollY;
  const observer = new MutationObserver(() => {
    if (getHashElement(hash)) {
      stop();
      scrollToHash(hash, 'auto', false);
    }
  });
  const onScroll = () => {
    if (window.scrollX !== left || window.scrollY !== top) {
      stop();
    }
  };
  const onNavigate = (event: NavigateEvent) => {
    // React's transition indicator does not move anywhere.
    if (event.info !== 'react-transition') {
      stop();
    }
  };
  const timer = setTimeout(stop, LATE_HASH_TIMEOUT);
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributeFilter: ['id', 'name'],
  });
  window.addEventListener('scroll', onScroll, { passive: true });
  navigation.addEventListener('navigate', onNavigate);
  function stop() {
    clearTimeout(timer);
    observer.disconnect();
    window.removeEventListener('scroll', onScroll);
    navigation.removeEventListener('navigate', onNavigate);
  }
}

export function shouldScrollByDefault(url: URL) {
  return (
    pathnameToCurrentRoutePath(url.pathname) !==
      pathnameToCurrentRoutePath(window.location.pathname) ||
    url.hash !== window.location.hash
  );
}

export function shouldScrollForRouteChange(next: RouteProps, prev: RouteProps) {
  return next.path !== prev.path || next.hash !== prev.hash;
}
