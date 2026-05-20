/** Cross-Instance Federation types */

export const FEDERATION_PROTOCOL_VERSION = '0.1.0-preview';
export const FEDERATION_LEARNING_SCHEMA_VERSION = '0.1.0-preview';

export type FederationState = 'preview-disabled' | 'dry-run-enabled';

export type FederationSafetyErrorCode =
  | 'FEDERATION_DISABLED'
  | 'PEER_LIMIT_EXCEEDED'
  | 'PROTOCOL_VERSION_MISMATCH'
  | 'REMOTE_INGEST_DISABLED'
  | 'CONTENT_TOO_LARGE';

export interface FederationPeer {
  /** Unique peer identifier */
  id: string;
  /** Human-readable name for the peer instance */
  name: string;
  /** Base URL of the peer (e.g. "https://agentforge.example.com") */
  url: string;
  /** Federation protocol version supported by the peer */
  protocolVersion: string;
  /** ISO timestamp when this peer was registered */
  registeredAt: string;
  /** Whether this peer is currently reachable */
  reachable: boolean;
}

export interface SharedLearning {
  /** Unique learning record ID */
  id: string;
  /** Learning payload schema version */
  schemaVersion: string;
  /** Agent ID that generated this learning */
  agentId: string;
  /** Category/domain of the learning */
  category: string;
  /** The learning content — PII stripped before sharing */
  content: string;
  /** Number of PII patterns redacted before storing */
  piiRedactions: number;
  /** Confidence score (0-1) */
  confidence: number;
  /** ISO timestamp when learning was originally generated */
  learnedAt: string;
  /** ID of the peer that shared this learning, or null if local */
  sourcePeerId: string | null;
}

export interface FederationConfig {
  /** Explicit operator opt-in for federation preview mutations. Default: false */
  enabled?: boolean;
  /** Whether federation operates in dry-run mode (no real network calls). Default: true */
  dryRun?: boolean;
  /** Protocol version this instance will accept */
  protocolVersion?: string;
  /** Maximum content length accepted for a shared learning */
  maxContentLength?: number;
  /** Maximum number of learnings to keep in the local store */
  maxLearnings?: number;
  /** Maximum number of peers to register */
  maxPeers?: number;
  /** Whether remote learning ingestion is allowed. Default: false */
  allowRemoteLearningIngest?: boolean;
}

export interface FederationSafetyControls {
  /** Mutating routes require explicit operator opt-in */
  operatorOptInRequired: true;
  /** Peer registration requires an exact protocol version match */
  peerProtocolVersionRequired: true;
  /** Real network exchange is not implemented in this preview */
  outboundNetworkDisabled: true;
  /** Remote learning ingestion is disabled unless explicitly configured */
  remoteLearningIngestDisabled: boolean;
  /** PII redaction is always applied before local storage */
  piiRedactionEnabled: true;
}

export interface FederationMetrics {
  /** Total peer registration attempts accepted */
  peersRegistered: number;
  /** Total local learning share attempts accepted */
  learningsShared: number;
  /** Total remote learning ingests accepted */
  learningsReceived: number;
  /** Total PII replacements made across accepted learnings */
  piiRedactions: number;
  /** Mutating operations blocked by safety controls */
  blockedOperations: number;
  /** Last operation timestamp, if any operation has been attempted */
  lastOperationAt?: string;
  /** Last blocked operation reason, if any operation was blocked */
  lastBlockedReason?: FederationSafetyErrorCode;
}

export interface FederationStatus {
  /** Whether federation is enabled */
  enabled: boolean;
  /** Current lifecycle state */
  state: FederationState;
  /** Federation protocol version accepted by this instance */
  protocolVersion: string;
  /** Learning payload schema version written by this instance */
  learningSchemaVersion: string;
  /** Whether operating in dry-run mode */
  dryRun: boolean;
  /** Number of registered peers */
  peerCount: number;
  /** Number of shared learnings in local store */
  learningCount: number;
  /** Safety controls currently applied */
  safety: FederationSafetyControls;
  /** Observable operation counters */
  metrics: FederationMetrics;
  /** ISO timestamp of status check */
  checkedAt: string;
}
