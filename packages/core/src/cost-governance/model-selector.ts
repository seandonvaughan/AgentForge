import type { ModelTier, TaskComplexity } from './types.js';

/** Keywords that signal each complexity level. */
const COMPLEXITY_SIGNALS: Record<TaskComplexity, string[]> = {
  trivial:   ['rename', 'typo', 'comment', 'format', 'whitespace', 'docs'],
  simple:    ['fix', 'patch', 'minor', 'small', 'update', 'tweak', 'lint'],
  moderate:  ['add', 'implement', 'extend', 'improve', 'feature', 'endpoint'],
  complex:   ['refactor', 'redesign', 'migrate', 'integrate', 'pipeline', 'framework'],
  strategic: ['architect', 'design', 'strategy', 'plan', 'review', 'evaluate', 'overhaul'],
};

const COMPLEXITY_TO_TIER: Record<TaskComplexity, ModelTier> = {
  trivial:   'haiku',
  simple:    'haiku',
  moderate:  'sonnet',
  complex:   'sonnet',
  strategic: 'opus',
};

export class ModelSelector {
  /**
   * Infer task complexity from text and select the cheapest sufficient model.
   * Explicit model overrides take priority.
   */
  select(task: string, explicitModel?: string): ModelTier {
    if (explicitModel === 'opus' || explicitModel === 'sonnet' || explicitModel === 'haiku') {
      return explicitModel;
    }

    const lower = task.toLowerCase();
    const complexity = this._inferComplexity(lower);
    return COMPLEXITY_TO_TIER[complexity];
  }

  inferComplexity(task: string): TaskComplexity {
    return this._inferComplexity(task.toLowerCase());
  }

  private _inferComplexity(lower: string): TaskComplexity {
    // Check from most specific (strategic) down to trivial
    for (const level of ['strategic', 'complex', 'moderate', 'simple', 'trivial'] as TaskComplexity[]) {
      if (COMPLEXITY_SIGNALS[level].some(kw => lower.includes(kw))) {
        return level;
      }
    }
    return 'moderate'; // default
  }
}
