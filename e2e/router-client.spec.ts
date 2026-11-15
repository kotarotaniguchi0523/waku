import { expect } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';
import {
  createFetchResponseReader,
  prepareNormalSetup,
  test,
  waitForHydration,
  waitForSelectorText,
} from './utils.js';

const startApp = prepareNormalSetup('router-client');
const allowedConsoleErrorPatterns: RegExp[] = [
  /An error occurred in the Server Components render\./,
  /Error:\s+Not Found/,
  /Error:\s+Redirect/,
  /Failed to load resource: the server responded with a status of 404 \(Not Found\)/,
  /Error: 404 Not Found/,
];
const isAllowedConsoleError = (text: string) =>
  allowedConsoleErrorPatterns.some((pattern) => pattern.test(text));

// The browser does the scrolling, so these helpers watch where the page ends
// up instead of who asked for it. A "scroll" is a change of position since
// the recorder was installed or last reset.
type ScrollPosition = { left: number; top: number };
// `anchor` is where a fixed piece of content sits in the viewport. When
// content is added above it the browser adjusts the scroll offset to keep it
// in place, which is not a scroll the user sees.
type ScrollReading = ScrollPosition & { anchor: number | null };

const readScroll = (page: Page): Promise<ScrollReading> =>
  page.evaluate(
    () =>
      new Promise<{ left: number; top: number; anchor: number | null }>(
        (resolve) => {
          // two frames let a scroll that follows a commit take place
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              resolve({
                left: window.scrollX,
                top: window.scrollY,
                anchor:
                  document
                    .getElementById('scroll-target')
                    ?.getBoundingClientRect().top ?? null,
              }),
            ),
          );
        },
      ),
  );

const settledScroll = async (page: Page) => {
  let previous = await readScroll(page);
  while (true) {
    const next = await readScroll(page);
    if (next.left === previous.left && next.top === previous.top) {
      return next;
    }
    previous = next;
  }
};

const scrollBaselines = new WeakMap<Page, ScrollReading>();

const installScrollToRecorder = async (page: Page) => {
  scrollBaselines.set(page, await settledScroll(page));
};

const resetScrollToCalls = installScrollToRecorder;

const getScrollToCalls = async (page: Page): Promise<ScrollPosition[]> => {
  const baseline = scrollBaselines.get(page)!;
  const { left, top, anchor } = await settledScroll(page);
  const unmoved =
    left === baseline.left &&
    (anchor !== null && baseline.anchor !== null
      ? Math.abs(anchor - baseline.anchor) <= 1
      : top === baseline.top);
  return unmoved ? [] : [{ left, top }];
};

test.describe('router-client', () => {
  let port: number;
  let stopApp: () => Promise<void>;
  let consoleErrors: string[];
  let consoleHandler: ((msg: ConsoleMessage) => void) | undefined;

  test.beforeAll(async ({ mode }) => {
    ({ port, stopApp } = await startApp(mode));
  });

  test.beforeEach(async ({ page }) => {
    consoleErrors = [];
    consoleHandler = (msg: ConsoleMessage) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    };
    page.on('console', consoleHandler);
  });

  test.afterEach(async ({ page }) => {
    if (consoleHandler) {
      page.off('console', consoleHandler);
    }
    const unexpectedErrors = consoleErrors.filter(
      (text) => !isAllowedConsoleError(text),
    );
    expect(unexpectedErrors).toEqual([]);
  });

  test.afterAll(async () => {
    await stopApp();
  });

  test('a client-entry enhancer handles navigation from the initial layout effect', async ({
    page,
  }) => {
    const [request] = await Promise.all([
      page.waitForRequest(
        (request) =>
          request.url().includes('/RSC/') &&
          new URL(request.url()).searchParams.get('query') === 'from=layout',
      ),
      page.goto(`http://localhost:${port}/start?enhancer-layout`),
    ]);
    expect(request.headers()['x-rsc-enhancer']).toBe('configured');
    await expect(page).toHaveURL(`http://localhost:${port}/next?from=layout`);
    await expect(page.getByTestId('route-path')).toHaveText('/next');
  });

  test('popstate interceptor can block navigation', async ({ page }) => {
    await page.goto(`http://localhost:${port}/start`);
    await waitForHydration(page);

    await expect(page.getByRole('heading', { name: 'Start' })).toBeVisible();
    await expect(page.getByTestId('route-path')).toHaveText('/start');
    await expect(page.getByTestId('route-query')).toHaveText('');

    await page.evaluate(() => {
      window.history.pushState({}, '', '/ignored?__interceptor=block');
      // a real traversal back onto that entry
      window.history.pushState({}, '', '/start');
      window.history.back();
    });

    await expect(page.getByRole('heading', { name: 'Start' })).toBeVisible();
    await expect(page.getByTestId('route-path')).toHaveText('/start');
    await expect(page.getByTestId('route-query')).toHaveText('');
  });

  test('concurrent Router mounts settle with different initial routes', async ({
    page,
  }) => {
    await page.goto(`http://localhost:${port}/start`);
    await waitForHydration(page);

    const requests: string[] = [];
    page.on('request', (request) => {
      if (
        request.url().includes('/RSC/R/multiple-router.txt') ||
        request.url().includes('/RSC/R/other-router.txt')
      ) {
        requests.push(request.url());
      }
    });

    await page.getByTestId('mount-routers').click();

    const first = page.frameLocator('[data-testid="first-router"]');
    const second = page.frameLocator('[data-testid="second-router"]');
    const third = page.frameLocator('[data-testid="third-router"]');
    const fourth = page.frameLocator('[data-testid="fourth-router"]');
    await expect(first.getByTestId('server-query')).toHaveText('name=first');
    await expect(first.getByTestId('route-query')).toHaveText('name=first');
    await expect(second.getByTestId('server-query')).toHaveText('name=second');
    await expect(second.getByTestId('route-query')).toHaveText('name=second');
    await expect(third.getByTestId('server-query')).toHaveText('');
    await expect(third.getByTestId('route-query')).toHaveText('');
    await expect(fourth.getByTestId('server-query')).toHaveText('');
    await expect(fourth.getByTestId('route-query')).toHaveText('');
    expect(requests).toHaveLength(4);
  });

  test('popstate interceptor can rewrite navigation target', async ({
    page,
  }) => {
    await page.goto(`http://localhost:${port}/start`);
    await waitForHydration(page);

    await expect(page.getByRole('heading', { name: 'Start' })).toBeVisible();
    await expect(page.getByTestId('route-path')).toHaveText('/start');
    await expect(page.getByTestId('route-query')).toHaveText('');

    await page.evaluate(() => {
      window.history.pushState({}, '', '/ignored?__interceptor=rewrite');
      // a real traversal back onto that entry
      window.history.pushState({}, '', '/start');
      window.history.back();
    });

    await waitForSelectorText(
      page,
      '[data-testid="route-path"]',
      '/intercepted',
    );
    await waitForSelectorText(
      page,
      '[data-testid="route-query"]',
      'from=interceptor',
    );
    await waitForSelectorText(page, 'h1', 'Intercepted');
  });

  // Playwright's click() scrolls its target into view, which would move the
  // page before the navigation does. These tests dispatch the click instead.
  test('hash-only link navigation scrolls to anchor target', async ({
    page,
  }) => {
    await page.goto(`http://localhost:${port}/start`);
    await waitForHydration(page);
    await installScrollToRecorder(page);

    await page.getByTestId('router-push-hash-target').dispatchEvent('click');

    await expect(page.getByTestId('route-path')).toHaveText('/start');
    await expect(page.getByTestId('route-query')).toHaveText('');
    await expect(page.getByTestId('route-hash')).toHaveText('#scroll-target');
    await expect(page).toHaveURL(/\/start#scroll-target$/);
    const scrollToCalls = await getScrollToCalls(page);
    const lastScrollToCall = scrollToCalls.at(-1);
    expect(lastScrollToCall).toBeDefined();
    expect(lastScrollToCall?.left).toBe(0);
    expect(lastScrollToCall?.top).toBeGreaterThan(100);
  });

  const getDocumentOffsetTop = async (page: Page, testId: string) =>
    page
      .getByTestId(testId)
      .evaluate(
        (element) => element.getBoundingClientRect().top + window.scrollY,
      );

  test('non-ASCII hash link navigation scrolls to anchor target', async ({
    page,
  }) => {
    await page.goto(`http://localhost:${port}/start`);
    await waitForHydration(page);
    await installScrollToRecorder(page);

    // Uses a `<Link>` (not router.push) to a non-ASCII fragment. `URL.hash`
    // percent-encodes it, so the scroll lookup must decode before matching the
    // element id (issue #2123).
    await page.getByTestId('go-hash-japanese').dispatchEvent('click');

    await expect(page.getByTestId('route-path')).toHaveText('/start');
    await expect(page.getByTestId('route-query')).toHaveText('');
    await expect(page).toHaveURL(
      /\/start#%E6%97%A5%E6%9C%AC%E8%AA%9E%E8%A6%8B%E5%87%BA%E3%81%97$/,
    );
    const scrollToCalls = await getScrollToCalls(page);
    const lastScrollToCall = scrollToCalls.at(-1);
    expect(lastScrollToCall).toBeDefined();
    expect(lastScrollToCall?.left).toBe(0);
    // The scroll must target the Japanese anchor specifically, not just
    // somewhere down the page.
    const japaneseTargetTop = await getDocumentOffsetTop(
      page,
      'japanese-target',
    );
    expect(lastScrollToCall?.top).toBeGreaterThan(100);
    // The page cannot scroll past its end, so the target may sit lower than
    // the top of the viewport.
    const maxScrollTop = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );
    expect(
      Math.abs(
        (lastScrollToCall?.top ?? 0) -
          Math.min(japaneseTargetTop, maxScrollTop),
      ),
    ).toBeLessThanOrEqual(1);
  });

  test('hash-only non-ASCII link navigation scrolls to anchor target', async ({
    page,
  }) => {
    await page.goto(`http://localhost:${port}/start`);
    await waitForHydration(page);
    await installScrollToRecorder(page);

    // Matches the exact surface reported in issue #2123: a hash-only
    // `<Link to="#日本語見出し">` without a path.
    await page.getByTestId('go-hash-only-japanese').dispatchEvent('click');

    await expect(page.getByTestId('route-path')).toHaveText('/start');
    await expect(page.getByTestId('route-query')).toHaveText('');
    await expect(page).toHaveURL(
      /\/start#%E6%97%A5%E6%9C%AC%E8%AA%9E%E8%A6%8B%E5%87%BA%E3%81%97$/,
    );
    const scrollToCalls = await getScrollToCalls(page);
    const lastScrollToCall = scrollToCalls.at(-1);
    expect(lastScrollToCall).toBeDefined();
    expect(lastScrollToCall?.left).toBe(0);
    const japaneseTargetTop = await getDocumentOffsetTop(
      page,
      'japanese-target',
    );
    expect(lastScrollToCall?.top).toBeGreaterThan(100);
    // The page cannot scroll past its end, so the target may sit lower than
    // the top of the viewport.
    const maxScrollTop = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );
    expect(
      Math.abs(
        (lastScrollToCall?.top ?? 0) -
          Math.min(japaneseTargetTop, maxScrollTop),
      ),
    ).toBeLessThanOrEqual(1);
  });

  test('hash link re-scrolls to the same anchor on a repeated click', async ({
    page,
  }) => {
    await page.goto(`http://localhost:${port}/start`);
    await waitForHydration(page);
    await installScrollToRecorder(page);

    // First click scrolls to the target (issue #2124 is about the second one).
    await page.getByTestId('go-hash-target').dispatchEvent('click');
    await expect(page).toHaveURL(/\/start#scroll-target$/);
    expect((await getScrollToCalls(page)).at(-1)?.top).toBeGreaterThan(100);

    // Scroll away and clear the recorder, then click the same link again. A
    // native anchor re-scrolls every time; `<Link>` must too.
    await page.evaluate(() => {
      window.scrollTo({ left: 0, top: 0 });
    });
    await resetScrollToCalls(page);

    await page.getByTestId('go-hash-target').dispatchEvent('click');

    await expect(page).toHaveURL(/\/start#scroll-target$/);
    const scrollToCalls = await getScrollToCalls(page);
    const lastScrollToCall = scrollToCalls.at(-1);
    expect(lastScrollToCall).toBeDefined();
    expect(lastScrollToCall?.left).toBe(0);
    expect(lastScrollToCall?.top).toBeGreaterThan(100);
  });

  test('hash-only navigation preserves scroll when hash target is missing', async ({
    page,
  }) => {
    await page.goto(`http://localhost:${port}/start`);
    await waitForHydration(page);

    await page.evaluate(() => {
      window.scrollTo({ left: 0, top: 600 });
    });
    await installScrollToRecorder(page);

    await page.getByTestId('router-push-hash-missing').dispatchEvent('click');

    await expect(page.getByTestId('route-path')).toHaveText('/start');
    await expect(page.getByTestId('route-query')).toHaveText('');
    await expect(page.getByTestId('route-hash')).toHaveText('#missing');
    await expect(page).toHaveURL(/\/start#missing$/);
    expect(await getScrollToCalls(page)).toHaveLength(0);
  });

  test('query-only link navigation preserves current scroll position by default', async ({
    page,
  }) => {
    await page.goto(`http://localhost:${port}/start`);
    await waitForHydration(page);

    await page.evaluate(() => {
      window.scrollTo({ left: 0, top: 600 });
    });
    await installScrollToRecorder(page);

    await page.getByTestId('router-push-query-only').dispatchEvent('click');

    await expect(page.getByTestId('route-path')).toHaveText('/start');
    await expect(page.getByTestId('route-query')).toHaveText('from=query-only');
    await expect(page.getByTestId('route-hash')).toHaveText('');
    await expect(page).toHaveURL(/\/start\?from=query-only$/);
    const scrollToCalls = await getScrollToCalls(page);
    expect(scrollToCalls).toHaveLength(0);
  });

  test('same-route trailing-slash navigation preserves scroll and keeps canonical route path', async ({
    page,
  }) => {
    await page.goto(`http://localhost:${port}/start`);
    await waitForHydration(page);

    await page.evaluate(() => {
      window.scrollTo({ left: 0, top: 600 });
    });
    await installScrollToRecorder(page);

    await page.getByTestId('router-push-trailing-slash').dispatchEvent('click');

    await expect(page.getByTestId('route-path')).toHaveText('/start');
    await expect(page.getByTestId('route-query')).toHaveText('');
    await expect(page.getByTestId('route-hash')).toHaveText('');
    await expect(page).toHaveURL(/\/start\/$/);
    expect(await getScrollToCalls(page)).toHaveLength(0);
  });

  test('path-change link navigation resets scroll position to top by default', async ({
    page,
  }) => {
    await page.goto(`http://localhost:${port}/start`);
    await waitForHydration(page);

    await page.evaluate(() => {
      window.scrollTo({ left: 0, top: 600 });
    });
    await installScrollToRecorder(page);

    await page.getByTestId('router-push-next').dispatchEvent('click');

    await expect(page.getByRole('heading', { name: 'Next' })).toBeVisible();
    await expect(page.getByTestId('route-path')).toHaveText('/next');
    await expect(page.getByTestId('route-query')).toHaveText('x=1');
    await expect(page.getByTestId('route-hash')).toHaveText('');
    await expect(page).toHaveURL(/\/next\?x=1$/);
    const scrollToCalls = await getScrollToCalls(page);
    const lastScrollToCall = scrollToCalls.at(-1);
    expect(lastScrollToCall).toBeDefined();
    expect(lastScrollToCall?.left).toBe(0);
    expect(lastScrollToCall?.top).toBe(0);
  });

  test('back/forward for query-only history preserves scroll behavior', async ({
    page,
  }) => {
    await page.goto(`http://localhost:${port}/start`);
    await waitForHydration(page);

    await page.evaluate(() => {
      window.scrollTo({ left: 0, top: 600 });
    });
    await installScrollToRecorder(page);

    await page.getByTestId('router-push-query-only').dispatchEvent('click');
    await expect(page.getByTestId('route-path')).toHaveText('/start');
    await expect(page.getByTestId('route-query')).toHaveText('from=query-only');
    expect(await getScrollToCalls(page)).toHaveLength(0);

    await page.evaluate(() => {
      window.history.back();
    });
    await expect(page.getByTestId('route-path')).toHaveText('/start');
    await expect(page.getByTestId('route-query')).toHaveText('');
    // The page changes height when the query line comes and goes, and
    // browsers compensate for that differently. What matters is that the
    // router did not send the page to the top.
    expect((await settledScroll(page)).top).toBeGreaterThan(500);

    await page.evaluate(() => {
      window.history.forward();
    });
    await expect(page.getByTestId('route-path')).toHaveText('/start');
    await expect(page.getByTestId('route-query')).toHaveText('from=query-only');
    expect((await settledScroll(page)).top).toBeGreaterThan(500);
  });

  test('back/forward for path-change history restores each entry scroll position', async ({
    page,
  }) => {
    await page.goto(`http://localhost:${port}/start`);
    await waitForHydration(page);

    await page.evaluate(() => {
      window.scrollTo({ left: 0, top: 600 });
    });
    await installScrollToRecorder(page);

    await page.getByTestId('router-push-next').dispatchEvent('click');
    await expect(page.getByRole('heading', { name: 'Next' })).toBeVisible();
    await expect(page.getByTestId('route-path')).toHaveText('/next');
    let scrollToCalls = await getScrollToCalls(page);
    let lastScrollToCall = scrollToCalls.at(-1);
    expect(lastScrollToCall).toBeDefined();
    expect(lastScrollToCall?.top).toBe(0);

    await resetScrollToCalls(page);
    await page.evaluate(() => {
      window.history.back();
    });
    await expect(page.getByRole('heading', { name: 'Start' })).toBeVisible();
    await expect(page.getByTestId('route-path')).toHaveText('/start');
    // Back restores where the page was when it was left.
    scrollToCalls = await getScrollToCalls(page);
    lastScrollToCall = scrollToCalls.at(-1);
    expect(lastScrollToCall).toBeDefined();
    expect(lastScrollToCall?.top).toBe(600);

    await resetScrollToCalls(page);
    await page.evaluate(() => {
      window.history.forward();
    });
    await expect(page.getByRole('heading', { name: 'Next' })).toBeVisible();
    await expect(page.getByTestId('route-path')).toHaveText('/next');
    scrollToCalls = await getScrollToCalls(page);
    lastScrollToCall = scrollToCalls.at(-1);
    expect(lastScrollToCall).toBeDefined();
    expect(lastScrollToCall?.top).toBe(0);
  });

  test('forward to hash history entry scrolls to anchor target', async ({
    page,
  }) => {
    await page.goto(`http://localhost:${port}/start`);
    await waitForHydration(page);
    await installScrollToRecorder(page);

    await page.getByTestId('router-push-hash-target').dispatchEvent('click');
    await expect(page.getByTestId('route-hash')).toHaveText('#scroll-target');

    await resetScrollToCalls(page);
    await page.evaluate(() => {
      window.history.back();
    });
    await expect(page.getByTestId('route-hash')).toHaveText('');

    await resetScrollToCalls(page);
    await page.evaluate(() => {
      window.history.forward();
    });
    await expect(page.getByTestId('route-hash')).toHaveText('#scroll-target');
    const scrollToCalls = await getScrollToCalls(page);
    const lastScrollToCall = scrollToCalls.at(-1);
    expect(lastScrollToCall).toBeDefined();
    expect(lastScrollToCall?.left).toBe(0);
    expect(lastScrollToCall?.top).toBeGreaterThan(100);
  });

  test.describe('fragment target that renders after the page is shown', () => {
    const expectPageShown = async (page: Page, hash: string) => {
      await expect(
        page.getByRole('heading', { name: 'Late Hash' }),
      ).toBeVisible();
      await expect(page.getByTestId('route-hash')).toHaveText(hash);
      await expect(page).toHaveURL(new RegExp(`/late-hash${hash}$`));
    };
    const targetTop = (page: Page, id: string) =>
      page.getByTestId(id).evaluate((element) => {
        return element.getBoundingClientRect().top;
      });

    test('is scrolled to once it appears', async ({ page }) => {
      await page.goto(`http://localhost:${port}/start`);
      await waitForHydration(page);

      await page.getByTestId('go-late-soon').dispatchEvent('click');
      await expectPageShown(page, '#late-soon');
      await expect(page.getByTestId('late-soon')).toBeAttached();
      const { top } = await settledScroll(page);
      expect(top).toBeGreaterThan(100);
      expect(Math.abs(await targetTop(page, 'late-soon'))).toBeLessThanOrEqual(
        1,
      );
    });

    test('is not scrolled to by a navigation with scroll: false', async ({
      page,
    }) => {
      await page.goto(`http://localhost:${port}/start`);
      await waitForHydration(page);
      await installScrollToRecorder(page);

      await page.getByTestId('go-late-soon-no-scroll').dispatchEvent('click');
      await expectPageShown(page, '#late-soon');
      await expect(page.getByTestId('late-soon')).toBeAttached();
      expect(await getScrollToCalls(page)).toHaveLength(0);
    });

    test('is not scrolled to after the wait times out', async ({ page }) => {
      await page.goto(`http://localhost:${port}/start`);
      await waitForHydration(page);
      await installScrollToRecorder(page);

      await page.getByTestId('go-late-never').dispatchEvent('click');
      await expectPageShown(page, '#late-never');
      await expect(page.getByTestId('late-never')).toBeAttached({
        timeout: 10_000,
      });
      expect(await getScrollToCalls(page)).toHaveLength(0);
    });

    test('is not scrolled to after the user scrolls', async ({ page }) => {
      await page.goto(`http://localhost:${port}/start`);
      await waitForHydration(page);

      await page.getByTestId('go-late-slow').dispatchEvent('click');
      await expectPageShown(page, '#late-slow');
      await expect(page.getByTestId('late-slow')).not.toBeAttached();
      await page.mouse.move(100, 100);
      await page.mouse.wheel(0, 300);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(300);
      await installScrollToRecorder(page);

      await expect(page.getByTestId('late-slow')).toBeAttached();
      expect(await getScrollToCalls(page)).toHaveLength(0);
    });

    test('is not scrolled to after another navigation starts', async ({
      page,
    }) => {
      await page.goto(`http://localhost:${port}/start`);
      await waitForHydration(page);

      await page.getByTestId('go-late-slow').dispatchEvent('click');
      await expectPageShown(page, '#late-slow');
      await expect(page.getByTestId('late-slow')).not.toBeAttached();
      await installScrollToRecorder(page);
      await page.evaluate(() => {
        window.location.hash = '#missing';
      });
      await expect(page.getByTestId('route-hash')).toHaveText('#missing');

      await expect(page.getByTestId('late-slow')).toBeAttached();
      expect(await getScrollToCalls(page)).toHaveLength(0);
    });
  });

  test('route fetch sends the cached etags header', async ({ page }) => {
    await page.goto(`http://localhost:${port}/start`);
    await waitForHydration(page);

    const nextRscRequestPromise = page.waitForRequest(
      (request) =>
        request.url().includes('/RSC/R/next.txt') && request.method() === 'GET',
    );
    await page.getByTestId('go-next').click();
    const request = await nextRscRequestPromise;

    const etagsHeader = request.headers()['x-waku-etags'];
    expect(etagsHeader).toBeTruthy();
    const etags = JSON.parse(etagsHeader as string) as Record<string, unknown>;
    expect(Array.isArray(etags)).toBe(false);
    expect(Object.keys(etags).length).toBeGreaterThan(0);

    await expect(page.getByRole('heading', { name: 'Next' })).toBeVisible();
    await expect(page.getByTestId('route-path')).toHaveText('/next');
    await expect(page.getByTestId('route-query')).toHaveText('x=1');
  });

  test('a ViewTransition animates a navigation', async ({ page }) => {
    await page.goto(`http://localhost:${port}/start`);
    await waitForHydration(page);
    await page.getByTestId('transition-link').click();
    await expect(
      page.getByRole('heading', { name: 'View Target' }),
    ).toBeVisible();
    await expect(page.getByTestId('route-query')).toHaveText('from=transition');
    // React runs the transition only because the router commits inside one.
    // A browser without the View Transitions API skips it and still commits.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as Record<string, unknown>)
              .__viewTransitionEntered === true ||
            typeof document.startViewTransition !== 'function',
        ),
      )
      .toBe(true);
  });

  test('soft navigation omits the unchanged static layout payload', async ({
    page,
  }) => {
    const readResponseBody = await createFetchResponseReader(page);
    await page.goto(`http://localhost:${port}/skip/a`);
    await waitForHydration(page);

    await expect(page.getByTestId('skip-static-layout-marker')).toHaveText(
      'SKIP_STATIC_LAYOUT_MARKER',
    );
    await expect(
      page.getByRole('heading', { name: 'SKIP_A_PAGE_MARKER' }),
    ).toBeVisible();

    const rscResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes('/RSC/R/skip/b.txt') &&
        response.request().method() === 'GET',
    );

    await page.getByTestId('skip-go-b').click();

    const response = await rscResponsePromise;
    const request = response.request();
    const etagsHeader = request.headers()['x-waku-etags'];

    expect(etagsHeader).toBeTruthy();
    const etags = JSON.parse(etagsHeader as string) as Record<string, unknown>;
    expect(Array.isArray(etags)).toBe(false);
    expect('root' in etags).toBe(true);

    const payload = await readResponseBody(response.url());
    expect(payload).toContain('SKIP_B_PAGE_MARKER');
    expect(payload).not.toContain('SKIP_STATIC_LAYOUT_MARKER');
    expect(payload).not.toContain('SKIP_A_PAGE_MARKER');

    await expect(
      page.getByRole('heading', { name: 'SKIP_B_PAGE_MARKER' }),
    ).toBeVisible();
    await expect(page.getByTestId('skip-static-layout-marker')).toHaveText(
      'SKIP_STATIC_LAYOUT_MARKER',
    );
  });

  test('unstable_prefetchOnView triggers prefetch when link enters viewport', async ({
    page,
  }) => {
    const prefetchedViewRequests: string[] = [];
    page.on('request', (request) => {
      const requestUrl = request.url();
      if (
        request.method() === 'GET' &&
        requestUrl.includes('/RSC/R/view-target.txt')
      ) {
        prefetchedViewRequests.push(requestUrl);
      }
    });

    await page.goto(`http://localhost:${port}/start`);
    await waitForHydration(page);
    expect(prefetchedViewRequests).toHaveLength(0);

    await page.getByTestId('prefetch-on-view-link').scrollIntoViewIfNeeded();
    await expect.poll(() => prefetchedViewRequests.length).toBeGreaterThan(0);
    const afterPrefetchCount = prefetchedViewRequests.length;

    await page.getByTestId('prefetch-on-view-link').click();
    await expect(
      page.getByRole('heading', { name: 'View Target' }),
    ).toBeVisible();
    expect(prefetchedViewRequests).toHaveLength(afterPrefetchCount);
  });

  // The prefetch also warms the route's client chunk: decoding the prefetched
  // RSC pulls /view-target's client component, so clicking loads no new JS.
  // Regression test for https://github.com/wakujs/waku/issues/2099.
  test(
    'unstable_prefetchOnView warms the route client chunk',
    { tag: '@prd' },
    async ({ page }) => {
      const jsUrls: string[] = [];
      page.on('request', (request) => {
        const url = request.url();
        if (request.method() === 'GET' && url.endsWith('.js')) {
          jsUrls.push(url);
        }
      });

      await page.goto(`http://localhost:${port}/start`);
      await waitForHydration(page);
      // /view-target's chunk is not used on /start, so it is not loaded yet.
      const initialJs = new Set(jsUrls);

      await page.getByTestId('prefetch-on-view-link').scrollIntoViewIfNeeded();
      // The prefetch fetches and decodes the route, pulling its client chunk.
      await expect.poll(() => jsUrls.some((u) => !initialJs.has(u))).toBe(true);

      const beforeClick = new Set(jsUrls);
      await page.getByTestId('prefetch-on-view-link').click();
      await expect(page.getByTestId('view-target-marker')).toBeVisible();

      const newJsOnClick = jsUrls.filter((u) => !beforeClick.has(u));
      expect(newJsOnClick).toEqual([]);
    },
  );

  test('unstable_prefetchOnEnter triggers prefetch on hover', async ({
    page,
  }) => {
    const prefetchedEnterRequests: string[] = [];
    page.on('request', (request) => {
      const requestUrl = request.url();
      if (
        request.method() === 'GET' &&
        requestUrl.includes('/RSC/R/next.txt')
      ) {
        prefetchedEnterRequests.push(requestUrl);
      }
    });

    await page.goto(`http://localhost:${port}/start`);
    await waitForHydration(page);
    expect(prefetchedEnterRequests).toHaveLength(0);

    // React mounts on body here, so a pointer coming from <html> never enters.
    await page.getByRole('heading', { name: 'Start' }).hover();
    await page.getByTestId('prefetch-on-enter-link').hover();
    await expect.poll(() => prefetchedEnterRequests.length).toBeGreaterThan(0);
    await expect(page.getByRole('heading', { name: 'Start' })).toBeVisible();
  });

  test('useNavigationStatus pending reflects async transition state', async ({
    page,
  }) => {
    await page.route('**/RSC/R/next.txt**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.continue();
    });

    await page.goto(`http://localhost:${port}/start`);
    await waitForHydration(page);
    await expect(page.getByTestId('not-pending-indicator')).toBeVisible();

    // Dispatched, because some browsers make click() wait for the navigation.
    await page.getByTestId('pending-link').dispatchEvent('click');
    await expect(page.getByTestId('pending-indicator')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Next' })).toBeVisible();
    await expect(page.getByTestId('pending-indicator')).toHaveCount(0);
  });

  test('pending stays until a client-only async resolves, not just data loading', async ({
    page,
  }) => {
    // The target route's RSC loads normally, but it renders a client component
    // that suspends with no data fetch. Pending must persist until that
    // client-only async resolves, proving it tracks the transition.
    await page.goto(`http://localhost:${port}/start`);
    await waitForHydration(page);

    const rscResponse = page.waitForResponse('**/RSC/R/pending-client.txt**');
    await page.getByTestId('pending-client-link').click();

    // Once the RSC has arrived the router's data loading is done, yet the
    // pending indicator must STILL be visible because the client component is
    // suspended. This is the load-bearing assertion: a data-loading-only
    // implementation would have cleared pending by now.
    await rscResponse;
    await expect(page.getByTestId('pending-client-indicator')).toBeVisible();
    await expect(page.getByTestId('client-suspense-content')).toHaveCount(0);

    // The destination is held by the transition: the previous page stays
    // mounted and visible while the suspending route does not commit (no
    // Suspense fallback flash). This only holds because changeRoute re-wraps the
    // post-fetch commit in startTransition (React does not treat state updates
    // after an `await` inside startTransition as part of the transition).
    await expect(page.getByRole('heading', { name: 'Start' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Pending Client' }),
    ).toHaveCount(0);

    // Release the client-only async from the still-mounted start page; the
    // transition settles, the destination commits, and pending clears.
    await page.getByTestId('resolve-client-suspense').click();
    await expect(page.getByTestId('client-suspense-content')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Pending Client' }),
    ).toBeVisible();
    await expect(page.getByTestId('pending-client-indicator')).toHaveCount(0);
  });

  test('client notFound navigation uses /404 page content when present', async ({
    page,
  }) => {
    await page.goto(`http://localhost:${port}/start`);
    await waitForHydration(page);

    await page.getByTestId('go-trigger-not-found').click();

    await expect(
      page.getByRole('heading', { name: 'Custom 404' }),
    ).toBeVisible();
    await expect(page.getByTestId('route-path')).toHaveText('/404');
    await expect(page.getByTestId('route-query')).toHaveText('');
    await expect(page).toHaveURL(/\/trigger-not-found$/);
  });

  test('client redirect navigation resolves to target and replaces history entry', async ({
    page,
  }) => {
    await page.goto(`http://localhost:${port}/start`);
    await waitForHydration(page);

    await page.getByTestId('go-trigger-redirect').click();

    await expect(page.getByRole('heading', { name: 'Next' })).toBeVisible();
    await expect(page.getByTestId('route-path')).toHaveText('/next');
    await expect(page.getByTestId('route-query')).toHaveText('from=redirect');
    await expect(page).toHaveURL(/\/next\?from=redirect$/);

    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Start' })).toBeVisible();
    await expect(page).toHaveURL(/\/start$/);
  });

  test('client navigation to missing route with /404 page renders /404 content', async ({
    page,
  }) => {
    await page.goto(`http://localhost:${port}/start`);
    await waitForHydration(page);

    await page.getByTestId('go-missing').click();

    await expect(
      page.getByRole('heading', { name: 'Custom 404' }),
    ).toBeVisible();
    await expect(page.getByTestId('route-path')).toHaveText('/404');
    await expect(page).toHaveURL(/\/missing$/);
  });
});
