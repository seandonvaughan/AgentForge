/** Cross-Instance Federation types */

export const FEDERATION_PROTOCOL_VERSION = 'agentforge-federation-v1' as const;

export type FederationProtocolVersion = typeof FEDERATION_PROTOCOL_VERSION;

export interface FederationPeer {
  /** Unique peer identifier */
  id: string;
  /** Human-readable name for the peer instance */
  name: string;
  /** Base URL of the peer (e.g. "https://agentforge.example.com") */
  url: string;
  /** ISO timestamp when this peer was registered */
  registeredAt: string;
  /** Whether this peer is currently reachable */
  reachable: boolean;
}

export interface SharedLearning {
  /** Unique learning record ID */
  id: string;
  /** Protocol version used to serialize and validate this learning */
  protocolVersion?: string;
  /** Agent ID that generated this learning */
  agentId: string;
  /** Category/domain of the learning */
  category: string;
  /** The learning content — PII stripped before sharing */
  content: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** ISO timestamp when learning was originally generated */
  learnedAt: string;
  /** ID of the peer that shared this learning, or null if local */
  sourcePeerId: string | null;
  /** Number of PII matches redacted before this learning was stored */
  piiRedactions?: number;
}

export interface FederationConfig {
  /** Whether federation operates in dry-run mode (no real network calls). Default: true */
  dryRun: boolean;
  /** Local protocol version emitted for newly shared learnings */
  protocolVersion?: string;
  /** Protocol versions accepted from remote peers */
  acceptedProtocolVersions?: readonly string[];
  /** Maximum number of learnings to keep in the local store */
  maxLearnings?: number;
  /** Maximum number of peers to register */
  maxPeers?: number;
  /** Whether inbound peer learnings must come from a registered peer */
  requireRegisteredPeers?: boolean;
  /** Minimum accepted confidence for local or remote learnings */
  minConfidence?: number;
  /** Maximum learning content length accepted before redaction */
  maxContentLength?: number;
  /** Safety latch for future non-dry-run network exchange */
  allowNetworkExchange?: boolean;
}

export interface FederationSafetyControls {
  /** Local protocol version emitted for newly shared learnings */
  protocolVersion: string;
  /** Protocol versions accepted from remote peers */
  acceptedProtocolVersions: string[];
  /** Whether inbound peer learnings must come from a registered peer */
  requireRegisteredPeers: boolean;
  /** Minimum accepted confidence for local or remote learnings */
  minConfidence: number;
  /** Maximum learning content length accepted before redaction */
  maxContentLength: number;
  /** True only when dryRun is false and network exchange has been explicitly enabled */
  networkExchangeEnabled: boolean;
}

export interface FederationMetrics {
  /** Number of local learnings accepted for sharing */
  shared: number;
  /** Number of remote learnings accepted */
  received: number;
  /** Number of rejected local or remote payloads */
  rejected: number;
  /** Total PII matches redacted from accepted learnings */
  piiRedactions: number;
  /** Last accepted or rejected operation timestamp */
  lastActivityAt: string | null;
  /** Last rejection reason, if any rejection has occurred */
  lastRejectedReason: string | null;
}

export interface FederationStatus {
  /** Whether federation is enabled */
  enabled: boolean;
  /** Whether operating in dry-run mode */
  dryRun: boolean;
  /** Number of registered peers */
  peerCount: number;
  /** Number of shared learnings in local store */
  learningCount: number;
  /** ISO timestamp of status check */
  checkedAt: string;
  /** Active versioning and safety controls */
  safetyControls: FederationSafetyControls;
  /** In-memory observability counters */
  metrics: FederationMetrics;
}
