export interface ResultEvent {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  errors?: string[];
}

/** The human-readable text of a failed result event */
export function resultErrorText(e: ResultEvent): string {
  return String(e.result || (Array.isArray(e.errors) && e.errors.join('\n')) || e.subtype || 'Something went wrong');
}

/**
 * The notice a result event should produce. A turn the user stopped (Stop button or
 * interrupt-and-replace) never shows a red error — the SIGINT'd process returns a
 * non-success result, which is expected, not a failure.
 */
export function resultNotice(e: ResultEvent, stopped: boolean): { level: 'error'; text: string } | null {
  if (stopped) return null;
  if (e.is_error || e.subtype !== 'success') return { level: 'error', text: resultErrorText(e) };
  return null;
}
