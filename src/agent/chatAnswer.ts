export interface ChatAnswerOptions {
  projectName?: string;
  projectSummary?: string;
  history?: Array<{ role: string; content: string }>;
  apiKey?: string;
  model?: string;
  onProgress?: (message: string) => void;
  onToken?: (token: string) => void;
  onRetry?: (message: string) => void;
  signal?: AbortSignal;
}

export async function answerGeneralQuestion(
  question: string,
  options: ChatAnswerOptions = {}
): Promise<string> {
  const apiKey = options.apiKey || '';
  if (!apiKey) {
    return `I can help you build Flutter apps, design screens, and connect Supabase backends. How would you like to update "${options.projectName || 'this project'}"?`;
  }

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: options.model || 'nvidia/nemotron-3.5-lightning:free',
        messages: [
          {
            role: 'system',
            content: `You are FlutterForge, a Flutter and Dart AI assistant. Answer the user's question concisely and accurately. Current project: ${options.projectName || 'Flutter Project'}.`,
          },
          ...(options.history || []),
          { role: 'user', content: question },
        ],
      }),
      signal: options.signal,
    });

    if (!res.ok) {
      return `I understand you asked about "${question}". To modify the Flutter app, tell me what screens or widgets you'd like to add!`;
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || 'Done.';
  } catch {
    return `To build or edit your Flutter app, describe the screen, feature, or styling you want to see!`;
  }
}

