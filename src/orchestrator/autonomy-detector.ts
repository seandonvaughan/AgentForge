import type { TeamManifest } from "../types/team.js";
import type { AutonomyLevel } from "../types/team-mode.js";
import type { ModelTier } from "../types/agent.js";

export function detectAutonomy(manifest: TeamManifest): AutonomyLevel {
  const { model_routing } = manifest;
  if (model_routing.opus.length > 0) return "full";
  if (model_routing.sonnet.length > 0) return "supervised";
  return "guided";
}

export function getClaudeCodeTier(autonomy: AutonomyLevel): ModelTier | null {
  switch (autonomy) {
    case "full":       return "haiku";
    case "supervised": return "sonnet";
    case "guided":     return null;
  }
}
