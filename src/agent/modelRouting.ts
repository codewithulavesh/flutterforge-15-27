export const FRONTIER_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';
export const ECONOMY_MODEL = 'nvidia/nemotron-3.5-lightning:free';

export type ModelPreference = 'auto' | 'quality' | 'fast' | 'speed';

export interface ResolveModelChoiceInput {
  preference?: ModelPreference;
  isInitialGeneration?: boolean;
  isRepair?: boolean;
  plan?: string;
  hasByok?: boolean;
}

export interface ModelChoice {
  role: 'frontier' | 'economy';
  model: string;
  reason: string;
}

export function resolveModelChoice(input: ResolveModelChoiceInput): ModelChoice {
  // Entitlement as documented in the product: frontier requires a Pro/Team
  // plan OR the user's own OpenRouter key (BYOK). Everyone else routes to the
  // economy tier. (The server enforces the same rule for its own routes.)
  const plan = (input.plan ?? 'free').trim().toLowerCase();
  const hasPlan = plan === 'pro' || plan === 'team';
  const entitled = hasPlan || input.hasByok === true;

  if (input.preference === 'quality' || input.isInitialGeneration) {
    if (entitled) {
      return {
        role: 'frontier',
        model: FRONTIER_MODEL,
        reason: `Frontier model for ${input.isInitialGeneration ? 'initial generation' : 'quality preference'} (${hasPlan ? `plan ${plan}` : 'own key'}).`,
      };
    }
    return {
      role: 'economy',
      model: ECONOMY_MODEL,
      reason: 'Free tier — the frontier model needs Pro/Team or your own OpenRouter key.',
    };
  }
  return {
    role: 'economy',
    model: ECONOMY_MODEL,
    reason: 'Fast model selected for edits and responses.',
  };
}
