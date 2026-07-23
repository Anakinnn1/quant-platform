import type { AISignalRequest } from './types';

export interface AIProvider {
  readonly name: string;
  /** Returns the raw (unvalidated) response object from the upstream model. */
  requestSignal(ctx: AISignalRequest): Promise<unknown>;
}
