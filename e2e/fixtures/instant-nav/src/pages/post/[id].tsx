import { Suspense } from 'react';
import { LateAnchor } from '../../components/late-anchor.js';
import type { PageProps } from 'waku/router';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function Post({ id }: PageProps<'/post/[id]'>) {
  await sleep(600);
  return (
    <div style={{ minHeight: '240vh', paddingTop: '120vh' }}>
      <div id={id === '2' ? 'post-anchor' : undefined} data-testid="post-body">
        Post {id}
      </div>
      {id === '2' && (
        <Suspense
          fallback={
            <p data-testid="late-anchor-fallback">Waiting for anchor</p>
          }
        >
          <LateAnchor />
        </Suspense>
      )}
    </div>
  );
}

export const getConfig = async () => {
  return {
    render: 'dynamic',
    // Etag keyed on the slug, so an instant revisit exercises dynamic-etag
    // handling: a stale cached etag must not skip a since-changed slot.
    unstable_getEtag: async ({ id }: { id: string }) => id,
  } as const;
};
