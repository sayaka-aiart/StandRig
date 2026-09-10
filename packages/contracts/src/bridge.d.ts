import type { ZodType } from 'zod';
export const bridgeReadSchema: ZodType<{ method: string; data: Record<string, unknown> }>;
export const bridgePoseSchema: ZodType<{ method: string; data: Record<string, unknown> }>;
