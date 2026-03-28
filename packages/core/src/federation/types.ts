/** Cross-Instance Federation types */

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
}

export interface FederationConfig {
  /** Whether federation operates in dry-run mode (no real network calls). Default: true */
  dryRun: boolean;
  /** Maximum number of learnings to keep in the local store */
  maxLearnings?: number;
  /** Maximum number of peers to register */
  maxPeers?: number;
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
}
