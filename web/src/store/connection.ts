import { create } from 'zustand';
import type { ConnState } from '../lib/ws';

export const useConnection = create<ConnState>()(() => ({
  status: 'connecting',
  retryAt: null,
  attempts: 0,
  lastError: null,
  everLive: false,
}));
