'use client';

// World ID for Agents — the human side. A verified human creates a one-time link code; their
// AgentBook-registered agent claims it with a signed AgentKit request (`pnpm agent link <CODE>`).
import { useCallback, useEffect, useState } from 'react';
import { useWorldId } from './WorldIdProvider';
import { useActions } from '../views/actions';
import { usePassport } from '../../lib/hooks';
import { delegateAgentTx, revokeAgentTx } from '../../lib/tx';

interface Agent {
  agentWallet: string;
  agentHumanIdShort: string;
  suiAddress: string;
  linkedAt: number;
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `request failed (${res.status})`);
  return data as T;
}

const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;

export function AgentsPanel() {
  const world = useWorldId();
  const passport = usePassport(world.session?.humanKey);
  const { run, busy } = useActions();
  const onChain = passport.data?.agents ?? [];
  const [agents, setAgents] = useState<Agent[]>([]);
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setAgents((await api<{ agents: Agent[] }>('/api/world/agents')).agents);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not load agents');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // While a code is outstanding, poll so the agent appears as soon as it pairs.
  useEffect(() => {
    if (!code) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [code, load]);

  const newCode = async () => {
    setError('');
    try {
      setCode(await api('/api/world/agents/link-code', {}));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not create link code');
    }
  };

  const authorize = (a: Agent) =>
    run('Authorize agent on Sui', async () => delegateAgentTx(await world.attest('delegate-agent', a.suiAddress), a.suiAddress));

  const revoke = async (a: Agent) => {
    setError('');
    try {
      if (onChain.includes(a.suiAddress) && !(await run('Revoke agent on Sui', () => revokeAgentTx(a.suiAddress)))) return;
      await api('/api/world/agents/revoke', { agentWallet: a.agentWallet });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not revoke');
    }
  };

  return (
    <div className="border border-[#E5E5E0] p-6 bg-white mt-8">
      <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-[#6B6B6B] mb-2">World ID for Agents · AgentKit</div>
      <p className="text-[14px] text-[#6B6B6B] mb-4 max-w-[700px]">
        Pair an AI agent registered in World&apos;s AgentBook. It can enter drops and buy resales for you, but claiming a win
        still needs you to confirm in World App.
      </p>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <button
          onClick={() => void newCode()}
          className="bg-[#111111] text-[#FAFAF7] px-5 py-2.5 text-[11px] font-mono uppercase tracking-[0.14em] border border-[#111111] hover:bg-transparent hover:text-[#111111] transition-all"
        >
          Create agent link code
        </button>
        {code && (
          <span className="text-[12px] font-mono">
            Run <code className="bg-[#FAFAF7] border border-[#E5E5E0] px-2 py-1">pnpm agent link {code.code}</code> · expires{' '}
            {new Date(code.expiresAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {agents.length === 0 ? (
        <div className="text-[12px] font-mono text-[#6B6B6B]">No agents paired.</div>
      ) : (
        <div className="divide-y divide-[#E5E5E0] border border-[#E5E5E0]">
          {agents.map((a) => (
            <div key={a.agentWallet} className="p-3 flex flex-wrap items-center justify-between gap-2 text-[12px] font-mono">
              <div>
                <div>Agent {short(a.agentWallet)} · AgentBook human {a.agentHumanIdShort}</div>
                <div className="text-[#6B6B6B]">Sui executor {short(a.suiAddress)} · paired {new Date(a.linkedAt * 1000).toLocaleString()}</div>
              </div>
              <div className="flex gap-2">
                {onChain.includes(a.suiAddress) ? (
                  <span className="px-3 py-1 text-[11px] uppercase text-emerald-800 border border-emerald-300">Authorized on Sui</span>
                ) : (
                  <button
                    onClick={() => void authorize(a)}
                    disabled={!!busy || !passport.data}
                    className="border border-[#111111] px-3 py-1 text-[11px] uppercase hover:bg-[#111111] hover:text-[#FAFAF7] disabled:opacity-40"
                  >
                    Authorize on Sui
                  </button>
                )}
                <button onClick={() => void revoke(a)} className="border border-red-300 text-red-800 px-3 py-1 text-[11px] uppercase hover:bg-red-50">
                  Revoke
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <div className="mt-3 text-[12px] font-mono text-red-700">{error}</div>}
    </div>
  );
}
