// @vitest-environment happy-dom

import {
  StrictMode,
  Suspense,
  act,
  startTransition,
  use,
  useLayoutEffect,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { clearInitialRscEntries } from '../src/minimal/client-utils/initial-rsc-store.js';
import {
  ControlledRoot_UNSTABLE as ControlledRoot,
  Slot_UNSTABLE as Slot,
  useElementsPromise_UNSTABLE as useElementsPromise,
  useInitialElements_UNSTABLE as useInitialElements,
  useMergeElements_UNSTABLE as useMergeElements,
} from '../src/minimal/client.js';

type Elements = Readonly<Record<string | symbol, unknown>>;

const mocks = vi.hoisted(() => ({
  initial: {} as Elements,
}));
vi.mock('react-server-dom-webpack/client', () => ({
  default: {
    createFromFetch: (response: Promise<Response>) =>
      response.then(() => mocks.initial),
    encodeReply: async () => '',
    createTemporaryReferenceSet: () => new Map(),
  },
}));

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// What the owner of the element state keeps beside the elements.
type Frame = { label: string; elements: Promise<Elements> };

let root: ReturnType<typeof createRoot> | undefined;
let setFrame: (update: (prev: Frame) => Frame) => void;
let merge: ReturnType<typeof useMergeElements>;
// Every (label, page) pair that reached a commit, in order.
let committed: string[];

const Committed = ({ label }: { label: string }) => {
  const mergeElements = useMergeElements();
  const page = String(use(useElementsPromise()).page);
  useLayoutEffect(() => {
    merge = mergeElements;
    committed.push(`${label}:${page}`);
  });
  return <output>{`${label}:${page}`}</output>;
};

const Owner = ({ children }: { children?: ReactNode }) => {
  const initial = useInitialElements('initial');
  const [frame, setFrameState] = useState<Frame>({
    label: 'first',
    elements: initial.elements,
  });
  useLayoutEffect(() => {
    setFrame = setFrameState;
  }, []);
  const [updateElements] = useState(
    () => (update: (prev: Promise<Elements>) => Promise<Elements>) =>
      setFrameState((prev) => ({ ...prev, elements: update(prev.elements) })),
  );
  return (
    <ControlledRoot
      initial={initial}
      elements={frame.elements}
      updateElements={updateElements}
    >
      <Committed label={frame.label} />
      {children}
    </ControlledRoot>
  );
};

const mount = async (children?: ReactNode) => {
  const container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <StrictMode>
        <Suspense fallback="loading">
          <Owner>{children}</Owner>
        </Suspense>
      </StrictMode>,
    );
    await flush();
  });
  return container;
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', async () => new Response('{}'));
  clearInitialRscEntries();
  committed = [];
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  clearInitialRscEntries();
  vi.unstubAllGlobals();
});

test('the owner seeds the elements and slots render them', async () => {
  mocks.initial = { page: 'one' };
  const view = await mount(<Slot id="page" />);
  expect(view.querySelector('output')?.textContent).toBe('first:one');
  expect(view.textContent).toContain('one');
});

test('a merge through the Root lands in the owner state', async () => {
  mocks.initial = { page: 'one', kept: 'yes' };
  const view = await mount();
  await act(async () => {
    void merge({ page: 'two' });
    await flush();
  });
  expect(view.querySelector('output')?.textContent).toBe('first:two');
});

test('the owner changes its own state and the elements in one commit', async () => {
  mocks.initial = { page: 'one' };
  const view = await mount();
  committed = [];
  await act(async () => {
    setFrame((prev) => ({
      label: 'second',
      elements: prev.elements.then((elements) => ({
        ...elements,
        page: 'two',
      })),
    }));
    await flush();
  });
  expect(view.querySelector('output')?.textContent).toBe('second:two');
  // No commit paired the new label with the old page, or the reverse.
  expect(new Set(committed)).toEqual(new Set(['second:two']));
});

test('a merge queued before an owner update is not lost by it', async () => {
  mocks.initial = { page: 'one', extra: 'none' };
  const view = await mount(<Slot id="extra" />);
  const pending = Promise.withResolvers<Elements>();
  await act(async () => {
    // Transitions keep the current content while the merge is pending.
    startTransition(() => {
      void merge(pending.promise);
      setFrame((prev) => ({
        label: 'second',
        elements: prev.elements.then((elements) => ({
          ...elements,
          page: 'two',
        })),
      }));
    });
    await flush();
  });
  expect(view.querySelector('output')?.textContent).toBe('first:one');
  await act(async () => {
    pending.resolve({ extra: 'merged' });
    await flush();
  });
  expect(view.querySelector('output')?.textContent).toBe('second:two');
  expect(view.textContent).toContain('merged');
});
