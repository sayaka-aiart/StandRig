import type { ParameterValues } from './types.js';
/** Cubism exp3 JSON envelope; catalog ID/name live outside this interchange document. */
export interface ExpressionDocument {
  Version?: 3;
  Type: 'Live2D Expression';
  /** @minimum 0 @maximum 60 */
  FadeInTime?: number;
  /** @minimum 0 @maximum 60 */
  FadeOutTime?: number;
  Parameters: Array<{ Id: string; Value: number; Blend?: 'Add' | 'Multiply' | 'Overwrite' }>;
}
export interface RegisteredExpression { id: string; name: string; document: ExpressionDocument; }
export type VisemeId = 'A' | 'I' | 'U' | 'E' | 'O' | 'Silence';
export interface VisemePreset { id: VisemeId; values: ParameterValues; }
export interface VisemeBank {
  mode: 'pose' | 'blend-shape';
  /** @minimum 0 @maximum 60 */
  fadeInTime?: number;
  /** @minimum 0 @maximum 60 */
  fadeOutTime?: number;
  presets: VisemePreset[];
}
export interface FacialPresets { version: 1; expressions: RegisteredExpression[]; visemes?: VisemeBank; }
export interface VisemeWeights {
  /** @minimum 0 @maximum 1 */
  A?: number;
  /** @minimum 0 @maximum 1 */
  I?: number;
  /** @minimum 0 @maximum 1 */
  U?: number;
  /** @minimum 0 @maximum 1 */
  E?: number;
  /** @minimum 0 @maximum 1 */
  O?: number;
  /** @minimum 0 @maximum 1 */
  Silence?: number;
}
export interface ExpressionRequest {
  action: 'expression'; id: string;
  /** @minimum 0 @maximum 1 */
  strength?: number;
}
export interface VisemeRequest {
  action: 'viseme'; id: VisemeId;
  /** @minimum 0 @maximum 1 */
  strength?: number;
}
export type FacialRequest =
  | ExpressionRequest
  | VisemeRequest
  | { action: 'visemes'; weights: VisemeWeights }
  | { action: 'clear'; layer?: 'expression' | 'viseme' | 'all'; immediate?: boolean };
export interface FacialState {
  expressionId: string | null;
  expressionWeights: Record<string, number>;
  visemeWeights: VisemeWeights;
  transitioning: boolean;
}
