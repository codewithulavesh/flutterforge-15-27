/**
 * Path of the on-disk project that the preview/publish server materializes.
 * Generation happens in the browser; the local server only compiles the files
 * it receives, so this is the real folder for "Open project folder".
 */
const API_BASE = (typeof window !== 'undefined' && (window as any).flutterforgeDesktop?.isDesktop
  ? ''
  : import.meta.env.VITE_PREVIEW_API_URL || '').replace(/\/+$/, '');

export async function getProjectWorkspacePath(projectId: string): Promise<string | null> {
  try {
    const response = await fetch(
      `${API_BASE}/api/preview/project/${encodeURIComponent(projectId)}/workspace`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (!response.ok) return null;
    const body = await response.json() as { workspace?: string; exists?: boolean };
    return body.workspace || null;
  } catch {
    return null;
  }
}
