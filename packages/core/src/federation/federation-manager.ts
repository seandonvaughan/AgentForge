import {
  FEDERATION_PROTOCOL_VERSION,
  type FederationMetrics,
  type FederationPeer,
  type FederationConfig,
  type FederationStatus,
  type SharedLearning,
} from './types.js';

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Patterns that indicate PII — these fields are stripped before sharing. */
const PII_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, // email
  /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g,               // phone
  /\b(?:\d[ -]?){13,16}\b/g,                       // credit card
];

interface RedactionResult {
  content: string;
  redactions: number;
}

function stripPII(text: string): RedactionResult {
  let result = text;
  let redactions = 0;
  for (const pattern of PII_PATTERNS) {
    result = result.replace(pattern, () => {
      redactions += 1;
      return '[REDACTED]';
    });
  }
  return { content: result, redactions };
}

function normalizeNonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function normalizeConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function normalizeText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Invalid federation payload';
}

type FederationManagerConfig = Required<
  Omit<FederationConfig, 'acceptedProtocolVersions'>
> & {
  acceptedProtocolVersions: readonly string[];
};

function defaultMetrics(): FederationMetrics {
  return {
    shared: 0,
    received: 0,
    rejected: 0,
    piiRedactions: 0,
    lastActivityAt: null,
    lastRejectedReason: null,
  };
}

/**
 * FederationManager manages peer registry and shared learning exchange across
 * AgentForge instances. Operates in dry-run mode by default (no real network calls).
 */
export class FederationManager {
  private peers = new Map<string, FederationPeer>();
  private learnings: SharedLearning[] = [];
  private config: FederationManagerConfig;
  private metrics: FederationMetrics = defaultMetrics();

  constructor(config: Partial<FederationConfig> = {}) {
    const protocolVersion = config.protocolVersion ?? FEDERATION_PROTOCOL_VERSION;
    this.config = {
      dryRun: config.dryRun ?? true,
      protocolVersion,
      acceptedProtocolVersions: config.acceptedProtocolVersions ?? [protocolVersion],
      maxLearnings: config.maxLearnings ?? 1000,
      maxPeers: config.maxPeers ?? 50,
      requireRegisteredPeers: config.requireRegisteredPeers ?? false,
      minConfidence: config.minConfidence ?? 0,
      maxContentLength: config.maxContentLength ?? 10_000,
      allowNetworkExchange: config.allowNetworkExchange ?? false,
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
    const content = this.normalizeRequiredText(learning.content, 'content');
    this.assertContentLength(content);
    const confidence = normalizeConfidence(learning.confidence);
    this.assertMinimumConfidence(confidence);
    const redacted = stripPII(content);

    const full: SharedLearning = {
      id: generateId('learn'),
      ...learning,
      protocolVersion: this.config.protocolVersion,
      content: redacted.content,
      confidence,
      sourcePeerId: learning.sourcePeerId ?? null,
      learnedAt: new Date().toISOString(),
      piiRedactions: normalizeNonNegativeInteger(learning.piiRedactions) + redacted.redactions,
    };

    this.acceptLearning(full, 'shared');
    return full;
  }

  /**
   * Receive a learning from a remote peer. Strips PII before storing.
   */
  receiveLearning(learning: SharedLearning): SharedLearning {
    this.assertAcceptedProtocol(learning.protocolVersion);
    this.assertRegisteredSourcePeer(learning.sourcePeerId);
    const content = this.normalizeRequiredText(learning.content, 'content');
    this.assertContentLength(content);
    const confidence = normalizeConfidence(learning.confidence);
    this.assertMinimumConfidence(confidence);
    const redacted = stripPII(content);

    const sanitized: SharedLearning = {
      ...learning,
      protocolVersion: learning.protocolVersion ?? this.config.protocolVersion,
      content: redacted.content,
      confidence,
      sourcePeerId: learning.sourcePeerId ?? null,
      piiRedactions: normalizeNonNegativeInteger(learning.piiRedactions) + redacted.redactions,
    };

    this.acceptLearning(sanitized, 'received');
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
      safetyControls: {
        protocolVersion: this.config.protocolVersion,
        acceptedProtocolVersions: [...this.config.acceptedProtocolVersions],
        requireRegisteredPeers: this.config.requireRegisteredPeers,
        minConfidence: this.config.minConfidence,
        maxContentLength: this.config.maxContentLength,
        networkExchangeEnabled: !this.config.dryRun && this.config.allowNetworkExchange,
      },
      metrics: { ...this.metrics },
    };
  }

  private acceptLearning(learning: SharedLearning, direction: 'shared' | 'received'): void {
    this.storeLearning(learning);
    this.metrics[direction] += 1;
    this.metrics.piiRedactions += normalizeNonNegativeInteger(learning.piiRedactions);
    this.metrics.lastActivityAt = new Date().toISOString();
  }

  private reject(reason: string): never {
    this.metrics.rejected += 1;
    this.metrics.lastRejectedReason = reason;
    this.metrics.lastActivityAt = new Date().toISOString();
    throw new Error(reason);
  }

  private normalizeRequiredText(value: unknown, field: string): string {
    try {
      return normalizeText(value, field);
    } catch (err) {
      this.reject(errorMessage(err));
    }
  }

  private assertAcceptedProtocol(protocolVersion: string | undefined): void {
    const version = protocolVersion ?? this.config.protocolVersion;
    if (!this.config.acceptedProtocolVersions.includes(version)) {
      this.reject(`Unsupported federation protocol: ${version}`);
    }
  }

  private assertRegisteredSourcePeer(sourcePeerId: string | null): void {
    if (!this.config.requireRegisteredPeers) {
      return;
    }
    if (typeof sourcePeerId !== 'string' || sourcePeerId.trim().length === 0) {
      this.reject('Inbound federation learning is missing sourcePeerId');
    }
    if (!this.peers.has(sourcePeerId)) {
      this.reject(`Unknown federation peer: ${sourcePeerId}`);
    }
  }

  private assertMinimumConfidence(confidence: number): void {
    if (confidence < this.config.minConfidence) {
      this.reject(`Learning confidence ${confidence} is below minimum ${this.config.minConfidence}`);
    }
  }

  private assertContentLength(content: string): void {
    if (content.length > this.config.maxContentLength) {
      this.reject(`Learning content exceeds maximum length ${this.config.maxContentLength}`);
    }
  }

  private storeLearning(learning: SharedLearning): void {
    this.learnings.unshift(learning);
    if (this.learnings.length > this.config.maxLearnings) {
      this.learnings = this.learnings.slice(0, this.config.maxLearnings);
    }
  }
}
