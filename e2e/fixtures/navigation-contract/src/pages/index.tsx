export default function HomePage() {
  return <h1 data-testid="page">home</h1>;
}

export const getConfig = () => ({ render: 'dynamic' }) as const;
