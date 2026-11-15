import { unstable_redirect as redirect } from 'waku/router/server';

export default function OldPage() {
  redirect('/plain');
}

export const getConfig = () => ({ render: 'dynamic' }) as const;
