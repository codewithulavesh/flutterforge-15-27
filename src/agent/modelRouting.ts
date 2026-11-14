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
  if (input.preference === 'quality' || input.isInitialGeneration) {
    return {
      role: 'frontier',
      model: FRONTIER_MODEL,
      reason: 'Frontier model selected for high-quality structure & design.',
    };
  }
  return {
    role: 'economy',
    model: ECONOMY_MODEL,
    reason: 'Fast model selected for edits and responses.',
  };
}
