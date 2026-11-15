'use client';

import { ViewTransition } from 'react';
import type { ReactNode } from 'react';

// Animates its content when a navigation shows or hides it.
export const Animated = ({ children }: { children: ReactNode }) => (
  <ViewTransition>{children}</ViewTransition>
);
