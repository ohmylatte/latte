import type { Provider } from '../../shared/contracts';
import { ValidationError } from '../core/errors';

/** The only executables Latte will ever look up or launch. */
export const PROVIDERS: readonly Provider[] = ['claude', 'codex', 'opencode', 'grok', 'hermes'];

export const PROVIDER_LABEL: Record<Provider, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  opencode: 'OpenCode',
  grok: 'Grok',
  hermes: 'Hermes',
};

export function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

export function assertProvider(value: unknown): asserts value is Provider {
  if (!isProvider(value)) throw new ValidationError('Unknown provider');
}
