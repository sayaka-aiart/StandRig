import type { ZodType } from 'zod';
import type { ModelingOperation } from '@standrig/core/modelingOps';
import type { QaCheckRequest } from '@standrig/core/qaCheck';
export const operationSchema: ZodType<ModelingOperation>;
export const qaSchema: ZodType<QaCheckRequest>;
export const transactionSchema: ZodType<{expectedRevision:string;commit:boolean;operations:ModelingOperation[];qa:QaCheckRequest}>;

export const READ_ONLY_BODY_ROUTES: Set<string>;
