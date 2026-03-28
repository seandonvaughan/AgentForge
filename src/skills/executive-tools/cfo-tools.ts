import type { ExecutiveTool, ExecutiveToolPermission } from "../../types/lifecycle.js";
import { BaseToolSuite } from "./base-tool-suite.js";

const CFO_PERMISSION: ExecutiveToolPermission = {
  requiredRole: "executive",
  requiredAgentId: "cfo",
  minSeniority: "lead",
};

export class CfoToolSuite extends BaseToolSuite {
  readonly role = "cfo";

  getTools(): ExecutiveTool[] {
    return [
      {
        name: "analyzeBudget",
        description: "Current spend vs budget by team, agent, and model tier",
        permission: CFO_PERMISSION,
        category: "financial",
      },
      {
        name: "projectCosts",
        description: "Forecast spend for next sprint based on historical patterns",
        permission: CFO_PERMISSION,
        category: "financial",
      },
      {
        name: "costAlert",
        description: "Flag agents or teams with anomalous spend",
        permission: CFO_PERMISSION,
        category: "financial",
      },
      {
        name: "roiAnalysis",
        description: "Calculate ROI on completed sprint",
        permission: CFO_PERMISSION,
        category: "financial",
      },
      {
        name: "budgetRequest",
        description: "Request additional budget from CEO with justification",
        permission: CFO_PERMISSION,
        category: "financial",
      },
    ];
  }
}
