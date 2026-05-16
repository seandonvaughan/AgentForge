/**
 * billing.ts — Billing scaffolding endpoints (v1)
 *
 * Provides the API surface the dashboard billing page expects, so there are no
 * 404s while Stripe integration is deferred to Phase 2.
 *
 * Endpoints:
 *   GET  /api/v5/billing/plan      — returns tier/features from workspace settings
 *   GET  /api/v5/billing/invoices  — returns [] (Stripe integration is Phase 2)
 *   POST /api/v5/billing/invoices  — 501 Not Implemented; audit-logs the call
 *                                    so the webhook contract is fixed before impl
 *
 * Settings storage: billing plan is persisted under settings.billing in the
 * existing settings.yaml file (same store used by /api/v5/settings).
 *
 * Phase 2 TODO: replace GET /billing/plan with a Stripe customer lookup,
 * replace GET /billing/invoices with a real Stripe invoice list, and implement
 * the POST handler to process Stripe webhook events.
 */

import type { FastifyInstance } from 'fastify';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { appendAuditEntry, openAuditDb } from './audit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/server/src/routes/v5/ → up 5 levels to monorepo root
const DEFAULT_PROJECT_ROOT = join(__dirname, '../../../../../');

// ---------------------------------------------------------------------------
// Billing plan types
// ---------------------------------------------------------------------------

export type BillingTier = 'free' | 'pro' | 'enterprise';

export interface BillingPlan {
  tier: BillingTier;
  name: string;
  monthlyBudgetUsd: number;
  perAgentCostMultiplier: number;
  features: string[];
}

const DEFAULT_PLAN: BillingPlan = {
  tier: 'free',
  name: 'Free',
  monthlyBudgetUsd: 50,
  perAgentCostMultiplier: 1.0,
  features: ['5 agents', 'Community support', 'Dashboard access'],
};

// ---------------------------------------------------------------------------
// Invoice schema (Phase 2 placeholder)
// ---------------------------------------------------------------------------

interface InvoiceWebhookPayload {
  invoiceId: string;
  amountUsd: number;
  status: 'paid' | 'open' | 'void';
  issuedAt: string;
  customerId?: string;
}

function isInvoicePayload(body: unknown): body is InvoiceWebhookPayload {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.invoiceId === 'string' &&
    typeof b.amountUsd === 'number' &&
    typeof b.status === 'string' &&
    ['paid', 'open', 'void'].includes(b.status as string) &&
    typeof b.issuedAt === 'string'
  );
}

// ---------------------------------------------------------------------------
// Settings helpers (scoped to billing sub-key)
// ---------------------------------------------------------------------------

function settingsPath(projectRoot: string): string {
  return join(projectRoot, '.agentforge/config/settings.yaml');
}

function loadBillingPlan(projectRoot: string): BillingPlan {
  const path = settingsPath(projectRoot);
  if (!existsSync(path)) return { ...DEFAULT_PLAN };
  try {
    const raw = yaml.load(readFileSync(path, 'utf-8')) as Record<string, unknown> | null;
    const billing = raw?.billing as Partial<BillingPlan> | undefined;
    if (!billing) return { ...DEFAULT_PLAN };
    const tier = (['free', 'pro', 'enterprise'] as const).includes(billing.tier as BillingTier)
      ? (billing.tier as BillingTier)
      : DEFAULT_PLAN.tier;
    return {
      tier,
      name: typeof billing.name === 'string' ? billing.name : DEFAULT_PLAN.name,
      monthlyBudgetUsd:
        typeof billing.monthlyBudgetUsd === 'number'
          ? billing.monthlyBudgetUsd
          : DEFAULT_PLAN.monthlyBudgetUsd,
      perAgentCostMultiplier:
        typeof billing.perAgentCostMultiplier === 'number'
          ? billing.perAgentCostMultiplier
          : DEFAULT_PLAN.perAgentCostMultiplier,
      features: Array.isArray(billing.features)
        ? (billing.features as unknown[]).filter((f): f is string => typeof f === 'string')
        : [...DEFAULT_PLAN.features],
    };
  } catch {
    return { ...DEFAULT_PLAN };
  }
}

// ---------------------------------------------------------------------------
// Route options
// ---------------------------------------------------------------------------

export interface BillingRouteOptions {
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function billingRoutes(
  app: FastifyInstance,
  opts: BillingRouteOptions = {},
): Promise<void> {
  const projectRoot = opts.projectRoot ?? DEFAULT_PROJECT_ROOT;
  const auditDb = openAuditDb(projectRoot);
  app.addHook('onClose', async () => { auditDb.close(); });

  // ── GET /api/v5/billing/plan ─────────────────────────────────────────────

  app.get('/api/v5/billing/plan', async (_req, reply) => {
    const plan = loadBillingPlan(projectRoot);
    return reply.send({ data: plan });
  });

  // ── GET /api/v5/billing/invoices ─────────────────────────────────────────
  //
  // Phase 2 TODO: replace [] with a real Stripe invoice list fetch.

  app.get('/api/v5/billing/invoices', async (_req, reply) => {
    return reply.send({ data: [] });
  });

  // ── POST /api/v5/billing/invoices — internal billing webhook receiver ────
  //
  // Phase 2 TODO: implement Stripe webhook verification + persistence.
  // For now we accept a structurally correct payload, audit-log it, and
  // return 501 so callers know the contract is defined but not yet active.

  app.post('/api/v5/billing/invoices', async (req, reply) => {
    if (!isInvoicePayload(req.body)) {
      return reply.status(400).send({
        error:
          'Body must conform to InvoiceWebhookPayload: { invoiceId, amountUsd, status, issuedAt }',
      });
    }

    const payload = req.body;

    // Audit the call so nothing is silently lost during the deferred impl period.
    appendAuditEntry(auditDb, {
      actor: 'billing-webhook',
      action: 'billing.invoice.received',
      target: payload.invoiceId,
      details: {
        amountUsd: payload.amountUsd,
        status: payload.status,
        issuedAt: payload.issuedAt,
        ...(payload.customerId !== undefined ? { customerId: payload.customerId } : {}),
      },
    });

    // Phase 2: process the invoice (persist to DB, update plan limits, etc.)
    return reply.status(501).send({
      error: 'Not Implemented — Stripe billing integration is Phase 2',
      invoiceId: payload.invoiceId,
    });
  });
}
