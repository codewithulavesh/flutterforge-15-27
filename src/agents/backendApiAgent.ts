import type { ProjectState, GeneratedFile } from '../orchestrator/state';
import { callLLMText, parseFilesFromLLMOutput, agentModelFor } from './llmClient';

export async function runBackendApiAgent(state: ProjectState): Promise<Partial<ProjectState>> {
  const appName = state.productBrief?.appName || 'App';
  const pkgName = appName.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_');
  const arch = state.architectureSpec;
  const dataSchema = state.dataSchema;
  const files = new Map<string, GeneratedFile>(state.generatedFiles);

  const needsSupabase = arch?.backendMode === 'supabase';

  if (!needsSupabase) {
    // Generate local storage service
    files.set('lib/core/services/local_storage_service.dart', {
      path: 'lib/core/services/local_storage_service.dart',
      action: 'created',
      language: 'dart',
      content: `import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

class LocalStorageService {
  static SharedPreferences? _prefs;

  static Future<void> init() async {
    _prefs = await SharedPreferences.getInstance();
    debugPrint('[LocalStorageService] Initialized');
  }

  static Future<bool> setString(String key, String value) async {
    return _prefs?.setString(key, value) ?? Future.value(false);
  }

  static String? getString(String key) => _prefs?.getString(key);

  static Future<bool> setBool(String key, bool value) async {
    return _prefs?.setBool(key, value) ?? Future.value(false);
  }

  static bool? getBool(String key) => _prefs?.getBool(key);

  static Future<bool> remove(String key) async {
    return _prefs?.remove(key) ?? Future.value(false);
  }

  static Future<bool> clear() async {
    return _prefs?.clear() ?? Future.value(false);
  }
}
`,
    });
    return {
      generatedFiles: files,
      logs: [...state.logs, `[Backend API Agent] Backend mode: local — generated LocalStorageService with SharedPreferences.`],
    };
  }

  // Generate Supabase backend files via LLM
  const tables = dataSchema?.tables || [];
  const tableDescriptions = tables
    .map(
      (t) =>
        `Table: ${t.name}
  Columns: ${t.columns.map((c) => `${c.name} (${c.type}${c.isPrimary ? ', PK' : ''}${c.isNullable ? ', nullable' : ''})`).join(', ')}
  RLS: ${t.enableRLS}
  Policies: ${t.policies.map((p) => p.name).join(', ')}`
    )
    .join('\n\n');

  let raw = '';
  try {
    raw = await callLLMText(
      [
        {
          role: 'system',
          content: `You are a senior Flutter/Supabase backend developer. Generate production-quality Dart service code.

RULES:
1. Use supabase_flutter package (SupabaseClient from Supabase.instance.client)
2. All methods are async and return typed results
3. Handle errors with try/catch and throw descriptive exceptions
4. Use proper Dart typing — no dynamic types
5. Include CRUD operations for each table
6. Auth service: signIn, signUp, signOut, currentUser, authStateChanges stream
7. No hardcoded URLs or keys — use Supabase.instance.client

Output format:
// FILE: lib/core/services/supabase_service.dart
\`\`\`dart
...full Dart service code...
\`\`\`

// FILE: lib/core/services/auth_service.dart
\`\`\`dart
...full Dart auth service code...
\`\`\`

// FILE: supabase/migrations/001_initial_schema.sql
\`\`\`sql
...full SQL migration...
\`\`\``,
        },
        {
          role: 'user',
          content: `Generate Supabase backend services for "${appName}" (package: ${pkgName}).

Database schema:
${tableDescriptions || 'Infer appropriate tables from the app domain: ' + state.productBrief?.oneLiner}

App domain: ${(state as Record<string, unknown>)._intakeData ? JSON.stringify((state as Record<string, unknown>)._intakeData) : state.productBrief?.oneLiner}

Generate:
1. SupabaseService with CRUD for all tables
2. AuthService with signIn/signUp/signOut/currentUser
3. SQL migration file with CREATE TABLE, RLS policies, and indexes`,
        },
      ],
      {
        model: agentModelFor('backend-api'),
        temperature: 0.2,
        maxTokens: 6000,
      }
    );
  } catch (err) {
    console.warn('[BackendApiAgent] LLM failed, using Supabase template:', err);
    raw = '';
  }

  const parsed = parseFilesFromLLMOutput(raw);
  for (const f of parsed) {
    const cleanContent = f.content
      .replace(/^```(?:dart|sql)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
    files.set(f.path, {
      path: f.path,
      action: 'created',
      language: f.path.endsWith('.sql') ? 'sql' : 'dart',
      content: cleanContent,
    });
  }

  // Fallback: always ensure SupabaseService exists
  if (!files.has('lib/core/services/supabase_service.dart')) {
    files.set('lib/core/services/supabase_service.dart', {
      path: 'lib/core/services/supabase_service.dart',
      action: 'created',
      language: 'dart',
      content: generateSupabaseServiceFallback(pkgName, tables),
    });
  }

  if (!files.has('lib/core/services/auth_service.dart')) {
    files.set('lib/core/services/auth_service.dart', {
      path: 'lib/core/services/auth_service.dart',
      action: 'created',
      language: 'dart',
      content: generateAuthServiceFallback(),
    });
  }

  return {
    generatedFiles: files,
    logs: [
      ...state.logs,
      `[Backend API Agent] Supabase mode: generated SupabaseService, AuthService, and ${dataSchema?.migrations?.length ?? 0} SQL migrations. AI files: ${parsed.length}`,
    ],
  };
}

function generateSupabaseServiceFallback(pkgName: string, tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }>): string {
  const tableNames = tables.map((t) => t.name).filter(Boolean);
  const tableServices = tableNames.map((tableName) => `
  // ═══ ${tableName.toUpperCase()} ═══
  Future<List<Map<String, dynamic>>> get${tableName.charAt(0).toUpperCase() + tableName.slice(1)}() async {
    try {
      final response = await _client.from('${tableName}').select().order('created_at', ascending: false);
      return List<Map<String, dynamic>>.from(response as List);
    } catch (e) {
      throw Exception('Failed to fetch ${tableName}: \$e');
    }
  }

  Future<Map<String, dynamic>> create${tableName.charAt(0).toUpperCase() + tableName.slice(1)}(Map<String, dynamic> data) async {
    try {
      final response = await _client.from('${tableName}').insert(data).select().single();
      return response as Map<String, dynamic>;
    } catch (e) {
      throw Exception('Failed to create ${tableName}: \$e');
    }
  }

  Future<void> update${tableName.charAt(0).toUpperCase() + tableName.slice(1)}(String id, Map<String, dynamic> data) async {
    try {
      await _client.from('${tableName}').update(data).eq('id', id);
    } catch (e) {
      throw Exception('Failed to update ${tableName}: \$e');
    }
  }

  Future<void> delete${tableName.charAt(0).toUpperCase() + tableName.slice(1)}(String id) async {
    try {
      await _client.from('${tableName}').delete().eq('id', id);
    } catch (e) {
      throw Exception('Failed to delete ${tableName}: \$e');
    }
  }`).join('\n');

  return `import 'package:supabase_flutter/supabase_flutter.dart';

class SupabaseService {
  SupabaseService._();
  static final SupabaseService instance = SupabaseService._();

  SupabaseClient get _client => Supabase.instance.client;
  String? get currentUserId => _client.auth.currentUser?.id;
${tableServices}
}
`;
}

function generateAuthServiceFallback(): string {
  return `import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:flutter/foundation.dart';

class AuthService {
  AuthService._();
  static final AuthService instance = AuthService._();

  SupabaseClient get _client => Supabase.instance.client;

  User? get currentUser => _client.auth.currentUser;
  bool get isAuthenticated => currentUser != null;

  Stream<AuthState> get authStateChanges => _client.auth.onAuthStateChange;

  Future<AuthResponse> signUp({required String email, required String password}) async {
    try {
      final response = await _client.auth.signUp(email: email, password: password);
      debugPrint('[AuthService] Sign up: \${response.user?.email}');
      return response;
    } catch (e) {
      throw Exception('Sign up failed: \$e');
    }
  }

  Future<AuthResponse> signIn({required String email, required String password}) async {
    try {
      final response = await _client.auth.signInWithPassword(email: email, password: password);
      debugPrint('[AuthService] Signed in: \${response.user?.email}');
      return response;
    } catch (e) {
      throw Exception('Sign in failed: \$e');
    }
  }

  Future<void> signOut() async {
    try {
      await _client.auth.signOut();
      debugPrint('[AuthService] Signed out');
    } catch (e) {
      throw Exception('Sign out failed: \$e');
    }
  }

  Future<UserResponse> updateProfile({String? email, String? password}) async {
    try {
      final attrs = UserAttributes(email: email, password: password);
      return await _client.auth.updateUser(attrs);
    } catch (e) {
      throw Exception('Profile update failed: \$e');
    }
  }

  Future<void> resetPassword(String email) async {
    try {
      await _client.auth.resetPasswordForEmail(email);
    } catch (e) {
      throw Exception('Password reset failed: \$e');
    }
  }
}
`;
}
