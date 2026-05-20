import {
  FEDERATION_LEARNING_SCHEMA_VERSION,
  FEDERATION_PROTOCOL_VERSION,
} from './types.js';
import type {
  FederationConfig,
  FederationMetrics,
  FederationPeer,
  FederationSafetyControls,
  FederationSafetyErrorCode,
  FederationStatus,
  SharedLearning,
} from './types.js';

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

const DEFAULT_MAX_CONTENT_LENGTH = 4_096;

/** Patterns that indicate PII; matches are stripped before local storage. */
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
      redactions++;
      return '[REDACTED]';
    });
  }
  return { content: result, redactions };
}

export class FederationSafetyError extends Error {
  constructor(
    readonly code: FederationSafetyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FederationSafetyError';
  }
}

/**
 * FederationManager manages peer registry and shared learning exchange across
 * AgentForge instances. It is a preview-only local contract: mutating
 * operations require operator opt-in and real network calls are disabled.
 */
export class FederationManager {
  private peers = new Map<string, FederationPeer>();
  private learnings: SharedLearning[] = [];
  private config: Required<FederationConfig>;
  private metrics: FederationMetrics = {
    peersRegistered: 0,
    learningsShared: 0,
    learningsReceived: 0,
    piiRedactions: 0,
    blockedOperations: 0,
  };

  constructor(config: Partial<FederationConfig> = {}) {
    this.config = {
      enabled: config.enabled ?? false,
      dryRun: config.dryRun ?? true,
      protocolVersion: config.protocolVersion ?? FEDERATION_PROTOCOL_VERSION,
      maxContentLength: config.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH,
      maxLearnings: config.maxLearnings ?? 1000,
      maxPeers: config.maxPeers ?? 50,
      allowRemoteLearningIngest: config.allowRemoteLearningIngest ?? false,
    };
  }

  /**
   * Register a new federation peer.
   * @throws Error if maxPeers limit would be exceeded
   */
  registerPeer(peer: Omit<FederationPeer, 'registeredAt' | 'reachable'>): FederationPeer {
    this.assertEnabled();
    this.assertProtocolVersion(peer.protocolVersion);

    if (this.peers.size >= this.config.maxPeers) {
      this.block('PEER_LIMIT_EXCEEDED');
      throw new FederationSafetyError(
        'PEER_LIMIT_EXCEEDED',
        `Cannot register peer: maximum of ${this.config.maxPeers} peers reached`,
      );
    }

    const fullPeer: FederationPeer = {
      ...peer,
      registeredAt: new Date().toISOString(),
      reachable: this.config.dryRun ? true : false, // dry-run assumes reachable
    };

    this.peers.set(peer.id, fullPeer);
    this.metrics.peersRegistered++;
    this.touch();
    return fullPeer;
  }

  /**
   * Share a learning with federation peers. Strips PII before storing.
   * In dry-run mode, simulates exchange without real network calls.
   */
  shareLearning(
    learning: Omit<SharedLearning, 'id' | 'learnedAt' | 'schemaVersion' | 'piiRedactions'>,
  ): SharedLearning {
    this.assertEnabled();
    this.assertContentSize(learning.content);
    const sanitized = stripPII(learning.content);

    const full: SharedLearning = {
      id: generateId('learn'),
      schemaVersion: FEDERATION_LEARNING_SCHEMA_VERSION,
      ...learning,
      content: sanitized.content,
      piiRedactions: sanitized.redactions,
      sourcePeerId: learning.sourcePeerId ?? null,
      learnedAt: new Date().toISOString(),
    };

    this.storeLearning(full);
    this.metrics.learningsShared++;
    this.metrics.piiRedactions += sanitized.redactions;
    this.touch();
    return full;
  }

  /**
   * Receive a learning from a remote peer. Strips PII before storing.
   */
  receiveLearning(learning: SharedLearning): SharedLearning {
    this.assertEnabled();
    if (!this.config.allowRemoteLearningIngest) {
      this.block('REMOTE_INGEST_DISABLED');
      throw new FederationSafetyError(
        'REMOTE_INGEST_DISABLED',
        'Remote federation learning ingestion is disabled until ingestion policy and provenance checks are implemented',
      );
    }
    if (learning.schemaVersion !== FEDERATION_LEARNING_SCHEMA_VERSION) {
      this.block('PROTOCOL_VERSION_MISMATCH');
      throw new FederationSafetyError(
        'PROTOCOL_VERSION_MISMATCH',
        `Unsupported learning schema version "${learning.schemaVersion}"; expected "${FEDERATION_LEARNING_SCHEMA_VERSION}"`,
      );
    }
    this.assertContentSize(learning.content);
    const redacted = stripPII(learning.content);
    const sanitizedLearning: SharedLearning = {
      ...learning,
      content: redacted.content,
      piiRedactions: learning.piiRedactions + redacted.redactions,
    };

    this.storeLearning(sanitizedLearning);
    this.metrics.learningsReceived++;
    this.metrics.piiRedactions += redacted.redactions;
    this.touch();
    return sanitizedLearning;
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
    const safety = this.getSafetyControls();
    return {
      enabled: this.config.enabled,
      state: this.config.enabled ? 'dry-run-enabled' : 'preview-disabled',
      protocolVersion: this.config.protocolVersion,
      learningSchemaVersion: FEDERATION_LEARNING_SCHEMA_VERSION,
      dryRun: this.config.dryRun,
      peerCount: this.peers.size,
      learningCount: this.learnings.length,
      safety,
      metrics: { ...this.metrics },
      checkedAt: new Date().toISOString(),
    };
  }

  private storeLearning(learning: SharedLearning): void {
    this.learnings.unshift(learning);
    if (this.learnings.length > this.config.maxLearnings) {
      this.learnings = this.learnings.slice(0, this.config.maxLearnings);
    }
  }

  private getSafetyControls(): FederationSafetyControls {
    return {
      operatorOptInRequired: true,
      peerProtocolVersionRequired: true,
      outboundNetworkDisabled: true,
      remoteLearningIngestDisabled: !this.config.allowRemoteLearningIngest,
      piiRedactionEnabled: true,
    };
  }

  private assertEnabled(): void {
    if (this.config.enabled) return;
    this.block('FEDERATION_DISABLED');
    throw new FederationSafetyError(
      'FEDERATION_DISABLED',
      'Cross-instance federation is preview-disabled; set an explicit operator opt-in after versioning, observability, and safety controls are reviewed',
    );
  }

  private assertProtocolVersion(protocolVersion: string): void {
    if (protocolVersion === this.config.protocolVersion) return;
    this.block('PROTOCOL_VERSION_MISMATCH');
    throw new FederationSafetyError(
      'PROTOCOL_VERSION_MISMATCH',
      `Unsupported federation protocol "${protocolVersion}"; expected "${this.config.protocolVersion}"`,
    );
  }

  private assertContentSize(content: string): void {
    if (content.length <= this.config.maxContentLength) return;
    this.block('CONTENT_TOO_LARGE');
    throw new FederationSafetyError(
      'CONTENT_TOO_LARGE',
      `Shared learning content exceeds ${this.config.maxContentLength} characters`,
    );
  }

  private block(reason: FederationSafetyErrorCode): void {
    this.metrics.blockedOperations++;
    this.metrics.lastBlockedReason = reason;
    this.touch();
  }

  private touch(): void {
    this.metrics.lastOperationAt = new Date().toISOString();
  }
}
