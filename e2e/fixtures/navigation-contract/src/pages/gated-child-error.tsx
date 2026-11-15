import { Suspense } from 'react';
import { waitForGate } from '../lib/gate.js';

const FailingChild = async ({ gateId }: { gateId: string }): Promise<never> => {
  await waitForGate(gateId);
  throw new Error('late failure');
};

// The page shell renders at once; its child fails after the gate opens, when
// the shell is already on screen.
export default function GatedChildErrorPage({
  query = '',
}: {
  query?: string;
}) {
  const gateId = new URLSearchParams(query).get('gate') ?? '';
  return (
    <div>
      <h1 data-testid="page">gated-child-error</h1>
      <Suspense fallback={<p data-testid="gated-child-fallback">loading</p>}>
        <FailingChild gateId={gateId} />
      </Suspense>
    </div>
  );
}

export const getConfig = () => ({ render: 'dynamic' }) as const;
