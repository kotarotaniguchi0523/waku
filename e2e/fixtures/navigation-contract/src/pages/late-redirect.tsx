import { Suspense } from 'react';
import { requestRedirect } from 'waku/router/server';
import { waitForGate } from '../lib/gate.js';

// Asks for the redirect only after the gate opens, when the page is already
// on screen. The marker renders after the request, so once it shows the
// redirect has reached the browser.
const LateRedirect = async ({ gateId }: { gateId: string }) => {
  await waitForGate(gateId);
  requestRedirect('/plain');
  return <p data-testid="late-redirect-sent">redirect requested</p>;
};

export default function LateRedirectPage({ query = '' }: { query?: string }) {
  const gateId = new URLSearchParams(query).get('gate') ?? '';
  return (
    <div>
      <h1 data-testid="page">late-redirect</h1>
      <p id="details">details</p>
      <Suspense fallback={null}>
        <LateRedirect gateId={gateId} />
      </Suspense>
    </div>
  );
}

export const getConfig = () => ({ render: 'dynamic' }) as const;
