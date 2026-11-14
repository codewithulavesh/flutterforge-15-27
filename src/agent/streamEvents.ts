import type { AgentEvent, AgentFileArtifact, AgentPlan, ValidationReport } from './types';

export interface SSEAgentEvent {
  phase: AgentEvent['phase'];
  stepNumber?: number;
  totalSteps?: number;
  step_number?: number;
  total_steps?: number;
  message: string;
  detail?: string;
  thought?: string;
  node?: string;
  timestamp?: string;
  activeFile?: string;
  plan?: AgentPlan;
  generatedFiles?: AgentFileArtifact[];
  validationReport?: ValidationReport;
  retrievedPatterns?: unknown[];
  kind?: 'phase' | 'reasoning' | 'tool' | 'tool_result' | 'validation' | 'file' | 'error';
  tool?: string;
  toolInput?: unknown;
  toolCallId?: string;
  status?: string;
  filePath?: string;
}

export interface SSETokenEvent {
  node: string;
  token: string;
  phase: string;
}

export interface SSEFileReadyEvent {
  path: string;
  content: string;
  action: 'created' | 'modified' | 'deleted';
  language: string;
  node: string;
}

export interface SSEFilesMergedEvent {
  count: number;
  paths: string[];
}

export interface SSEValidationEvent {
  is_valid: boolean;
  summary: string;
  issue_count: number;
}

