'use client';

import React, { useState } from 'react';
import { ActionsProvider, TxToast } from './views/actions';
import { Providers } from '../app/providers';
import { ConnectButton } from '@mysten/dapp-kit-react/ui';
import { PACKAGE_ID } from '../lib/constants';
import { WorldIdButton } from './world/WorldIdButton';

import LandingView from './views/LandingView';
import FeaturedDropsView from './views/FeaturedDropsView';
import ResaleMarketView from './views/ResaleMarketView';
import WorldIdentityView from './views/WorldIdentityView';
import LoansAndEmiView from './views/LoansAndEmiView';
import MerchantView from './views/MerchantView';

const TABS = [
  { id: 'landing', label: '01 / LANDING' },
  { id: 'drops', label: '02 / DROPS' },
  { id: 'market', label: '03 / CLAIMS & RESALE' },
  { id: 'worldid', label: '04 / WORLD ID PASSPORT' },
  { id: 'loans', label: '05 / LENDING' },
  { id: 'merchant', label: '06 / MERCHANT' }
];

export default function ScalplessApp() {
  return (
    <Providers>
      <ScalplessShell />
    </Providers>
  );
}

function ScalplessShell() {
  // Shopify product pages link to /?drop=<id>: land shoppers straight on the drops.
  const [activeTab, setActiveTab] = useState(() => (new URLSearchParams(window.location.search).has('drop') ? 'drops' : 'landing'));

  return (
    <ActionsProvider>
      <div className="min-h-screen bg-[#FAFAF7] text-[#111111] font-sans selection:bg-[#111111] selection:text-[#FAFAF7]">
        {/* TOP NAVIGATION BAR */}
        <nav className="sticky top-0 z-50 border-b border-[#E5E5E0] bg-[#FAFAF7]/90 backdrop-blur-md px-6 h-16 flex items-center justify-between">
          
          {/* Left: Branding & Network Badge */}
          <div className="flex items-center gap-4">
            <div className="font-serif text-2xl tracking-tight leading-none lowercase pt-1">
              scalpless
            </div>
            <div className="hidden md:flex items-center gap-2 border border-[#E5E5E0] bg-white px-2.5 py-1 text-[10px] font-mono uppercase tracking-widest text-[#6B6B6B]">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
              SUI TESTNET · {PACKAGE_ID.slice(0, 6)}...{PACKAGE_ID.slice(-4)}
            </div>
          </div>

          {/* Center: Navigation Tabs */}
          <div className="hidden lg:flex items-center space-x-1">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-2 text-[11px] font-mono uppercase tracking-[0.14em] transition-all
                  ${activeTab === tab.id 
                    ? 'text-[#111111] border-b-2 border-[#111111] font-bold' 
                    : 'text-[#6B6B6B] hover:text-[#111111] hover:bg-[#E5E5E0]/30'
                  }
                `}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Right: World ID + Sui wallet */}
          <div className="flex items-center gap-3">
            <WorldIdButton />
            <ConnectButton />
          </div>
        </nav>

        {/* Mobile Navigation Dropdown (Visible only on small screens) */}
        <div className="lg:hidden border-b border-[#E5E5E0] bg-white px-6 py-3 flex overflow-x-auto space-x-4 no-scrollbar">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`whitespace-nowrap text-[10px] font-mono uppercase tracking-[0.1em] transition-colors
                ${activeTab === tab.id ? 'text-[#111111] font-bold underline underline-offset-4' : 'text-[#6B6B6B]'}
              `}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* MAIN CONTENT AREA */}
        <main className="max-w-6xl mx-auto px-6 pt-12 pb-24">
          {activeTab === 'landing' && <LandingView />}
          {activeTab === 'drops' && <FeaturedDropsView />}
          {activeTab === 'market' && <ResaleMarketView />}
          {activeTab === 'worldid' && <WorldIdentityView />}
          {activeTab === 'loans' && <LoansAndEmiView />}
          {activeTab === 'merchant' && <MerchantView />}
        </main>
      </div>
      <TxToast />
      </ActionsProvider>
  );
}
