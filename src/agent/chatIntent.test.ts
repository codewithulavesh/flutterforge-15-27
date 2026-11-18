// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  detectIntentHeuristic,
  classifyChatIntent,
  BUILDER_INTENTS,
  PROJECT_AWARE_INTENTS,
} from './chatIntent';

describe('chatIntent routing', () => {
  it('correctly classifies General smalltalk & greetings', () => {
    const inputs = ['Hello', 'Hi there!', 'thanks a lot', 'good morning', 'who are you?'];
    for (const input of inputs) {
      const decision = detectIntentHeuristic(input);
      expect(decision.intent).toBe('general');
      expect(BUILDER_INTENTS.has(decision.intent)).toBe(false);
      expect(classifyChatIntent(input)).toBe('chat');
    }
  });

  it('correctly classifies Flutter/Dart concept explanations', () => {
    const inputs = [
      'What is the difference between StatefulWidget and StatelessWidget?',
      'Explain how BuildContext works in Flutter',
      'What is an InheritedWidget in Flutter?',
      'Explain async and await in Dart',
    ];
    for (const input of inputs) {
      const decision = detectIntentHeuristic(input);
      expect(decision.intent).toBe('explanation');
      expect(BUILDER_INTENTS.has(decision.intent)).toBe(false);
      expect(classifyChatIntent(input)).toBe('chat');
    }
  });

  it('correctly classifies Project-aware inquiries', () => {
    const inputs = [
      'What packages are in this project?',
      'Show me the directory tree of this app',
      'What screens exist in this project?',
      'What is in pubspec.yaml?',
      'What does this project do?',
    ];
    for (const input of inputs) {
      const decision = detectIntentHeuristic(input);
      expect(decision.intent).toBe('project');
      expect(PROJECT_AWARE_INTENTS.has(decision.intent)).toBe(true);
      expect(BUILDER_INTENTS.has(decision.intent)).toBe(false);
      expect(classifyChatIntent(input)).toBe('chat');
    }
  });

  it('correctly classifies Architecture inquiries', () => {
    const inputs = [
      'How should I structure folders for this feature?',
      'What clean architecture pattern is recommended for this app?',
      'Should I use BLoC or Riverpod for state management?',
    ];
    for (const input of inputs) {
      const decision = detectIntentHeuristic(input);
      expect(decision.intent).toBe('architecture');
      expect(PROJECT_AWARE_INTENTS.has(decision.intent)).toBe(true);
      expect(BUILDER_INTENTS.has(decision.intent)).toBe(false);
    }
  });

  it('correctly classifies Code Modifications', () => {
    const inputs = [
      'Change the app bar color to deep purple in theme.dart',
      'Update the home screen title to Dashboard',
      'Modify the button style in lib/widgets/action_button.dart',
      'Remove the delete icon from item_card.dart',
    ];
    for (const input of inputs) {
      const decision = detectIntentHeuristic(input);
      expect(decision.intent).toBe('modify');
      expect(BUILDER_INTENTS.has(decision.intent)).toBe(true);
      expect(classifyChatIntent(input)).toBe('build');
    }
  });

  it('correctly classifies New Feature implementations', () => {
    const inputs = [
      'Add a settings screen with dark mode toggle',
      'Implement user authentication with Supabase login',
      'Create a shopping cart checkout page with total calculation',
      'Build a profile screen with avatar upload',
    ];
    for (const input of inputs) {
      const decision = detectIntentHeuristic(input);
      expect(decision.intent).toBe('feature');
      expect(BUILDER_INTENTS.has(decision.intent)).toBe(true);
      expect(classifyChatIntent(input)).toBe('build');
    }
  });

  it('correctly classifies Debugging and error fixing', () => {
    const inputs = [
      'Fix the compile error in lib/main.dart',
      'Debug the NoSuchMethodError on button click',
      'Preview build failed with NoSuchMethodError',
      'Fix the issue where items list throws null pointer exception',
    ];
    for (const input of inputs) {
      const decision = detectIntentHeuristic(input);
      expect(decision.intent).toBe('debug');
      expect(BUILDER_INTENTS.has(decision.intent)).toBe(true);
      expect(classifyChatIntent(input)).toBe('build');
    }
  });

  it('correctly classifies Refactoring and optimization', () => {
    const inputs = [
      'Refactor home_screen to extract the card into its own widget',
      'Clean up the imports and optimize the build method in feed_screen.dart',
      'Extract widget into a separate reusable component',
    ];
    for (const input of inputs) {
      const decision = detectIntentHeuristic(input);
      expect(decision.intent).toBe('refactor');
      expect(BUILDER_INTENTS.has(decision.intent)).toBe(true);
      expect(classifyChatIntent(input)).toBe('build');
    }
  });
});
