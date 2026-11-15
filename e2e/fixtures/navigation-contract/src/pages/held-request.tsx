// Requests for this page carry `hold=<id>` and are held by the middleware.
export default function HeldRequestPage() {
  return <h1 data-testid="page">held-request</h1>;
}

export const getConfig = () => ({ render: 'dynamic' }) as const;
