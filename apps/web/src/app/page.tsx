'use client';

import dynamic from 'next/dynamic';

// The Sui wallet kit and IDKit widget need browser APIs (window, wallet-standard registry),
// so the app renders client-side only.
const ScalplessApp = dynamic(() => import('../components/ScalplessApp'), { ssr: false });

export default function Page() {
  return <ScalplessApp />;
}
