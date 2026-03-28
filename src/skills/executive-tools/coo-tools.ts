import type { ExecutiveTool, ExecutiveToolPermission } from "../../types/lifecycle.js";
import { BaseToolSuite } from "./base-tool-suite.js";

const COO_PERMISSION: ExecutiveToolPermission = {
  requiredRole: "executive",
  requiredAgentId: "coo",
  minSeniority: "lead",
};

export class CooToolSuite extends BaseToolSuite {
  readonly role = "coo";

  getTools(): ExecutiveTool[] {
    return [
      {
        name: "assignTask",
        description: "Assign task to specific agent or team",
        permission: COO_PERMISSION,
        category: "operational",
      },
      {
        name: "reassignTask",
        description: "Move task from one agent to another",
        permission: COO_PERMISSION,
        category: "operational",
      },
      {
        name: "reassignAgent",
        description: "Move agent between teams atomically",
        permission: COO_PERMISSION,
        category: "personnel",
      },
      {
        name: "trackVelocity",
        description: "Pull velocity metrics per team",
        permission: COO_PERMISSION,
        category: "operational",
      },
      {
        name: "identifyBlockers",
        description: "Scan active tasks for stalls and dependency blocks",
        permission: COO_PERMISSION,
        category: "operational",
      },
      {
        name: "escalateBlocker",
        description: "Escalate blocker to CTO or CEO",
        permission: COO_PERMISSION,
        category: "operational",
      },
      {
        name: "createOperationalPlan",
        description: "Translate OKRs into operational milestones",
        permission: COO_PERMISSION,
        category: "strategic",
      },
    ];
  }
}
