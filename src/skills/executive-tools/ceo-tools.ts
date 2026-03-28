import type { ExecutiveTool, ExecutiveToolPermission } from "../../types/lifecycle.js";
import { BaseToolSuite } from "./base-tool-suite.js";

const CEO_PERMISSION: ExecutiveToolPermission = {
  requiredRole: "executive",
  requiredAgentId: "ceo",
  minSeniority: "principal",
};

export class CeoToolSuite extends BaseToolSuite {
  readonly role = "ceo";

  getTools(): ExecutiveTool[] {
    return [
      {
        name: "createSprint",
        description: "Define sprint with items, budget, and success criteria",
        permission: CEO_PERMISSION,
        category: "strategic",
      },
      {
        name: "approveSprint",
        description: "Review and approve/reject CTO's technical plan",
        permission: CEO_PERMISSION,
        category: "strategic",
      },
      {
        name: "setOKRs",
        description: "Define quarterly objectives and key results",
        permission: CEO_PERMISSION,
        category: "strategic",
      },
      {
        name: "approveBudget",
        description: "Approve or deny budget requests",
        permission: CEO_PERMISSION,
        category: "financial",
      },
      {
        name: "hireApproval",
        description: "Final approval on hiring recommendations",
        permission: CEO_PERMISSION,
        category: "personnel",
      },
      {
        name: "fireAgent",
        description: "Terminate underperforming agent with knowledge transfer",
        permission: CEO_PERMISSION,
        category: "personnel",
      },
      {
        name: "strategicDecision",
        description: "Record major strategic decision with rationale",
        permission: CEO_PERMISSION,
        category: "strategic",
      },
      {
        name: "requestStatusBrief",
        description: "Request aggregated status from all C-suite",
        permission: CEO_PERMISSION,
        category: "operational",
      },
    ];
  }
}
