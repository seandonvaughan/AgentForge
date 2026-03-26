/**
 * Barrel export for the collaboration module.
 *
 * Provides topology selection, cross-domain bridge building,
 * and collaboration template loading.
 */

export { selectTopology } from "./topology-selector.js";
export { buildBridges, mergeTopology } from "./bridge-builder.js";
export {
  loadCollaborationTemplate,
  loadAllCollaborationTemplates,
} from "./template-loader.js";

export {
  CrossTeamProtocol,
  type TeamId,
  type ApiContract,
  type HandoffRequest,
  type ResearchTransfer,
  type TeamStats,
} from "./cross-team-protocol.js";
