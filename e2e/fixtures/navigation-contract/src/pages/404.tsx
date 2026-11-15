export default function NotFoundPage() {
  return <h1 data-testid="page">not-found</h1>;
}

export const getConfig = () => ({ render: 'dynamic' }) as const;
