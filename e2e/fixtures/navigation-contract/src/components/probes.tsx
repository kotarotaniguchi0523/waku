'use client';

import { useState, useSyncExternalStore, useTransition } from 'react';
import { useRouter } from 'waku';
import {
  gatedIncrement,
  increment,
  incrementAndRerender,
  refreshIntoFailure,
} from '../lib/actions.js';

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
      {['t07', 't08a', 't08b'].map((gateId) => (
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
      <button
        type="button"
        data-testid="run-increment-and-rerender"
        onClick={async () => {
          setActionResult(String(await incrementAndRerender()));
        }}
      >
        Increment and rerender
      </button>
      <button
        type="button"
        data-testid="run-refresh-into-failure"
        onClick={async () => {
          setActionResult(await refreshIntoFailure());
        }}
      >
        Refresh into failure
      </button>
      <p data-testid="action-result">{actionResult}</p>
    </div>
  );
};

// Asks for confirmation before the document unloads, then offers a link that
// leaves this document by going to another origin.
export const LeaveDocument = () => {
  const [armed, setArmed] = useState(false);
  const [otherOrigin, setOtherOrigin] = useState('');
  return (
    <div>
      <button
        type="button"
        data-testid="arm-leave-confirmation"
        onClick={() => {
          window.addEventListener('beforeunload', (event) => {
            event.preventDefault();
          });
          // localhost and 127.0.0.1 are the same server but different origins.
          setOtherOrigin(`http://127.0.0.1:${location.port}/plain`);
          setArmed(true);
        }}
      >
        Confirm before leaving
      </button>
      {armed && (
        <a href={otherOrigin} data-testid="leave-document">
          Leave this document
        </a>
      )}
    </div>
  );
};

// Things the browser handles on its own: a download and a form post.
export const BrowserOwned = () => (
  <div>
    <a href="/file" download="file.txt" data-testid="download-link">
      Download
    </a>
    <a href="/plain" data-testid="plain-anchor">
      Plain anchor
    </a>
    <a href="/file" rel="external" data-testid="external-anchor">
      External anchor
    </a>
    <form method="post" action="/echo">
      <input type="hidden" name="message" value="posted" />
      <button type="submit" data-testid="post-form">
        Post form
      </button>
    </form>
    <form method="get" action="/plain">
      <input type="hidden" name="from" value="form" />
      <button type="submit" data-testid="get-form">
        Get form
      </button>
    </form>
  </div>
);
