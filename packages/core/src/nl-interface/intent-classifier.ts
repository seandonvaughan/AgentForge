import type { IntentType, ParsedIntent } from './types.js';

interface IntentPattern {
  intent: IntentType;
  keywords: string[];
  patterns: RegExp[];
  baseConfidence: number;
}

const INTENT_PATTERNS: IntentPattern[] = [
  {
    intent: 'run_agent',
    keywords: ['run', 'execute', 'start', 'launch', 'trigger', 'invoke', 'fire'],
    patterns: [/run\s+(?:the\s+)?(\w+)\s+agent/i, /execute\s+(?:the\s+)?(\w+)/i],
    baseConfidence: 0.8,
  },
  {
    intent: 'get_status',
    keywords: ['status', 'health', 'check', 'state', 'running', 'alive', 'ping'],
    patterns: [/(?:get|show|what(?:'s| is))\s+(?:the\s+)?status/i, /is\s+.+\s+(?:running|alive)/i],
    baseConfidence: 0.8,
  },
  {
    intent: 'list_agents',
    keywords: ['list', 'show', 'display', 'agents', 'available', 'what agents'],
    patterns: [/list\s+(?:all\s+)?agents/i, /what\s+agents\s+(?:are\s+)?available/i, /show\s+(?:me\s+)?(?:all\s+)?agents/i],
    baseConfidence: 0.85,
  },
  {
    intent: 'show_cost',
    keywords: ['cost', 'spend', 'budget', 'price', 'expensive', 'usage', 'billing', 'dollars'],
    patterns: [
      /(?:show|get|what(?:'s| is))\s+(?:the\s+)?cost/i,
      /how\s+much\s+(?:did|has|have)\s+.+\s+cost/i,
      /(?:what\s+is|show|get)\s+(?:my\s+)?budget/i,
      /\bbudget\b/i,
    ],
    baseConfidence: 0.85,
  },
  {
    intent: 'create_workflow',
    keywords: ['create', 'build', 'make', 'new', 'workflow', 'pipeline', 'automation'],
    patterns: [/create\s+(?:a\s+)?(?:new\s+)?workflow/i, /build\s+(?:a\s+)?pipeline/i],
    baseConfidence: 0.8,
  },
  {
    intent: 'query_knowledge',
    keywords: ['knowledge', 'search', 'find', 'lookup', 'query', 'learn', 'tell me about'],
    patterns: [
      /(?:search|query|find)\s+(?:the\s+)?knowledge/i,
      /tell\s+me\s+about\s+/i,
      /what\s+is\s+(?!my\s+budget|the\s+cost|the\s+budget)\w/i,
    ],
    baseConfidence: 0.75,
  },
  {
    intent: 'get_sprint',
    keywords: ['sprint', 'iteration', 'release', 'version', 'backlog', 'planning'],
    patterns: [/(?:get|show|list)\s+(?:current\s+)?sprint/i, /sprint\s+(?:status|info|details)/i],
    baseConfidence: 0.8,
  },
];

export class IntentClassifier {
  classify(input: string): ParsedIntent {
    const lower = input.toLowerCase();
    const words = new Set(lower.split(/\s+/));

    let bestIntent: IntentType = 'unknown';
    let bestConfidence = 0;

    for (const pattern of INTENT_PATTERNS) {
      let score = 0;

      // Keyword matching
      const keywordMatches = pattern.keywords.filter(k => words.has(k) || lower.includes(k));
      score += keywordMatches.length * 0.15;

      // Pattern matching (stronger signal)
      const patternMatches = pattern.patterns.filter(p => p.test(input));
      score += patternMatches.length * 0.35;

      const confidence = Math.min(0.99, pattern.baseConfidence * Math.min(1, score + 0.1));

      if (keywordMatches.length > 0 || patternMatches.length > 0) {
        const adjustedConfidence = Math.min(0.99, score + (keywordMatches.length > 0 ? 0.2 : 0));
        if (adjustedConfidence > bestConfidence) {
          bestConfidence = adjustedConfidence;
          bestIntent = pattern.intent;
        }
      }
    }

    return {
      intent: bestIntent,
      confidence: Math.round(bestConfidence * 100) / 100,
      entities: [],
      rawInput: input,
    };
  }

  listIntents(): IntentType[] {
    return [
      'run_agent',
      'get_status',
      'list_agents',
      'show_cost',
      'create_workflow',
      'query_knowledge',
      'get_sprint',
      'unknown',
    ];
  }
}
