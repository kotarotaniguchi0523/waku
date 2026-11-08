import { expect } from '@playwright/test';
import { prepareNormalSetup, test, waitForHydration } from './utils.js';

for (const link of ['plain', 'instant']) {
  test(`a cached post with a streamed fragment via a ${link} link`, async ({
    page,
    mode,
  }) => {
    const app = await prepareNormalSetup('instant-nav')(mode);
    try {
      await page.goto(`http://localhost:${app.port}/post/1`);
      await waitForHydration(page);
      await page.getByTestId('link-plain-post-2').click();
      await expect(page.getByTestId('post-body')).toHaveText('Post 2');
      await page.getByTestId('link-post-1').click();
      await expect(page.getByTestId('post-body')).toHaveText('Post 1');

      await page.getByTestId(`link-${link}-anchor`).click();
      await expect(page).toHaveURL(/\/post\/2#post-anchor$/);
      await expect(page.getByTestId('post-body')).toHaveText('Post 2');
      await expect
        .poll(() =>
          page.evaluate(() => {
            const target = document.querySelector('#post-anchor');
            return Math.abs(target?.getBoundingClientRect().top ?? Infinity);
          }),
        )
        .toBeLessThan(2);
    } finally {
      await app.stopApp();
    }
  });
}

for (const behavior of ['scroll', 'supersede', 'no-scroll']) {
  test(`a fragment inside Suspense: ${behavior}`, async ({ page, mode }) => {
    const { port, stopApp } = await prepareNormalSetup('instant-nav')(mode);
    const nextRequest = Promise.withResolvers<void>();
    const releaseNext = Promise.withResolvers<void>();
    try {
      await page.goto(`http://localhost:${port}/post/1`);
      await waitForHydration(page);
      await page.evaluate(() => {
        const gate = Promise.withResolvers<void>();
        Reflect.set(window, '__wakuAnchorGate', gate.promise);
        Reflect.set(window, '__releaseWakuAnchor', gate.resolve);
      });

      const link =
        behavior === 'no-scroll'
          ? 'link-late-anchor-no-scroll'
          : 'link-late-anchor';
      await page.getByTestId(link).click();
      await expect(page).toHaveURL(/\/post\/2#late-anchor$/);
      await expect(page.getByTestId('late-anchor-fallback')).toBeVisible();
      const target = page.locator('#late-anchor');
      await expect(target).toHaveCount(0);

      if (behavior === 'supersede') {
        await page.route('**/RSC/R/post/3.txt*', async (route) => {
          nextRequest.resolve();
          await releaseNext.promise;
          await route.continue();
        });
        await page.getByTestId('link-post-3').click();
        await nextRequest.promise;
        // A newer request owns navigation even while the old URL is visible.
        await expect(page).toHaveURL(/\/post\/2#late-anchor$/);
      }
      await page.evaluate(() => Reflect.get(window, '__releaseWakuAnchor')());
      await expect(target).toBeVisible();
      if (behavior === 'scroll') {
        await expect(target).toBeInViewport();
        await page.evaluate(() => {
          window.scrollTo(0, 0);
          document.body.appendChild(document.createElement('div'));
        });
      }
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      await expect(target).not.toBeInViewport();

      if (behavior === 'supersede') {
        releaseNext.resolve();
        await expect(page).toHaveURL(/\/post\/3$/);
      }
    } finally {
      releaseNext.resolve();
      await stopApp();
    }
  });
}
