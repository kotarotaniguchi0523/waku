import type { ReactNode } from 'react';
import { Link } from 'waku';
import {
  ActionPanel,
  BrowserOwned,
  Hydrated,
  LeaveDocument,
  RouteProbe,
} from '../components/probes.js';

const gatedIds = ['t01b', 't05b', 't06', 't06b', 't08', 'g2'];
const gatedChildIds = ['t04'];
const heldRequestIds = ['t01', 't05'];

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div>
      <title>navigation-contract</title>
      <nav>
        <Link to="/" data-testid="go-home">
          Home
        </Link>
        <Link to="/plain" data-testid="go-plain">
          Plain
        </Link>
        <Link to="/counter" data-testid="go-counter">
          Counter
        </Link>
        <Link to="/old" data-testid="go-old">
          Old
        </Link>
        {/* No such page exists, so the typed routes do not include it. */}
        <Link to={'/missing' as never} data-testid="go-missing">
          Missing
        </Link>
        <Link
          to="/gated-child-error?gate=g7"
          data-testid="go-gated-child-error"
        >
          Gated child error
        </Link>
        <Link to="/transition" data-testid="go-transition">
          Transition
        </Link>
        <Link to="/broken" data-testid="go-broken">
          Broken
        </Link>
        <Link to="/fragment#target" data-testid="go-fragment">
          Fragment
        </Link>
        {gatedIds.map((id) => (
          <Link
            key={id}
            to={`/gated?gate=${id}`}
            data-testid={`go-gated-${id}`}
          >
            Gated {id}
          </Link>
        ))}
        {heldRequestIds.map((id) => (
          <Link
            key={id}
            to={`/held-request?hold=${id}`}
            data-testid={`go-held-request-${id}`}
          >
            Held request {id}
          </Link>
        ))}
        {gatedChildIds.map((id) => (
          <Link
            key={id}
            to={`/gated-child?gate=${id}`}
            data-testid={`go-gated-child-${id}`}
          >
            Gated child {id}
          </Link>
        ))}
      </nav>
      <Hydrated />
      <RouteProbe />
      <ActionPanel />
      <LeaveDocument />
      <BrowserOwned />
      {children}
    </div>
  );
}

export const getConfig = () => ({ render: 'static' }) as const;
