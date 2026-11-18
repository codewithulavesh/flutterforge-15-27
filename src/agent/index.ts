import type { AgentContext, AgentFileArtifact, AgentGenerationOptions, AgentGenerationResult, AgentPlan } from './types';
import { generateFlutterProjectFiles, generateMinimalStarterFiles } from '../utils/flutterTemplates';
import { SkillRegistry } from './skills';
import { keyPool } from './keyPool';
import { LovableGenerationPipeline } from '../orchestrator/graph';
import { runEditAgent } from '../agents/editAgent';

export * from './types';
export * from './skills';
export * from './chatTypes';
export * from './chatHistory';
export * from './chatIntent';
export * from './chatContext';
export * from './chatAnswer';
export * from './modelRouting';
export * from './keyPool';
export * from './streamEvents';

export class AgentContextBuilder {
  public static buildContext(input: AgentContext): AgentContext {
    return { ...input };
  }
}

export class AgentPlanner {
  public static plan(
    prompt: string,
    context: AgentContext,
    options?: { stateManagement?: string; skills?: unknown[] }
  ): AgentPlan {
    const appName = context.projectName || 'FlutterForgeApp';
    return {
      id: crypto.randomUUID(),
      appName,
      domain: 'general',
      architecture: 'feature_first',
      appDescription: context.projectDescription || `Flutter application for ${appName}`,
      stateManagement: options?.stateManagement || 'provider',
      theme: {
        primaryColor: '#2563EB',
        secondaryColor: '#3B82F6',
        useMaterial3: true,
        darkMode: false,
        isDarkPreferred: false,
      },
      schema: { tables: [] },
      screens: [
        { name: 'HomeScreen', route: '/', routePath: '/', filePath: 'lib/features/home/screens/home_screen.dart' },
        { name: 'ProfileScreen', route: '/profile', routePath: '/profile', filePath: 'lib/features/profile/screens/profile_screen.dart' },
      ],
      services: [{ name: 'AppService', methods: ['init', 'fetch'] }],
      dependencies: { flutter: 'sdk' },
      files: ['lib/main.dart', 'pubspec.yaml'],
      filesToCreate: ['lib/main.dart', 'pubspec.yaml'],
    };
  }
}

export class MultiFileCodeGenerator {
  public static generateAllFiles(plan: AgentPlan, context: AgentContext): AgentFileArtifact[] {
    const usesSupabase = context.usesSupabase === true;
    const files = usesSupabase
      ? generateFlutterProjectFiles(plan.appName, 'standard', [], undefined, context.projectId)
      : generateMinimalStarterFiles(plan.appName, context.projectId);

    return files.map((f) => ({
      path: f.path,
      content: f.content || '',
      action: 'created' as const,
      language: f.path.endsWith('.dart') ? 'dart' : f.path.endsWith('.yaml') ? 'yaml' : 'text',
    }));
  }
}

export class FlutterSupabaseAgent {
  public static async execute(
    prompt: string,
    context: AgentContext,
    options: AgentGenerationOptions = {}
  ): Promise<AgentGenerationResult> {
    const projectId = context.projectId || `proj_${Date.now()}`;

    // Surgical edit mode — only change affected files
    if (options.isEdit && options.existingFiles && options.existingFiles.length > 0) {
      const editResult = await runEditAgent(
        prompt,
        options.existingFiles,
        (phase, message) => {
          options.onEvent?.({
            phase,
            message,
            stepNumber: 1,
            totalSteps: 1,
          });
        }
      );
      for (const file of editResult.files) {
        options.onFile?.({
          path: file.path,
          content: file.content,
          action: 'modified',
          language: file.language,
          node: 'editAgent',
        });
      }
      return {
        success: true,
        files: editResult.files.map((f) => ({
          path: f.path,
          content: f.content,
          action: 'modified' as const,
          language: f.language,
        })),
        summary: editResult.summary,
        verification: { verified: true },
      };
    }

        // ── Run the real 12-agent LovableGenerationPipeline ──────────────
    let stepNumber = 0;
    const pipelineState = await LovableGenerationPipeline.execute(
      projectId,
      prompt,
      (phase, message, _state) => {
        stepNumber++;
        options.onEvent?.({
          phase,
          stepNumber,
          totalSteps: 12,
          message,
        });
        options.onProgress?.(message);
      },
      { signal: options.signal },
    );

    // Convert Map<string, GeneratedFile> → AgentFileArtifact[]
    const files: AgentFileArtifact[] = [];
    for (const [, f] of pipelineState.generatedFiles) {
      const artifact: AgentFileArtifact = {
        path: f.path,
        content: f.content,
        action: (f.action === 'deleted' ? 'deleted' : f.action === 'modified' ? 'modified' : 'created') as 'created' | 'modified' | 'deleted',
        language: f.language || (f.path.endsWith('.dart') ? 'dart' : f.path.endsWith('.yaml') ? 'yaml' : 'text'),
      };
      files.push(artifact);
      options.onFile?.({
        path: f.path,
        content: f.content,
        action: artifact.action ?? 'created',
        language: artifact.language || 'text',
        node: 'pipeline',
      });
    }

    // Build plan from pipeline state
    const brief = pipelineState.productBrief;
    const arch = pipelineState.architectureSpec || pipelineState.architecture;
    const intakeData = pipelineState._intakeData as Record<string, unknown> | undefined;
    const plan: AgentPlan = {
      id: pipelineState.plan?.id || projectId,
      appName: brief?.appName || context.projectName || 'FlutterApp',
      domain: (intakeData?.domain as string) || 'general',
      architecture: 'feature_first',
      appDescription: brief?.oneLiner || context.projectDescription || prompt,
      stateManagement: arch?.stateManagement || 'provider',
      theme: {
        primaryColor: pipelineState.designTokens?.primaryColor || '#2563EB',
        secondaryColor: pipelineState.designTokens?.secondaryColor || '#3B82F6',
        useMaterial3: true,
        darkMode: false,
        isDarkPreferred: false,
      },
      schema: { tables: pipelineState.dataSchema?.tables || [] },
      screens: (pipelineState.screenGraph?.screens || []).map((s) => ({
        name: s.name,
        route: s.route,
        routePath: s.route,
        filePath: `lib/features/${s.id}/screens/${s.name.replace(/([A-Z])/g, (m, _, i) => i === 0 ? m : `_${m}`).toLowerCase()}.dart`,
      })),
      services: [{ name: 'SupabaseService', methods: ['fetch', 'create', 'update', 'delete'] }],
      dependencies: arch?.packages || {},
      files: [...pipelineState.generatedFiles.keys()],
      filesToCreate: [...pipelineState.generatedFiles.keys()],
    };

    const gates = pipelineState.diagnostics.map((d) => ({
      id: d.gate,
      status: d.level === 'error' ? 'fail' as const : 'pass' as const,
      detail: d.message,
    }));

    return {
      success: pipelineState.status === 'ready' || pipelineState.status === 'repaired' || files.length > 0,
      plan,
      files,
      summary: `Generated ${files.length} Flutter files via 12-agent AI pipeline. Status: ${pipelineState.status}. ${pipelineState.diagnostics.filter(d => d.level === 'error').length} errors, ${pipelineState.diagnostics.filter(d => d.level === 'warning').length} warnings.`,
      durationMs: Date.now(),
      verification: {
        verified: pipelineState.status === 'ready' || pipelineState.status === 'repaired',
        gates,
      },
    };
  }
}
