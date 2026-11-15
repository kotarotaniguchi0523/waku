export default function FragmentPage() {
  return (
    <div>
      <h1 data-testid="page">fragment</h1>
      <div style={{ height: 3000 }} />
      <h2 id="target" data-testid="fragment-target">
        Target
      </h2>
      <div style={{ height: 3000 }} />
    </div>
  );
}

export const getConfig = () => ({ render: 'dynamic' }) as const;
