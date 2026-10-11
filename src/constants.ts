export const TARGET = 'cf-best-ip.thanejoss.com';
export const TTL = 300;
export const RUN_SECONDS = 600;
export const PROBE_BYTES = 262144;
export const ROUNDS = 3;
export const TIMEOUT_MS = 6000;
export const SAMPLE_SIZE = 10;

export class AppError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
