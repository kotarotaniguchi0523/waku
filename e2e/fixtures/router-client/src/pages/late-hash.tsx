import { Suspense } from 'react';
import { RouteState } from '../components/route-state.js';

// Streams in after the page shell, so a fragment target inside it is not in
// the document when the navigation finishes.
async function LateTarget({ id, delay }: { id: string; delay: number }) {
  await new Promise((resolve) => setTimeout(resolve, delay));
  return (
    <div id={id} data-testid={id}>
      {id}
    </div>
  );
}

export default function LateHashPage() {
  return (
    <div>
      <h1>Late Hash</h1>
      <RouteState />
      <div style={{ minHeight: '200vh' }} />
      <Suspense fallback={<p>loading late-soon</p>}>
        <LateTarget id="late-soon" delay={500} />
      </Suspense>
      <Suspense fallback={<p>loading late-slow</p>}>
        <LateTarget id="late-slow" delay={1500} />
      </Suspense>
      <Suspense fallback={<p>loading late-never</p>}>
        <LateTarget id="late-never" delay={3000} />
      </Suspense>
      <div style={{ minHeight: '200vh' }} />
    </div>
  );
}

export const getConfig = () => {
  return {
    render: 'dynamic',
  } as const;
};
