// Durable registry of verified humans (JSON file; one writer — this backend process).
//
// World ID v4 uniqueness proofs can be generated only ONCE per human per action (World App
// returns `nullifier_replayed` afterwards), so a registration must never live only in a browser
// cookie: we persist { human key ↔ wallet ↔ World ID session } before answering. Returning
// humans then re-authenticate with a repeatable World ID session proof.
import fs from 'fs';
import path from 'path';
import type { CredentialTier } from './world-id.service';

export interface HumanRecord {
  humanKey: string; // uniqueness nullifier for WORLD_ACTION (primary credential)
  nullifiers: Record<string, string>; // every credential nullifier from the uniqueness proof
  tier: CredentialTier;
  wallet: string; // Sui address the proofs' signals were bound to
  sessionId: `session_${string}`; // World ID session for repeat checks
  registeredAt: number; // unix seconds
}

// An AI agent paired with a verified human (World ID for Agents).
export interface AgentLink {
  agentWallet: string; // checksummed EVM address registered in AgentBook
  agentHumanId: string; // AgentBook's anonymous human id for that wallet
  humanKey: string; // the Scalpless human the agent acts for
  suiAddress: string; // Sui address the agent executes from
  linkedAt: number; // unix seconds
}

interface StoreFile {
  humans: HumanRecord[];
  // session_nullifier values already accepted — each session proof is single-use.
  usedSessionNullifiers: string[];
  agents: AgentLink[];
  // AgentKit SIWE nonces already accepted → unix-ms first seen (pruned after the replay window).
  agentNonces: Record<string, number>;
}

const FILE = path.resolve(__dirname, '../../data/humans.json');

const EMPTY: StoreFile = { humans: [], usedSessionNullifiers: [], agents: [], agentNonces: {} };

function load(): StoreFile {
  try {
    // Older files predate some fields; fill them from EMPTY.
    return { ...EMPTY, ...(JSON.parse(fs.readFileSync(FILE, 'utf8')) as Partial<StoreFile>) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
    throw err;
  }
}

let state = load();

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE); // atomic replace
}

export const humanStore = {
  byWallet(wallet: string): HumanRecord | undefined {
    return state.humans.find((h) => h.wallet === wallet);
  },

  byHumanKey(humanKey: string): HumanRecord | undefined {
    return state.humans.find((h) => h.humanKey === humanKey);
  },

  add(record: HumanRecord): void {
    if (this.byHumanKey(record.humanKey)) throw new Error('human already registered');
    if (this.byWallet(record.wallet)) throw new Error('wallet already registered');
    state = { ...state, humans: [...state.humans, record] };
    save();
  },

  agentByWallet(agentWallet: string): AgentLink | undefined {
    return state.agents.find((a) => a.agentWallet === agentWallet);
  },

  agentsForHuman(humanKey: string): AgentLink[] {
    return state.agents.filter((a) => a.humanKey === humanKey);
  },

  /** Pair an agent with a human. One AgentBook human ↔ one Scalpless human. */
  linkAgent(link: AgentLink): void {
    const owner = state.agents.find((a) => a.agentHumanId === link.agentHumanId && a.humanKey !== link.humanKey);
    if (owner) throw new Error('this AgentBook human is already paired with a different Scalpless human');
    if (this.agentByWallet(link.agentWallet)) throw new Error('agent wallet already paired');
    state = { ...state, agents: [...state.agents, link] };
    save();
  },

  unlinkAgent(humanKey: string, agentWallet: string): boolean {
    const before = state.agents.length;
    state = { ...state, agents: state.agents.filter((a) => !(a.humanKey === humanKey && a.agentWallet === agentWallet)) };
    if (state.agents.length === before) return false;
    save();
    return true;
  },

  /** Records an AgentKit nonce; false if it was already used inside the replay window. */
  consumeAgentNonce(nonce: string, windowMs: number): boolean {
    const now = Date.now();
    const kept = Object.fromEntries(Object.entries(state.agentNonces).filter(([, t]) => now - t < windowMs));
    if (kept[nonce]) return false;
    state = { ...state, agentNonces: { ...kept, [nonce]: now } };
    save();
    return true;
  },

  /** Returns false if any of these session nullifiers was already accepted (replay). */
  consumeSessionNullifiers(nullifiers: string[]): boolean {
    if (nullifiers.some((n) => state.usedSessionNullifiers.includes(n))) return false;
    state = { ...state, usedSessionNullifiers: [...state.usedSessionNullifiers, ...nullifiers] };
    save();
    return true;
  },
};
