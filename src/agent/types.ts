export interface AgentTableColumn {
  name: string;
  type: string;
  isPrimary?: boolean;
  isNullable?: boolean;
  defaultValue?: string;
  isUnique?: boolean;
}

export interface AgentTable {
  name: string;
  description?: string;
  columns: AgentTableColumn[];
  enableRLS?: boolean;
  rlsPolicies?: Array<{
    name: string;
    action: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL';
    rule: string;
  }>;
}

export interface AgentSchema {
  tables: AgentTable[];
}

export interface AgentScreen {
  id?: string;
  name: string;
  route?: string;
  routePath?: string;
  filePath?: string;
  description?: string;
  isAuthProtected?: boolean;
  widgets?: string[];
}

export interface AgentService {
  name: string;
  description?: string;
  methods: string[];
}

export interface AgentTheme {
  primaryColor: string;
  secondaryColor?: string;
  accentColor?: string;
  fontFamily?: string;
  useMaterial3?: boolean;
  darkMode?: boolean;
  isDarkPreferred?: boolean;
}

export interface AgentPlan {
  id?: string;
  appName: string;
  domain?: string;
  architecture: string;
  appDescription?: string;
  stateManagement: string;
  theme: AgentTheme;
  schema: AgentSchema;
  screens: AgentScreen[];
  services: AgentService[];
  dependencies: Record<string, string>;
  files?: string[];
  filesToCreate: string[];
}

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  code?: string;
  file?: string;
  filePath?: string;
  line?: number;
  suggestion?: string;
  autoFixAvailable?: boolean;
}

export interface ValidationFix {
  filePath?: string;
  fixDescription: string;
}

export interface ValidationReport {
  isValid: boolean;
  summary: string;
  issues: ValidationIssue[];
  fixedIssues: ValidationFix[];
}

export interface AgentFileArtifact {
  path: string;
  content: string;
  action?: 'created' | 'modified' | 'deleted';
  language?: string;
  oldContent?: string;
}

export interface AgentGenerationResult {
  success: boolean;
  plan?: AgentPlan;
  files: AgentFileArtifact[];
  schemaSql?: string;
  validationReport?: ValidationReport;
  summary: string;
  durationMs?: number;
  logs?: string[];
  retrievedPatterns?: unknown[];
  verification?: {
    verified: boolean;
    diagnostics?: Array<{ id: string; status: string; detail: string }>;
    gates?: Array<{ id: string; status: string; detail: string }>;
  };
}

export interface AgentEvent {
  phase: string;
  stepNumber?: number;
  totalSteps?: number;
  message: string;
  detail?: string;
  thought?: string;
  plan?: AgentPlan;
  generatedFiles?: AgentFileArtifact[];
  validationReport?: ValidationReport;
  retrievedPatterns?: unknown[];
  timestamp?: string;
}

export interface AgentContext {
  projectId: string;
  projectName: string;
  projectDescription?: string;
  files?: Array<{ path: string; content: string }>;
  conversationHistory?: Array<{ role: string; content: string }>;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  platform?: string;
  appId?: string;
  usesSupabase?: boolean;
  activeFile?: string | null;
  buildErrors?: string[];
}

export interface AgentGenerationOptions {
  enableAutoHealing?: boolean;
  stateManagement?: 'provider' | 'riverpod' | 'bloc' | 'change_notifier';
  isIncremental?: boolean;
  conversationHistory?: Array<{ role: string; content: string }>;
  skills?: unknown[];
  isEdit?: boolean;
  existingFiles?: Array<{ path: string; content: string | null }>;
  signal?: AbortSignal;
  temperature?: number;
  modelConfig?: {
    provider?: string;
    modelName?: string;
    apiKey?: string;
    temperature?: number;
  };
  onEvent?: (event: AgentEvent) => void;
  onProgress?: (message: string) => void;
  onFile?: (file: { path: string; content: string; action: 'created' | 'modified' | 'deleted'; language: string; node: string }) => void;
}

export interface CodePattern {
  id: string;
  title: string;
  category: string;
  tags: string[];
  code: string;
}
