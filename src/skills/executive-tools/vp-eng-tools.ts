import type { ExecutiveTool, ExecutiveToolPermission } from "../../types/lifecycle.js";
import { BaseToolSuite } from "./base-tool-suite.js";

const VP_ENG_PERMISSION: ExecutiveToolPermission = {
  requiredRole: "manager",
  requiredAgentId: "vp-engineering",
  minSeniority: "lead",
};

export class VpEngToolSuite extends BaseToolSuite {
  readonly role = "vp-engineering";

  getTools(): ExecutiveTool[] {
    return [
      {
        name: "distributeWork",
        description: "Distribute CTO's tech plan across teams by domain fit",
        permission: VP_ENG_PERMISSION,
        category: "operational",
      },
      {
        name: "crossTeamSync",
        description: "Pull status from all engineering managers and surface conflicts",
        permission: VP_ENG_PERMISSION,
        category: "operational",
      },
      {
        name: "resolveConflict",
        description: "Mediate competing priorities between teams",
        permission: VP_ENG_PERMISSION,
        category: "operational",
      },
      {
        name: "performanceReview",
        description: "Pull career metrics for agents and recommend promotions",
        permission: VP_ENG_PERMISSION,
        category: "personnel",
      },
      {
        name: "requestTraining",
        description: "Inject domain knowledge into agent's career store",
        permission: VP_ENG_PERMISSION,
        category: "personnel",
      },
    ];
  }
}
