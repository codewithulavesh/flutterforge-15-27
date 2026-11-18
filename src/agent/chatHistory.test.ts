// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ConversationContextManager, validateMessageRoles, estimateTokens } from './chatHistory';

describe('ConversationContextManager', () => {
  it('validates message roles and removes empty messages', () => {
    const raw = [
      { role: 'user', content: 'Hello' },
      { role: 'unknown', content: 'How can I help?' },
      { role: 'user', content: '   ' }, // empty
      { role: 'assistant', content: 'Sure!' },
      { role: 'assistant', content: 'Sure!' }, // duplicate consecutive
    ];

    const validated = validateMessageRoles(raw);
    expect(validated).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'user', content: 'How can I help?' },
      { role: 'assistant', content: 'Sure!' },
    ]);
  });

  it('preserves recent messages while respecting token budget', () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i}: This is a conversation turn discussing Flutter features.`,
    }));

    const managed = ConversationContextManager.manage(messages, {
      maxTokens: 500,
      recentMessageWindow: 6,
    });

    expect(managed.includedMessageCount).toBeLessThanOrEqual(6);
    expect(managed.includedMessageCount).toBeGreaterThan(0);
    expect(managed.estimatedTokens).toBeLessThanOrEqual(500);
    // Preserves recent messages at the tail of the conversation
    const lastIncluded = managed.messages[managed.messages.length - 1];
    expect(lastIncluded.content).toContain('Message 19');
  });

  it('generates a summary of older decisions when conversation exceeds window', () => {
    const messages = [
      { role: 'user', content: 'We should use Provider for state management' },
      { role: 'assistant', content: 'Understood. Provider is configured in pubspec.yaml.' },
      { role: 'user', content: 'Add a login screen with Supabase auth' },
      { role: 'assistant', content: 'Created lib/screens/login_screen.dart with Supabase auth.' },
      { role: 'user', content: 'Now make the title bold' },
      { role: 'assistant', content: 'Updated title style in home_screen.dart.' },
      { role: 'user', content: 'What is the current state management?' },
    ];

    const managed = ConversationContextManager.manage(messages, {
      maxTokens: 2000,
      recentMessageWindow: 3,
    });

    expect(managed.summary).toBeDefined();
    expect(managed.summary).toContain('Prior conversation summary');
    expect(managed.summary).toContain('Provider');
  });

  it('accurately estimates tokens for prose and code', () => {
    const prose = 'This is a simple sentence in plain English.';
    const code = 'class MyWidget extends StatelessWidget { const MyWidget(); }';

    expect(estimateTokens(prose)).toBeGreaterThan(5);
    expect(estimateTokens(code)).toBeGreaterThan(5);
  });
});
