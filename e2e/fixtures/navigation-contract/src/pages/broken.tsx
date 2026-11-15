// Fails on the server every time it is rendered.
export default function BrokenPage(): never {
  throw new Error('broken page');
}

export const getConfig = () => ({ render: 'dynamic' }) as const;
