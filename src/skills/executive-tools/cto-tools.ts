import type { ExecutiveTool, ExecutiveToolPermission } from "../../types/lifecycle.js";
import { BaseToolSuite } from "./base-tool-suite.js";

const CTO_PERMISSION: ExecutiveToolPermission = {
  requiredRole: "executive",
  requiredAgentId: "cto",
  minSeniority: "principal",
};

export class CtoToolSuite extends BaseToolSuite {
  readonly role = "cto";

  getTools(): ExecutiveTool[] {
    return [
      {
        name: "defineStandard",
        description: "Set technical standard enforced during code review",
        permission: CTO_PERMISSION,
        category: "technical",
      },
      {
        name: "approveArchitecture",
        description: "Review and approve architecture proposals",
        permission: CTO_PERMISSION,
        category: "technical",
      },
      {
        name: "triggerTechDebt",
        description: "Commission tech debt assessment from QA team",
        permission: CTO_PERMISSION,
        category: "technical",
      },
      {
        name: "technologyDecision",
        description: "Record build-vs-buy or technology choice",
        permission: CTO_PERMISSION,
        category: "technical",
      },
      {
        name: "requestHire",
        description: "Request new specialist with justification",
        permission: CTO_PERMISSION,
        category: "personnel",
      },
      {
        name: "promoteTechLead",
        description: "Elevate senior agent to tech lead role",
        permission: CTO_PERMISSION,
        category: "personnel",
      },
      {
        name: "assignTechPlan",
        description: "Break sprint items into technical tasks for VP Engineering",
        permission: CTO_PERMISSION,
        category: "operational",
      },
    ];
  }
}
