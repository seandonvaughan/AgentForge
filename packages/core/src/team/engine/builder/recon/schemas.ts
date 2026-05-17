/**
 * Zod schemas for the five Recon-phase output artifacts.
 *
 * Each agent in Phase A produces a structured JSON document that is
 * validated against one of these schemas before being persisted to
 * `.agentforge/forge/recon/<agentId>.json`.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// SubsystemsReport — code-archaeologist output
// ---------------------------------------------------------------------------

export const SubsystemsReportSchema = z.object({
  subsystems: z.array(
    z.object({
      name: z.string().min(1),
      path: z.string().min(1),
      description: z.string().min(1),
      public_surface: z.array(z.string()),
      owner_hint: z.string().optional(),
    }),
  ),
});

export type SubsystemsReport = z.infer<typeof SubsystemsReportSchema>;

// ---------------------------------------------------------------------------
// DependenciesReport — dep-graph-analyst output
// ---------------------------------------------------------------------------

export const DependenciesReportSchema = z.object({
  package_manager: z.string().min(1),
  prod_deps: z.array(
    z.object({
      name: z.string().min(1),
      version: z.string().min(1),
      category: z.string().min(1),
      in_use_proven: z.boolean(),
    }),
  ),
  dev_deps: z.array(
    z.object({
      name: z.string().min(1),
      version: z.string().min(1),
      category: z.string().min(1),
      in_use_proven: z.boolean(),
    }),
  ),
  framework_signals: z.array(
    z.object({
      name: z.string().min(1),
      evidence_files: z.array(z.string()),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

export type DependenciesReport = z.infer<typeof DependenciesReportSchema>;

// ---------------------------------------------------------------------------
// ConventionsReport — convention-detective output
// ---------------------------------------------------------------------------

export const ConventionsReportSchema = z.object({
  formatter: z.string().optional(),
  linter: z.string().optional(),
  linter_rules: z.array(z.string()),
  test_runner: z.string().optional(),
  test_pattern: z.array(z.string()),
  file_layout: z.array(z.string()),
  import_style: z.string().min(1),
  error_handling_pattern: z.string().optional(),
});

export type ConventionsReport = z.infer<typeof ConventionsReportSchema>;

// ---------------------------------------------------------------------------
// DomainReport — domain-mapper output
// ---------------------------------------------------------------------------

export const DomainReportSchema = z.object({
  product_name: z.string().min(1),
  one_liner: z.string().min(1),
  user_personas: z.array(z.string()),
  core_primitives: z.array(z.string()),
  domain_vocabulary: z.array(z.string()),
  non_goals: z.array(z.string()),
});

export type DomainReport = z.infer<typeof DomainReportSchema>;

// ---------------------------------------------------------------------------
// HistoryReport — failure-historian output
// ---------------------------------------------------------------------------

export const HistoryReportSchema = z.object({
  recurring_bug_patterns: z.array(
    z.object({
      pattern: z.string().min(1),
      count: z.number().int().min(0),
      last_seen: z.string().min(1),
    }),
  ),
  gate_rejection_themes: z.array(z.string()),
  cost_outliers: z.array(z.string()),
  high_value_subsystems: z.array(z.string()),
});

export type HistoryReport = z.infer<typeof HistoryReportSchema>;
