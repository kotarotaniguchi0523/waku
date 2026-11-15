export default function PlainPage() {
  return <h1 data-testid="page">plain</h1>;
}

export const getConfig = () => ({ render: 'dynamic' }) as const;
