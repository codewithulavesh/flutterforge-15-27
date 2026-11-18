/**
 * Master Project State for the Lovable-Style Multi-Agent Generation System.
 * Defines the blackboard state carried through every agent node in the pipeline.
 */

export interface ProductBrief {
  appName: string;
  oneLiner: string;
  targetAudience: string;
  primaryProblem: string;
  platforms: Array<'web' | 'macos' | 'windows' | 'android' | 'ios'>;
  constraints: string[];
}

export interface ScreenState {
  loading: string;
  empty: string;
  error: string;
  content: string;
}

export interface ScreenDefinition {
  id: string;
  name: string;
  route: string;
  purpose: string;
  primaryAction: string;
  states: ScreenState;
  widgets: string[];
  isAuthRequired?: boolean;
}

export interface ScreenGraph {
  screens: ScreenDefinition[];
  userFlows: Array<{ id: string; name: string; steps: string[] }>;
}

export interface DesignTokens {
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  backgroundColor: string;
  surfaceColor: string;
  fontFamily: string;
  useMaterial3: boolean;
  isDarkPreferred: boolean;
  borderRadius: number;
}

export interface ArchitectureSpec {
  stateManagement: 'provider' | 'riverpod' | 'bloc';
  navigationType: 'tabs' | 'drawer' | 'stack';
  features: string[];
  packages: Record<string, string>;
  backendMode: 'none' | 'local' | 'supabase';
}

export interface TableColumn {
  name: string;
  type: string;
  isPrimary?: boolean;
  isNullable?: boolean;
  defaultValue?: string;
}

export interface TableDefinition {
  name: string;
  columns: TableColumn[];
  enableRLS: boolean;
  policies: Array<{ name: string; action: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL'; rule: string }>;
}

export interface DataSchema {
  tables: TableDefinition[];
  migrations: string[];
}

export interface PlannedFile {
  path: string;
  purpose: string;
  action: 'create' | 'edit';
}

export interface BuildPlan {
  id: string;
  appName: string;
  files: PlannedFile[];
  phases: Array<{ id: string; label: string; files: string[]; gateAfter: string }>;
  dependencies: Record<string, string>;
}

export interface GeneratedFile {
  path: string;
  content: string;
  action: 'created' | 'modified' | 'deleted';
  language: string;
}

export interface GateDiagnostic {
  gate: string;
  level: 'error' | 'warning' | 'info';
  file?: string;
  filePath?: string;
  line?: number;
  message: string;
  suggestion?: string;
}

export interface ProjectState {
  projectId: string;
  userPrompt: string;
  status: 'planning' | 'generating' | 'verifying' | 'repaired' | 'ready' | 'failed';
  productBrief: ProductBrief | null;
  screenGraph: ScreenGraph | null;
  designTokens: DesignTokens | null;
  /** Use architectureSpec (canonical) or architecture (legacy alias). */
  architectureSpec: ArchitectureSpec | null;
  architecture: ArchitectureSpec | null;
  dataSchema: DataSchema | null;
  plan: BuildPlan | null;
  generatedFiles: Map<string, GeneratedFile>;
  diagnostics: GateDiagnostic[];
  repairAttempts: number;
  logs: string[];
  /**
   * Additive, optional: structured failure info set when the pipeline halts in a
   * controlled failure (fatal step, user abort, or exhausted repair budget /
   * oscillation). Null/undefined on the success path.
   */
  failure?: { stepId: string; message: string } | null;
  /** Side-channel data passed between agents (not persisted). */
  _intakeData?: unknown;
  _uxNavigation?: unknown;
  [key: string]: unknown;
}

export function createInitialProjectState(projectId: string, userPrompt: string): ProjectState {
  return {
    projectId,
    userPrompt,
    status: 'planning',
    productBrief: null,
    screenGraph: null,
    designTokens: null,
    architectureSpec: null,
    architecture: null,
    dataSchema: null,
    plan: null,
    generatedFiles: new Map(),
    diagnostics: [],
    repairAttempts: 0,
    logs: [],
  };
}

