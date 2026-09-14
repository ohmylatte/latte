import { LatteError } from '../core/errors';
import type { GenerationErrorCode } from '../../shared/generationContracts';

export class GenerationContractError extends LatteError {
  constructor(code: GenerationErrorCode, message?: string) {
    super(code, message ?? code);
    this.name = 'GenerationContractError';
  }
}
