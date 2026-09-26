'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  fetchBalance,
  fetchDrops,
  fetchListings,
  fetchLoans,
  fetchMyClaims,
  fetchPassport,
  fetchPlans,
  fetchPool,
  fetchTerms,
  JUNIOR_LP_TYPE,
  SENIOR_LP_TYPE,
} from './chain';

const LIVE = { refetchInterval: 5_000 };

export const useDrops = () => useQuery({ queryKey: ['drops'], queryFn: fetchDrops, ...LIVE });
export const usePlans = () => useQuery({ queryKey: ['plans'], queryFn: fetchPlans, ...LIVE });
export const useListings = () => useQuery({ queryKey: ['listings'], queryFn: fetchListings, ...LIVE });
export const usePool = () => useQuery({ queryKey: ['pool'], queryFn: fetchPool, ...LIVE });

export const useMyClaims = (owner?: string) =>
  useQuery({ queryKey: ['claims', owner], queryFn: () => fetchMyClaims(owner!), enabled: !!owner, ...LIVE });

export const usePassport = (humanKey?: string) =>
  useQuery({ queryKey: ['passport', humanKey], queryFn: () => fetchPassport(humanKey!), enabled: !!humanKey, ...LIVE });

export function useLoans() {
  const pool = usePool();
  return useQuery({ queryKey: ['loans', pool.data?.loans.size], queryFn: () => fetchLoans(pool.data!), enabled: !!pool.data, ...LIVE });
}

export function useTerms(humanKey?: string) {
  const pool = usePool();
  return useQuery({ queryKey: ['terms', humanKey], queryFn: () => fetchTerms(pool.data!, humanKey!), enabled: !!pool.data && !!humanKey, ...LIVE });
}

export function useBalances(owner?: string) {
  return useQuery({
    queryKey: ['balances', owner],
    queryFn: async () => ({
      sui: await fetchBalance(owner!, '0x2::sui::SUI'),
      senior: await fetchBalance(owner!, SENIOR_LP_TYPE),
      junior: await fetchBalance(owner!, JUNIOR_LP_TYPE),
    }),
    enabled: !!owner,
    ...LIVE,
  });
}

/** Current time, ticking every second (for deadlines). */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function countdown(targetMs: number, now: number): string {
  const s = Math.max(0, Math.round((targetMs - now) / 1000));
  if (s === 0) return 'now';
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}
