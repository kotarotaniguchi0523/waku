import { Suspense } from 'react';
import { waitForGate } from '../lib/gate.js';

const Child = async ({ gateId }: { gateId: string }) => {
  await waitForGate(gateId);
  return <p data-testid="gated-child-content">child arrived</p>;
};

// The page shell renders at once; only the child waits for the gate.
export default function GatedChildPage({ query = '' }: { query?: string }) {
  const gateId = new URLSearchParams(query).get('gate') ?? '';
  return (
    <div>
      <h1 data-testid="page">gated-child</h1>
      <Suspense fallback={<p data-testid="gated-child-fallback">loading</p>}>
        <Child gateId={gateId} />
      </Suspense>
    </div>
  );
}

export const getConfig = () => ({ render: 'dynamic' }) as const;
