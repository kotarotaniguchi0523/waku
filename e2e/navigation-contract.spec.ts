import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { prepareNormalSetup, test } from './utils.js';

// Behaviour contract for client navigation, written against what a user and
// application code can observe: the address bar, the visible content, scroll,
// Back/Forward, and the public router API. The specs do not know how the
// router fetches or stores anything; timing is controlled through gates that
// the fixture's own server components wait on.

const startApp = prepareNormalSetup('navigation-contract');

test.describe('navigation-contract', () => {
  let port: number;
  let stopApp: () => Promise<void>;

  test.beforeAll(async ({ mode }) => {
    ({ port, stopApp } = await startApp(mode));
  });

  test.afterAll(async () => {
    await stopApp();
  });

  const origin = () => `http://localhost:${port}`;

  const open = async (page: Page, path: string) => {
    await page.goto(`${origin()}${path}`);
    await expect(page.getByTestId('hydrated')).toHaveText('yes');
  };

  const gateIsWaiting = async (page: Page, id: string) => {
    const response = await page.request.get(`${origin()}/gate?id=${id}`);
    return ((await response.json()) as { waiting: boolean }).waiting;
  };

  // Resolves once a render is held at the gate, i.e. the request it belongs
  // to has reached the server and is not finished.
  const waitUntilHeld = (page: Page, id: string) =>
    expect.poll(() => gateIsWaiting(page, id)).toBe(true);

  const releaseGate = (page: Page, id: string) =>
    page.request.post(`${origin()}/gate?id=${id}`);

  const shownPage = (page: Page) => page.getByTestId('page');

  test('a link shows the destination and moves the address bar', async ({
    page,
  }) => {
    await open(page, '/');
    await page.getByTestId('go-plain').click();
    await expect(shownPage(page)).toHaveText('plain');
    await expect(page).toHaveURL(`${origin()}/plain`);
    await expect(page.getByTestId('route-path')).toHaveText('/plain');
  });

  test('T01: while the request for the destination is held, the address bar and content stay; then both move', async ({
    page,
  }) => {
    await open(page, '/');
    await page.getByTestId('go-held-request-t01').click();
    await waitUntilHeld(page, 't01');
    await expect(page).toHaveURL(`${origin()}/`);
    await expect(shownPage(page)).toHaveText('home');
    await releaseGate(page, 't01');
    await expect(shownPage(page)).toHaveText('held-request');
    await expect(page).toHaveURL(`${origin()}/held-request?hold=t01`);
  });

  test('T01: once the destination has responded, the address bar moves while the old content stays until the new is ready', async ({
    page,
  }) => {
    await open(page, '/');
    await page.getByTestId('go-gated-t01b').click();
    await waitUntilHeld(page, 't01b');
    await expect(page).toHaveURL(`${origin()}/gated?gate=t01b`);
    await expect(shownPage(page)).toHaveText('home');
    await releaseGate(page, 't01b');
    await expect(shownPage(page)).toHaveText('gated');
    await expect(page).toHaveURL(`${origin()}/gated?gate=t01b`);
  });

  test('T02: a redirect lands on the final URL and Back skips the redirecting URL', async ({
    page,
  }) => {
    await open(page, '/');
    await page.getByTestId('go-old').click();
    await expect(shownPage(page)).toHaveText('plain');
    await expect(page).toHaveURL(`${origin()}/plain`);
    await page.goBack();
    await expect(shownPage(page)).toHaveText('home');
    await expect(page).toHaveURL(`${origin()}/`);
  });

  test('T03: a missing route shows the 404 page and keeps the requested URL', async ({
    page,
  }) => {
    await open(page, '/');
    await page.getByTestId('go-missing').click();
    await expect(shownPage(page)).toHaveText('not-found');
    await expect(page).toHaveURL(`${origin()}/missing`);
  });

  test('T04: leaving a page whose content is still arriving shows the next page and nothing of the old one', async ({
    page,
  }) => {
    await open(page, '/');
    await page.getByTestId('go-gated-child-t04').click();
    await expect(shownPage(page)).toHaveText('gated-child');
    await expect(page.getByTestId('gated-child-fallback')).toBeVisible();
    await page.getByTestId('go-plain').click();
    await expect(shownPage(page)).toHaveText('plain');
    await releaseGate(page, 't04');
    // A further navigation gives the late content time to arrive.
    await page.getByTestId('go-counter').click();
    await expect(shownPage(page)).toHaveText('counter');
    await expect(page.getByTestId('gated-child-content')).toHaveCount(0);
    await expect(page.getByTestId('gated-child-fallback')).toHaveCount(0);
    await expect(page).toHaveURL(`${origin()}/counter`);
  });

  test('T05: Back while the request is held returns to the previous entry and the held page never appears', async ({
    page,
  }) => {
    await open(page, '/');
    await page.getByTestId('go-plain').click();
    await expect(shownPage(page)).toHaveText('plain');
    await page.getByTestId('go-held-request-t05').click();
    await waitUntilHeld(page, 't05');
    await page.goBack();
    await expect(shownPage(page)).toHaveText('home');
    await expect(page).toHaveURL(`${origin()}/`);
    await releaseGate(page, 't05');
    await page.getByTestId('go-counter').click();
    await expect(shownPage(page)).toHaveText('counter');
    await expect(page).toHaveURL(`${origin()}/counter`);
  });

  test('T05: Back after the address bar moved returns to the page still on screen and the held page never appears', async ({
    page,
  }) => {
    await open(page, '/');
    await page.getByTestId('go-plain').click();
    await expect(shownPage(page)).toHaveText('plain');
    await page.getByTestId('go-gated-t05b').click();
    await waitUntilHeld(page, 't05b');
    await expect(page).toHaveURL(`${origin()}/gated?gate=t05b`);
    await page.goBack();
    await expect(page).toHaveURL(`${origin()}/plain`);
    await expect(shownPage(page)).toHaveText('plain');
    await releaseGate(page, 't05b');
    await page.getByTestId('go-counter').click();
    await expect(shownPage(page)).toHaveText('counter');
    await expect(page).toHaveURL(`${origin()}/counter`);
  });

  test('T06: an action during a held navigation returns its value, and the navigation still arrives', async ({
    page,
  }) => {
    await open(page, '/counter');
    const before = Number(await page.getByTestId('count').textContent());
    await page.getByTestId('go-gated-t06').click();
    await waitUntilHeld(page, 't06');
    await page.getByTestId('run-increment').click();
    await expect(page.getByTestId('action-result')).toHaveText(
      String(before + 1),
    );
    await expect(shownPage(page)).toHaveText('counter');
    await releaseGate(page, 't06');
    await expect(shownPage(page)).toHaveText('gated');
    await expect(page).toHaveURL(`${origin()}/gated?gate=t06`);
    await page.getByTestId('go-counter').click();
    await expect(page.getByTestId('count')).toHaveText(String(before + 1));
  });

  test('T06: when a held navigation is abandoned, an action update made meanwhile is shown', async ({
    page,
  }) => {
    await open(page, '/');
    await page.getByTestId('go-counter').click();
    await expect(shownPage(page)).toHaveText('counter');
    const before = Number(await page.getByTestId('count').textContent());
    await page.getByTestId('go-gated-t06b').click();
    await waitUntilHeld(page, 't06b');
    await page.getByTestId('run-increment').click();
    await expect(page.getByTestId('action-result')).toHaveText(
      String(before + 1),
    );
    await page.goBack();
    await expect(page).toHaveURL(`${origin()}/counter`);
    await expect(shownPage(page)).toHaveText('counter');
    await expect(page.getByTestId('count')).toHaveText(String(before + 1));
    await releaseGate(page, 't06b');
    // A refresh round trip gives the abandoned response time to arrive.
    await page.getByTestId('run-increment').click();
    await expect(page.getByTestId('count')).toHaveText(String(before + 2));
    await expect(shownPage(page)).toHaveText('counter');
    await expect(page).toHaveURL(`${origin()}/counter`);
  });

  test('a fragment change after the address bar moved does not strand the old content', async ({
    page,
  }) => {
    await open(page, '/');
    await page.getByTestId('go-gated-g2').click();
    await waitUntilHeld(page, 'g2');
    await expect(page).toHaveURL(`${origin()}/gated?gate=g2`);
    await page.evaluate(() => {
      location.hash = 'later';
    });
    await expect(page).toHaveURL(`${origin()}/gated?gate=g2#later`);
    await releaseGate(page, 'g2');
    await expect(shownPage(page)).toHaveText('gated');
    await expect(page.getByTestId('route-hash')).toHaveText('#later');
  });

  test('T07: an action that finishes after leaving its page returns its value and leaves the new page alone', async ({
    page,
  }) => {
    await open(page, '/counter');
    await page.getByTestId('run-gated-increment-t07').click();
    await waitUntilHeld(page, 't07');
    await page.getByTestId('go-plain').click();
    await expect(shownPage(page)).toHaveText('plain');
    await releaseGate(page, 't07');
    await expect(page.getByTestId('action-result')).not.toHaveText('none');
    await expect(shownPage(page)).toHaveText('plain');
    await expect(page).toHaveURL(`${origin()}/plain`);
  });

  test('T09: a refresh from an action updates the data and nothing else', async ({
    page,
  }) => {
    await open(page, '/counter');
    const before = Number(await page.getByTestId('count').textContent());
    const historyLength = await page.evaluate(() => history.length);
    await page.getByTestId('run-increment').click();
    await expect(page.getByTestId('count')).toHaveText(String(before + 1));
    await expect(page.getByTestId('action-result')).toHaveText(
      String(before + 1),
    );
    await expect(page).toHaveURL(`${origin()}/counter`);
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
  });

  test('T10: changing only the entry state does not refetch the page', async ({
    page,
  }) => {
    await open(page, '/counter');
    const renders = Number(
      await page.getByTestId('server-renders').textContent(),
    );
    await page.evaluate(() =>
      window.navigation.updateCurrentEntry({ state: { note: 'changed' } }),
    );
    // One refresh follows; an extra refetch would make the number jump by two.
    await page.getByTestId('run-increment').click();
    await expect(page.getByTestId('action-result')).not.toHaveText('none');
    await expect(page.getByTestId('server-renders')).toHaveText(
      String(renders + 1),
    );
    expect(
      await page.evaluate(() => window.navigation.currentEntry?.getState()),
    ).toEqual({ note: 'changed' });
  });

  test('T11: a fragment link scrolls to its target and Back restores the position', async ({
    page,
  }) => {
    await open(page, '/');
    await page.getByTestId('go-fragment').click();
    await expect(shownPage(page)).toHaveText('fragment');
    await expect(page.getByTestId('fragment-target')).toBeInViewport();
    await expect(page.getByTestId('route-hash')).toHaveText('#target');
    await page.goBack();
    await expect(shownPage(page)).toHaveText('home');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  });

  test('T12: after cancelling a document unload, in-app navigation still works', async ({
    page,
  }) => {
    await open(page, '/');
    await page.getByTestId('arm-leave-confirmation').click();
    let dismissed = 0;
    page.on('dialog', (dialog) => {
      dismissed += 1;
      void dialog.dismiss();
    });
    await page.getByTestId('leave-document').click();
    await expect.poll(() => dismissed).toBe(1);
    await expect(page).toHaveURL(`${origin()}/`);
    await expect(shownPage(page)).toHaveText('home');
    await page.getByTestId('go-plain').click();
    await expect(shownPage(page)).toHaveText('plain');
    await expect(page).toHaveURL(`${origin()}/plain`);
  });

  test('T13: code after awaiting router.push inside an async action runs', async ({
    page,
  }) => {
    await open(page, '/');
    await page.getByTestId('push-in-action').click();
    await expect(page.getByTestId('push-result')).toHaveText('continued');
    await expect(shownPage(page)).toHaveText('plain');
    await expect(page).toHaveURL(`${origin()}/plain`);
  });

  // The address bar expectation records today's policy: a navigation whose
  // page fails moves to the failed URL and shows an error there.
  test('T17: after a navigation fails, Back returns to a working page', async ({
    page,
  }) => {
    await open(page, '/');
    await page.getByTestId('go-plain').click();
    await expect(shownPage(page)).toHaveText('plain');
    await page.getByTestId('go-broken').click();
    await expect(page).toHaveURL(`${origin()}/broken`);
    await expect(shownPage(page)).toHaveCount(0);
    await page.goBack();
    await expect(shownPage(page)).toHaveText('plain');
    await expect(page).toHaveURL(`${origin()}/plain`);
    await page.getByTestId('go-home').click();
    await expect(shownPage(page)).toHaveText('home');
    await expect(page).toHaveURL(`${origin()}/`);
  });

  test('T15: opening a URL with query and hash hydrates and reports both', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await open(page, '/fragment?view=full#target');
    await expect(shownPage(page)).toHaveText('fragment');
    await expect(page.getByTestId('route-path')).toHaveText('/fragment');
    await expect(page.getByTestId('route-query')).toHaveText('view=full');
    await expect(page.getByTestId('route-hash')).toHaveText('#target');
    await expect(page.getByTestId('fragment-target')).toBeInViewport();
    expect(errors).toEqual([]);
  });
});
