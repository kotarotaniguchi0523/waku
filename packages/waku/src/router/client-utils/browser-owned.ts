import { HANDOFF } from './handoff.js';

// `<a rel="external">` opts a same-origin link out of client navigation, and
// a `download` link is the browser's to handle. The event's own
// `downloadRequest` is checked too, but one browser follows it with a second
// event that does not carry it.
const isExternalLink = (element: Element | null | undefined) => {
  const anchor = element?.closest('a, area');
  return (
    !!anchor &&
    (anchor.hasAttribute('download') ||
      !!anchor.getAttribute('rel')?.split(/\s+/).includes('external'))
  );
};

/**
 * Navigations the router does not take part in. `own` says whether the
 * router itself asked for this one.
 */
export function isLeftToBrowser(event: NavigateEvent, own: boolean): boolean {
  const { navigationType } = event;
  return (
    // A document load the router asked for.
    event.info === HANDOFF ||
    // React navigates to the current URL while a transition is pending,
    // only to make the browser show that the page is busy.
    event.info === 'react-transition' ||
    !event.canIntercept ||
    event.downloadRequest !== null ||
    !!event.formData ||
    // The author asked for a document load, for example to sign out.
    isExternalLink(event.sourceElement) ||
    // `history.pushState()` or `replaceState()` from other code: that code
    // changed the URL for its own purposes and shows its own content.
    (!own &&
      event.destination.sameDocument &&
      (navigationType === 'push' || navigationType === 'replace'))
  );
}
