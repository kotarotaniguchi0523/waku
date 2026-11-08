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

const HASH_TARGET_TIMEOUT_MS = 5_000;

function scrollToHashElement(element: HTMLElement, behavior: ScrollBehavior) {
  const scrollMarginTop =
    Number.parseFloat(window.getComputedStyle(element).scrollMarginTop) || 0;
  window.scrollTo({
    left: 0,
    top: element.getBoundingClientRect().top + window.scrollY - scrollMarginTop,
    behavior,
  });
}

export function scrollToHash(
  hash: string,
  behavior: ScrollBehavior,
  scrollTopForMissingHash: boolean,
) {
  const target = hash ? getHashElement(hash) : null;
  if (target) {
    scrollToHashElement(target, behavior);
    return true;
  }
  if (!hash || scrollTopForMissingHash) {
    window.scrollTo({ left: 0, top: 0, behavior });
  }
  return !hash;
}

// Observe only a fragment the router has already tried to scroll to.
export function waitForHashTarget(hash: string, behavior: ScrollBehavior) {
  const href = window.location.href;
  const observer = new MutationObserver(() => {
    if (window.location.href !== href) {
      stop();
      return;
    }
    const target = getHashElement(hash);
    if (target) {
      stop();
      scrollToHashElement(target, behavior);
    }
  });
  const stop = () => {
    observer.disconnect();
    clearTimeout(timeout);
  };
  const timeout = setTimeout(stop, HASH_TARGET_TIMEOUT_MS);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['id', 'name'],
  });
  return stop;
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
