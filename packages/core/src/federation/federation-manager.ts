import type { FederationPeer, SharedLearning, FederationConfig, FederationStatus } from './types.js';

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Patterns that indicate PII — these fields are stripped before sharing. */
const PII_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, // email
  /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g,               // phone
  /\b(?:\d[ -]?){13,16}\b/g,                       // credit card
];

function stripPII(text: string): string {
  let result = text;
  for (const pattern of PII_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

/**
 * FederationManager manages peer registry and shared learning exchange across
 * AgentForge instances. Operates in dry-run mode by default (no real network calls).
 */
export class FederationManager {
  private peers = new Map<string, FederationPeer>();
  private learnings: SharedLearning[] = [];
  private config: Required<FederationConfig>;

  constructor(config: Partial<FederationConfig> = {}) {
    this.config = {
      dryRun: config.dryRun ?? true,
      maxLearnings: config.maxLearnings ?? 1000,
      maxPeers: config.maxPeers ?? 50,
    };
  }

  /**
   * Register a new federation peer.
   * @throws Error if maxPeers limit would be exceeded
   */
  registerPeer(peer: Omit<FederationPeer, 'registeredAt' | 'reachable'>): FederationPeer {
    if (this.peers.size >= this.config.maxPeers) {
      throw new Error(`Cannot register peer: maximum of ${this.config.maxPeers} peers reached`);
    }

    const fullPeer: FederationPeer = {
      ...peer,
      registeredAt: new Date().toISOString(),
      reachable: this.config.dryRun ? true : false, // dry-run assumes reachable
    };

    this.peers.set(peer.id, fullPeer);
    return fullPeer;
  }

  /**
   * Share a learning with federation peers. Strips PII before storing.
   * In dry-run mode, simulates exchange without real network calls.
   */
  shareLearning(learning: Omit<SharedLearning, 'id' | 'learnedAt'>): SharedLearning {
    const sanitizedContent = stripPII(learning.content);

    const full: SharedLearning = {
      id: generateId('learn'),
      ...learning,
      content: sanitizedContent,
      sourcePeerId: learning.sourcePeerId ?? null,
      learnedAt: new Date().toISOString(),
    };

    this.storeLearning(full);
    return full;
  }

  /**
   * Receive a learning from a remote peer. Strips PII before storing.
   */
  receiveLearning(learning: SharedLearning): SharedLearning {
    const sanitized: SharedLearning = {
      ...learning,
      content: stripPII(learning.content),
    };

    this.storeLearning(sanitized);
    return sanitized;
  }

  /**
   * List all registered peers.
   */
  listPeers(): FederationPeer[] {
    return Array.from(this.peers.values());
  }

  /**
   * Get all shared learnings in the local store.
   */
  getSharedLearnings(): SharedLearning[] {
    return [...this.learnings];
  }

  /**
   * Get the current federation status.
   */
  getStatus(): FederationStatus {
    return {
      enabled: true,
      dryRun: this.config.dryRun,
      peerCount: this.peers.size,
      learningCount: this.learnings.length,
      checkedAt: new Date().toISOString(),
    };
  }

  private storeLearning(learning: SharedLearning): void {
    this.learnings.unshift(learning);
    if (this.learnings.length > this.config.maxLearnings) {
      this.learnings = this.learnings.slice(0, this.config.maxLearnings);
    }
  }
}
