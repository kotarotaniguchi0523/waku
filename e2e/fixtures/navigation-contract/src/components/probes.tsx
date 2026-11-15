'use client';

import { useState, useSyncExternalStore, useTransition } from 'react';
import { useRouter } from 'waku';
import { gatedIncrement, increment } from '../lib/actions.js';

const subscribeNever = () => () => {};

// Visible signal that the page is interactive.
export const Hydrated = () => {
  const hydrated = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
  return <p data-testid="hydrated">{hydrated ? 'yes' : 'no'}</p>;
};

// What the public router hook reports.
export const RouteProbe = () => {
  const router = useRouter();
  return (
    <dl>
      <dt>path</dt>
      <dd data-testid="route-path">{router.path}</dd>
      <dt>query</dt>
      <dd data-testid="route-query">{router.query}</dd>
      <dt>hash</dt>
      <dd data-testid="route-hash">{router.hash}</dd>
    </dl>
  );
};

// Lives in the layout, so it stays mounted across navigations.
export const ActionPanel = () => {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [pushResult, setPushResult] = useState('idle');
  const [actionResult, setActionResult] = useState('none');
  return (
    <div>
      <button
        type="button"
        data-testid="push-in-action"
        onClick={() =>
          startTransition(async () => {
            await router.push('/plain');
            setPushResult('continued');
          })
        }
      >
        Push inside an async action
      </button>
      <p data-testid="push-result">{pushResult}</p>
      <button
        type="button"
        data-testid="run-increment"
        onClick={async () => {
          setActionResult(String(await increment()));
        }}
      >
        Increment
      </button>
      {['t07'].map((gateId) => (
        <button
          key={gateId}
          type="button"
          data-testid={`run-gated-increment-${gateId}`}
          onClick={async () => {
            setActionResult(String(await gatedIncrement(gateId)));
          }}
        >
          Gated increment {gateId}
        </button>
      ))}
      <p data-testid="action-result">{actionResult}</p>
    </div>
  );
};
