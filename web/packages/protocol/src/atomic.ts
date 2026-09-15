import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { COMMAND_SCHEMAS, COMMAND_CATALOG, type NonBatch } from './schema.ts';

export const RegisterAssetSchema = z.object({ type: z.literal('registerAsset'), resourceId: z.string().min(1), probeId: z.string().min(1), name: z.string().min(1).max(256).optional() });
export type AtomicCommand = NonBatch | z.infer<typeof RegisterAssetSchema>;
export const ATOMIC_COMMAND_SCHEMAS = { ...COMMAND_SCHEMAS, registerAsset: RegisterAssetSchema };

export const RESULT_FIELDS = ['assetId', 'trackId', 'clipId', 'leftClipId', 'rightClipId', 'effectId'] as const;
export type ResultField = typeof RESULT_FIELDS[number];
export interface OperationRef { $ref: { operationId: string; field: ResultField } }
export function ref(operationId: string, field: ResultField): OperationRef {
  return { $ref: { operationId, field } };
}
type Args<C> = { [K in keyof C as K extends 'type' ? never : K]: K extends 'assetId' | 'trackId' | 'clipId' | 'effectId' ? C[K] | OperationRef : C[K] };
export type PlanCommand = { [T in AtomicCommand['type']]: { type: T } & Args<Extract<AtomicCommand, { type: T }>> }[AtomicCommand['type']];
export type OperationBuilders = { [T in AtomicCommand['type']]: (args: Args<Extract<AtomicCommand, { type: T }>>) => { type: T } & Args<Extract<AtomicCommand, { type: T }>> };
/** Pure data construction: this never dispatches or allocates document IDs. */
export const ops = Object.freeze(Object.fromEntries(Object.keys(ATOMIC_COMMAND_SCHEMAS).map(type => [
  type, (args: object) => ({ ...structuredClone(args), type }),
]))) as OperationBuilders;
export interface AtomicOperation { id: string; command: PlanCommand }
export interface AtomicPlan { runtimeId: string; expectedRevision: number; operations: AtomicOperation[] }
export type TransactionRequest =
  | ({ action: 'validate' } & AtomicPlan)
  | ({ action: 'commit'; requestId: string } & AtomicPlan)
  | { action: 'status'; runtimeId: string; requestId: string };

export const TRANSACTION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['action', 'runtimeId'],
  properties: {
    action: { enum: ['validate', 'commit', 'status'] }, runtimeId: { type: 'string' },
    expectedRevision: { type: 'integer', minimum: 0 }, requestId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' },
    operations: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', additionalProperties: false, required: ['id', 'command'], properties: {
      id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' }, command: { type: 'object', description: 'Use the named command capability schema. No nested batch.' },
    } } },
  },
  allOf: [
    { if: { properties: { action: { const: 'commit' } } }, then: { required: ['requestId', 'expectedRevision', 'operations'] } },
    { if: { properties: { action: { const: 'validate' } } }, then: { required: ['expectedRevision', 'operations'], not: { required: ['requestId'] } } },
    { if: { properties: { action: { const: 'status' } } }, then: { required: ['requestId'], not: { anyOf: [{ required: ['expectedRevision'] }, { required: ['operations'] }] } } },
  ],
};

export function commandDefinition(type: AtomicCommand['type']) {
  const inputSchema = zodToJsonSchema(ATOMIC_COMMAND_SCHEMAS[type], { $refStrategy: 'none' });
  const referenceFields = Object.keys(ATOMIC_COMMAND_SCHEMAS[type].shape).filter(k => ['assetId', 'trackId', 'clipId', 'effectId'].includes(k));
  const properties = (inputSchema as { properties: Record<string, unknown> }).properties;
  for (const key of referenceFields) properties[key] = { anyOf: [properties[key], {
    type: 'object', additionalProperties: false, required: ['$ref'], properties: { $ref: {
      type: 'object', additionalProperties: false, required: ['operationId', 'field'],
      properties: { operationId: { type: 'string' }, field: { enum: [...RESULT_FIELDS] } },
    } },
  }] };
  const fields = type === 'splitClip' ? ['leftClipId', 'rightClipId']
    : type === 'addAsset' || type === 'registerAsset' ? ['assetId'] : type === 'addTrack' ? ['trackId']
      : type === 'addClip' || type === 'addTextClip' || type === 'duplicateClip' ? ['clipId'] : type === 'addEffect' ? ['effectId'] : [];
  return { name: type, summary: type === 'registerAsset' ? 'resourceId, probeId, name? — register a successfully probed resource; no clip insertion or file import' : COMMAND_CATALOG.find(c => c.type === type)!.summary,
    category: 'command', schemaVersion: 1, inputSchema,
    resultSchema: { type: 'object', properties: Object.fromEntries(fields.map(f => [f, { type: 'string' }])), required: fields, additionalProperties: false },
    referenceFields,
    validation: 'Runtime validation also checks document constraints and schema refinements.',
  };
}
