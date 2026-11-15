import { waitForGate } from '../lib/gate.js';

// The whole page waits for the gate, so its response is held until a spec opens it.
export default async function GatedPage({ query = '' }: { query?: string }) {
  await waitForGate(new URLSearchParams(query).get('gate') ?? '');
  return <h1 data-testid="page">gated</h1>;
}

export const getConfig = () => ({ render: 'dynamic' }) as const;
