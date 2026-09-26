'use client';

import { PACKAGE_ID, REGISTRY_OBJECT_ID, PASSPORT_REGISTRY_ID, LENDING_POOL_OBJECT_ID, MARKET_OBJECT_ID } from '../../lib/constants';

export default function LandingView() {
  return (
    <div className="space-y-12 animate-fade-in py-12">
      <header className="mb-16">
        <div className="flex items-center gap-4 mb-6">
          <div className="h-1.5 w-12 bg-[#111111]"></div>
          <span className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#6B6B6B]">
            Abstract & Manifesto
          </span>
        </div>
        <h1 className="font-serif text-5xl md:text-7xl font-normal tracking-tight text-[#111111] leading-[1.05] mb-6">
          One Human. <br />
          <span className="italic text-[#6B6B6B]">One Fair Chance.</span>
        </h1>
        <p className="text-[#6B6B6B] text-[15px] md:text-[17px] leading-[1.7] max-w-2xl font-light">
          Scalpless is an uncompromising, sybil-resistant e-commerce protocol built exclusively on <strong className="text-[#111111] font-normal">Sui Move</strong>.
          By enforcing zero-knowledge biometric uniqueness via <strong className="text-[#111111] font-normal">World ID</strong>,
          we eradicate bot-driven scalping. Physical assets are modeled as programmable <strong className="text-[#111111] font-normal">RWA Claims</strong>,
          enabling fair drops, uncollateralized <strong className="text-[#111111] font-normal">borrow-on-yourself</strong> loans backed by your World ID, and a resale market capped at 110% of face value.
        </p>
      </header>
      
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-12 border-t border-[#E5E5E0]">
        <div className="p-6 border border-[#E5E5E0] bg-white transition-colors hover:border-[#111111]">
          <div className="text-[11px] font-mono text-[#6B6B6B] mb-4">01. WORLD IDKIT</div>
          <h3 className="font-serif text-xl mb-2">Zero-Knowledge Sybil Resistance</h3>
          <p className="text-[13px] text-[#6B6B6B] leading-relaxed">
            Every participant must cryptographically prove humanity to enter a drop.
          </p>
        </div>
        <div className="p-6 border border-[#E5E5E0] bg-white transition-colors hover:border-[#111111]">
          <div className="text-[11px] font-mono text-[#6B6B6B] mb-4">02. SUI MOVE</div>
          <h3 className="font-serif text-xl mb-2">Programmable RWA Claims</h3>
          <p className="text-[13px] text-[#6B6B6B] leading-relaxed">
            Assets are modeled as pure `key`-only Claims without `store`. Transferability is strictly governed by protocol rules.
          </p>
        </div>
        <div className="p-6 border border-[#E5E5E0] bg-white transition-colors hover:border-[#111111]">
          <div className="text-[11px] font-mono text-[#6B6B6B] mb-4">03. VERITAS</div>
          <h3 className="font-serif text-xl mb-2">Human-Backed Credit</h3>
          <p className="text-[13px] text-[#6B6B6B] leading-relaxed">
            No collateral: your World ID is the security. Senior/junior tranches, on-chain underwriting terms, and permissionless default enforcement.
          </p>
        </div>
      </div>
    
      <div className="mt-24">
        
      </div>
    
      <div className="mt-24">
        {/* ======================================================== */}
        {/* § 06: INTEGRATION DEBRIEF & ARTIFACTS                    */}
        {/* ======================================================== */}
        <footer className="py-24">
          <div className="mb-12">
            <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-[#6B6B6B] mb-2">
              § 06 — INTEGRATION DEBRIEF & LIVE ON-CHAIN ARTIFACTS
            </div>
            <h2 className="font-serif text-3xl font-normal tracking-tight">
              Developer Experience & Track Submissions
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-12">
            <div className="p-6 border border-[#E5E5E0] bg-white space-y-4 text-[13px] text-[#6B6B6B] leading-relaxed">
              <h3 className="font-serif text-xl text-[#111111]">World IDKit & Agent Debrief</h3>
              <p>
                <strong>What surprised us:</strong> World ID 4.0 uniqueness proofs are one-shot per human per action — registration uses one, and returning users prove a session instead.
              </p>
              <p>
                <strong>Bridging to Sui:</strong> Sui has no World ID verifier, so the backend verifies proofs with World&apos;s API and signs a BCS attestation that Move checks — pinned by a golden test vector shared by TypeScript and Move.
              </p>
              <p>
                <strong>Highest-Impact Improvement:</strong> Native Move SDK / Move verifier for World ID Groth16 proofs directly on Sui without an Ed25519 relayer.
              </p>
            </div>

            <div className="p-6 border border-[#E5E5E0] bg-white space-y-3 font-mono text-[12px]">
              <h3 className="font-serif text-xl text-[#111111] mb-2 font-sans">Verified Sui Testnet Deployments</h3>
              <div>
                <span className="text-[#6B6B6B]">Package: </span>
                <a href={`https://suiscan.xyz/testnet/object/${PACKAGE_ID}`} target="_blank" rel="noreferrer" className="text-[#1D3557] underline">
                  {PACKAGE_ID.slice(0, 14)}...
                </a>
              </div>
              <div>
                <span className="text-[#6B6B6B]">Registry: </span>
                <a href={`https://suiscan.xyz/testnet/object/${REGISTRY_OBJECT_ID}`} target="_blank" rel="noreferrer" className="text-[#1D3557] underline">
                  {REGISTRY_OBJECT_ID.slice(0, 14)}...
                </a>
              </div>
              <div>
                <span className="text-[#6B6B6B]">Passport Registry: </span>
                <a href={`https://suiscan.xyz/testnet/object/${PASSPORT_REGISTRY_ID}`} target="_blank" rel="noreferrer" className="text-[#1D3557] underline">
                  {PASSPORT_REGISTRY_ID.slice(0, 14)}...
                </a>
              </div>
              <div>
                <span className="text-[#6B6B6B]">Lending Pool: </span>
                <a href={`https://suiscan.xyz/testnet/object/${LENDING_POOL_OBJECT_ID}`} target="_blank" rel="noreferrer" className="text-[#1D3557] underline">
                  {LENDING_POOL_OBJECT_ID.slice(0, 14)}...
                </a>
              </div>
              <div>
                <span className="text-[#6B6B6B]">Market: </span>
                <a href={`https://suiscan.xyz/testnet/object/${MARKET_OBJECT_ID}`} target="_blank" rel="noreferrer" className="text-[#1D3557] underline">
                  {MARKET_OBJECT_ID.slice(0, 14)}...
                </a>
              </div>
            </div>
          </div>

          <div className="border-t border-[#E5E5E0] pt-6 flex flex-col sm:flex-row items-center justify-between text-[11px] font-mono text-[#6B6B6B]">
            <div>Scalpless Protocol · ETHGlobal 2026 Submission</div>
            <div>Built on Sui Move · World ID 4.0 · AgentKit</div>
          </div>
        </footer>
      
      </div>
    </div>
  );
}
  

