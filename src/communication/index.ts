// Barrel exports — communication module

export {
  V4MessageBus,
  registerStandardTopics,
  type EnvelopeHandler,
  type PublishOptions,
} from "./v4-message-bus.js";

export {
  ReviewRouter,
  type ReviewRequest,
  type ReviewRecord,
} from "./review-router.js";

export {
  MeetingCoordinator,
  MEETING_CONCURRENCY_LIMIT,
  ESCALATION_TIMEOUT_MS,
  type MeetingType,
  type MeetingRequest,
  type MeetingRecord,
} from "./meeting-coordinator.js";

export {
  ChannelManager,
  type ChannelMessage,
  type Channel,
} from "./channel-manager.js";

export {
  ExecAssistant,
  type MessageClassification,
  type ClassifiedMessage,
  type ExecBriefing,
  type ClassificationRule,
} from "./exec-assistant.js";

export {
  ReviewSessionSerializer,
  type SerializedReviewSession,
} from "./review-session-serializer.js";

export {
  BusFileAdapter,
  type BusEvent,
} from "./bus-file-adapter.js";
