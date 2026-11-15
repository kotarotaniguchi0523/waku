import { Animated } from '../components/transition.js';

export default function TransitionPage() {
  return (
    <Animated>
      <h1 data-testid="page">transition</h1>
    </Animated>
  );
}

export const getConfig = () => ({ render: 'dynamic' }) as const;
