import { getCount } from '../lib/counter.js';

let serverRenders = 0;

// `server-renders` grows by one each time the server renders this page,
// which makes a refetch visible without inspecting network traffic.
export default function CounterPage() {
  return (
    <div>
      <h1 data-testid="page">counter</h1>
      <p data-testid="count">{getCount()}</p>
      <p data-testid="server-renders">{++serverRenders}</p>
    </div>
  );
}

export const getConfig = () => ({ render: 'dynamic' }) as const;
