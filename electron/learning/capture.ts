import type { CaptureMode, LearningSignal, SignalKind } from './types';

/**
 * Opt-in capture seam. Independent of the latte-decision protocol.
 * A completed assistant message is never treated as validated learning.
 */
export function isDecisionProtocolText(text: string): boolean {
  return /latte-decision/i.test(text);
}

export function captureEnabled(mode: CaptureMode, kind: SignalKind): boolean {
  if (mode === 'off') return false;
  if (mode === 'manual') return kind === 'explicit_capture';
  return true;
}

export function interpretCompletedAssistantMessage(_input: {
  chatId: string;
  messageId: string;
  text: string;
}): LearningSignal | null {
  // completed ≠ verified procedure. Observation of chat is a later opt-in,
  // never inferred from this event.
  return null;
}

export type CapturePolicy = {
  mode: CaptureMode;
};

export function allowObserve(policy: CapturePolicy, kind: SignalKind): boolean {
  return captureEnabled(policy.mode, kind);
}
