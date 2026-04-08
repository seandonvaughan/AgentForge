# AgentForge API Reference

**Version 1.0 | April 2026**

## Overview

The AgentForge API provides programmatic access to Claude-powered agent dispatch and execution. All API calls route through the Claude CLI using OAuth authentication, eliminating the need for API keys.

---

## § 1 — Authentication

### Authentication Method

AgentForge uses **Claude Code Max-plan OAuth authentication** instead of API keys. This means:

- **No API key required** — Use your existing Claude Code login session
- **OAuth via `claude` CLI** — The `claude -p` command inherits your session
- **Automatic on Max plans** — If you're on a Claude Code Max subscription, authentication is automatic

#### Why OAuth Instead of API Keys?

1. **Security** — No keys to leak or rotate
2. **Session-based** — Reuses your existing Claude Code login
3. **Subscription-aware** — Automatically respects your plan limits (Pro, Max)
4. **Rate limits** — Managed per-session, not per-key

#### Setup (One-Time)

```bash
# 1. Open Claude Code (or `claude` CLI)
# 2. Log in with your Claude account (if not already logged in)
# 3. Verify you're on a Max plan

# 4. Test authentication:
claude -p "Hello" --model claude-opus-4-20250514

# Expected: Response text + cost data
# If you see "auth required" error, log in with: claude auth login
```

#### Checking Your Authentication Status

```bash
# Check if you're logged in and which plan you have
claude auth status

# Example output:
# Authenticated: yes
# Plan: Max
# Model access: opus, sonnet, haiku
```

### For CI/CD Environments

If running AgentForge in CI/CD (GitHub Actions, etc.):

```bash
# Option 1: Use an OAuth token from environment
export CLAUDE_SESSION_TOKEN=your_session_token_here

# Option 2: Set up a dedicated Claude account for CI
# Create a bot account on Claude, generate a token, store in GitHub Secrets
export CLAUDE_SESSION_TOKEN=${{ secrets.CLAUDE_SESSION_TOKEN }}

# Then run AgentForge commands normally
npm run autonomous:cycle
```

---

## § 2 — API Client (`src/api/client.ts`)

The `sendMessage` function is the primary way to invoke Claude models via AgentForge.

### Function Signature

```typescript
function sendMessage(params: SendMessageParams): SendMessageResult
```

### Input Parameters

```typescript
interface SendMessageParams {
  /** Model tier: "opus", "sonnet", or "haiku" */
  model: "opus" | "sonnet" | "haiku";
  
  /** System prompt (instructions for the model) */
  systemPrompt: string;
  
  /** User message / task description */
  userMessage: string;
  
  /** Reasoning effort level (optional, default: inferred from model) */
  effort?: "low" | "medium" | "high";
  
  /** Budget cap in USD (optional, no limit if omitted) */
  maxBudgetUsd?: number;
}
```

### Return Value

```typescript
interface SendMessageResult {
  /** The model's text response */
  content: string;
  
  /** Input tokens consumed */
  inputTokens: number;
  
  /** Output tokens consumed */
  outputTokens: number;
  
  /** Total cost in USD */
  costUsd: number;
  
  /** Actual model ID used (may differ if auto-routed) */
  modelUsed: string;
}
```

### Model Mapping

| Tier | Model ID | Max Tokens | Default Temp | Default Effort |
|------|----------|-----------|------------|---|
| `opus` | claude-opus-4-20250514 | 4096 | 0.7 | high |
| `sonnet` | claude-sonnet-4-20250514 | 4096 | 0.5 | medium |
| `haiku` | claude-haiku-4-5-20251001 | 2048 | 0.3 | low |

### Example: Simple Dispatch

```typescript
import { sendMessage } from "@agentforge/api/client.js";

const result = sendMessage({
  model: "sonnet",
  systemPrompt: "You are a helpful code reviewer.",
  userMessage: "Review this function for bugs: function add(a, b) { return a + b; }",
  maxBudgetUsd: 1.0,
});

console.log(result.content);
console.log(`Cost: $${result.costUsd.toFixed(4)}`);
```

### Example: High-Reasoning Task

```typescript
const result = sendMessage({
  model: "opus",
  systemPrompt: "You are an expert architect reviewing system design.",
  userMessage: "Evaluate this database schema for normalization issues...",
  effort: "high",  // Enables extended thinking on Opus
  maxBudgetUsd: 5.0,
});

console.log("Analysis:", result.content);
console.log(`Tokens: ${result.inputTokens} in, ${result.outputTokens} out`);
```

### Error Handling

The `sendMessage` function throws errors in these cases:

| Scenario | Error | Recovery |
|----------|-------|----------|
| Not logged in | `UNAUTHORIZED` | Run `claude auth login` |
| Budget exceeded | `BUDGET_EXCEEDED` | Increase `maxBudgetUsd` or simplify request |
| Rate limited | `RATE_LIMITED` | Retry after delay (exponential backoff) |
| Model unavailable | Falls back to next-best model | No error; check `modelUsed` |
| Network timeout | `TIMEOUT` (5 min default) | Increase timeout or split request |

---

## § 3 — Cost Tracking & Budget

### Cost Per Model

Typical costs (as of April 2026):

| Model | Input (per 1M tokens) | Output (per 1M tokens) |
|-------|-----|-----|
| Opus | $3.00 | $15.00 |
| Sonnet | $0.60 | $3.00 |
| Haiku | $0.08 | $0.40 |

### Budget Enforcement

Setting `maxBudgetUsd`:

```typescript
// Fail if this call would cost more than $1
const result = sendMessage({
  model: "opus",
  userMessage: "...",
  systemPrompt: "...",
  maxBudgetUsd: 1.0,  // Throws if cost > $1
});
```

### Checking Cost After Execution

```typescript
const result = sendMessage({ /* ... */ });

console.log(`Input: ${result.inputTokens} tokens`);
console.log(`Output: ${result.outputTokens} tokens`);
console.log(`Cost: $${result.costUsd.toFixed(4)}`);

// Store in database or log for accounting
recordCost({
  model: result.modelUsed,
  tokens: result.inputTokens + result.outputTokens,
  costUsd: result.costUsd,
  timestamp: new Date(),
});
```

### Cost Optimization

1. **Right-size the model**
   - Use Haiku for simple tasks (summarization, formatting)
   - Use Sonnet for coding and analysis
   - Reserve Opus for strategic decisions

2. **Reuse context when possible**
   - Batch related requests in a multi-turn conversation
   - Reference previous responses to avoid re-explaining

3. **Budget limits**
   - Always set `maxBudgetUsd` in production
   - Monitor costs with AgentForge's cost-report command

---

## § 4 — Integration Patterns

### Pattern 1: Sequential Refinement

```typescript
// Ask Haiku for a quick summary
const summary = sendMessage({
  model: "haiku",
  systemPrompt: "Summarize in 1-2 sentences.",
  userMessage: longDocument,
  maxBudgetUsd: 0.10,
});

// Ask Sonnet for deeper analysis
const analysis = sendMessage({
  model: "sonnet",
  systemPrompt: "Analyze and critique.",
  userMessage: `Document:\n${longDocument}\n\nSummary from Haiku:\n${summary.content}`,
  maxBudgetUsd: 0.50,
});

// Ask Opus for final decision
const decision = sendMessage({
  model: "opus",
  systemPrompt: "Make a strategic recommendation.",
  userMessage: `Analysis:\n${analysis.content}`,
  effort: "high",
  maxBudgetUsd: 2.0,
});
```

### Pattern 2: Parallel Dispatch

```typescript
import { Promise } from "node:promise";

const [codeReview, securityReview, perfAnalysis] = await Promise.all([
  // Code review by Sonnet
  sendMessage({
    model: "sonnet",
    systemPrompt: "Review code for style and correctness.",
    userMessage: `Code:\n${sourceCode}`,
    maxBudgetUsd: 1.0,
  }),
  
  // Security review by Sonnet (security-focused)
  sendMessage({
    model: "sonnet",
    systemPrompt: "Review code for security vulnerabilities.",
    userMessage: `Code:\n${sourceCode}`,
    maxBudgetUsd: 1.0,
  }),
  
  // Performance analysis by Haiku
  sendMessage({
    model: "haiku",
    systemPrompt: "Analyze code for performance issues.",
    userMessage: `Code:\n${sourceCode}`,
    maxBudgetUsd: 0.20,
  }),
]);

console.log("Code Review:", codeReview.content);
console.log("Security Review:", securityReview.content);
console.log("Performance Analysis:", perfAnalysis.content);
```

### Pattern 3: Fallback on Budget Overrun

```typescript
async function analyzeWithFallback(code: string): Promise<string> {
  try {
    // Try expensive analysis first
    const result = sendMessage({
      model: "opus",
      systemPrompt: "Perform deep code analysis.",
      userMessage: code,
      effort: "high",
      maxBudgetUsd: 3.0,
    });
    return result.content;
  } catch (err) {
    if (err.message.includes("BUDGET_EXCEEDED")) {
      // Fall back to cheaper model
      console.warn("Budget exceeded, falling back to Sonnet");
      const result = sendMessage({
        model: "sonnet",
        systemPrompt: "Perform code analysis.",
        userMessage: code,
        maxBudgetUsd: 1.0,
      });
      return result.content;
    }
    throw err;
  }
}
```

---

## § 5 — Troubleshooting

### Authentication Errors

**Error:** `UNAUTHORIZED: authentication required`

```bash
# Solution: Log in to Claude Code
claude auth login
# Or set session token in CI
export CLAUDE_SESSION_TOKEN=your_token
```

**Error:** `FORBIDDEN: Max plan required`

Your current plan doesn't support this model. Upgrade to Max plan in Claude Code settings.

---

### Budget Errors

**Error:** `BUDGET_EXCEEDED: Estimated cost $2.50 > limit $1.00`

```typescript
// Solution 1: Increase budget
maxBudgetUsd: 5.0

// Solution 2: Use cheaper model
model: "sonnet"  // instead of "opus"

// Solution 3: Simplify request
userMessage: shortSummary  // instead of full document
```

---

### Rate Limiting

**Error:** `RATE_LIMITED: Too many requests`

```typescript
// Solution: Exponential backoff
async function retryWithBackoff(maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return sendMessage({ /* ... */ });
    } catch (err) {
      if (err.message.includes("RATE_LIMITED")) {
        const delay = Math.pow(2, i) * 1000;  // 1s, 2s, 4s
        console.log(`Rate limited, retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}
```

---

## § 6 — Migration from API Keys

### Before (Anthropic SDK with API Key)

```typescript
// OLD: Required ANTHROPIC_API_KEY environment variable
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const message = await client.messages.create({
  model: "claude-opus-4-20250514",
  max_tokens: 1024,
  messages: [{ role: "user", content: "..." }],
});
```

### After (AgentForge with OAuth)

```typescript
// NEW: No API key needed, uses Claude Code OAuth
import { sendMessage } from "@agentforge/api/client.js";

const result = sendMessage({
  model: "opus",
  systemPrompt: "You are...",
  userMessage: "...",
});

console.log(result.content);
```

### Migration Checklist

- [ ] Remove `ANTHROPIC_API_KEY` from `.env` and CI/CD secrets
- [ ] Update imports: `@anthropic-ai/sdk` → `@agentforge/api/client`
- [ ] Update function calls: `messages.create()` → `sendMessage()`
- [ ] Test in local environment (OAuth via `claude` CLI)
- [ ] Set up CI/CD with `CLAUDE_SESSION_TOKEN` instead of `ANTHROPIC_API_KEY`
- [ ] Update documentation and onboarding materials

---

## § 7 — Versioning

**Current API version:** 1.0

| Component | Stability |
|-----------|-----------|
| `sendMessage()` | stable |
| `SendMessageParams` | stable |
| `SendMessageResult` | stable |
| Model IDs | stable (backward-compatible) |
| Authentication (OAuth) | stable |
| Effort levels (low/medium/high) | stable |
| Cost tracking fields | stable |

---

## § 8 — Best Practices

1. **Always set maxBudgetUsd**
   ```typescript
   maxBudgetUsd: 1.0  // Prevent runaway costs
   ```

2. **Validate authentication in CI**
   ```bash
   # In your CI workflow, before running AgentForge:
   claude auth status || exit 1
   ```

3. **Log costs for accounting**
   ```typescript
   console.log(`Cost: $${result.costUsd}`);
   // Send to your accounting system
   ```

4. **Use appropriate models**
   - Haiku: Summaries, formatting, simple analysis
   - Sonnet: Implementation, detailed analysis
   - Opus: Architecture, strategic decisions

5. **Handle errors gracefully**
   ```typescript
   try {
     return sendMessage({ /* ... */ });
   } catch (err) {
     if (err.message.includes("BUDGET")) {
       // Fall back to cheaper model
     } else {
       // Log and retry
     }
   }
   ```

---

## § 9 — FAQ

**Q: Do I need an API key?**
A: No. AgentForge uses OAuth via Claude Code's login session.

**Q: Can I use this in GitHub Actions?**
A: Yes. Set `CLAUDE_SESSION_TOKEN` in your GitHub Secrets and export it in your workflow.

**Q: What if I'm offline?**
A: You need internet to authenticate and call the Claude API. There's no offline mode.

**Q: Can I call multiple models in parallel?**
A: Yes. Use `Promise.all()` to dispatch multiple `sendMessage()` calls concurrently.

**Q: How much does this cost?**
A: See § 3 — Cost Tracking for pricing. Typical calls: $0.01–$1.00.

**Q: Can I use this without AgentForge?**
A: Yes. `src/api/client.ts` is a standalone module. Import and use it directly.

---

**Last updated:** April 8, 2026
