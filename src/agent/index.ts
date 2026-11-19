import type { AgentContext, AgentFileArtifact, AgentGenerationOptions, AgentGenerationResult, AgentPlan } from './types';
import { generateFlutterProjectFiles, generateMinimalStarterFiles } from '../utils/flutterTemplates';
import { SkillRegistry } from './skills';
import { keyPool } from './keyPool';
import { executeEngineer } from './engineClient';

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
    return executeEngineer(prompt, context, options);
  }
}
