import * as z from 'zod';
const id = z.string().min(1).max(1024);
const model = { ModelUID: id };
const read = (method, data) => z.strictObject({ method: z.literal(method), data: z.strictObject(data) });
export const bridgeReadSchema = z.discriminatedUnion('method', [
  ...['GetDocuments', 'GetCurrentDocumentUID', 'GetCurrentModelUID', 'GetCurrentEditMode'].map(method => read(method, {})),
  read('GetDocument', { DocumentUID: id }),
  ...['GetParameters', 'GetParameterGroups', 'GetPartStructure', 'GetDeformerStructure', 'GetPhysicsInfo'].map(method => read(method, model)),
  read('GetParameterValues', { ...model, Ids: z.array(id).max(1000).optional() }),
  read('GetObject', { ...model, Id: id }),
]);
export const bridgePoseSchema = z.discriminatedUnion('method', [
  read('SetParameterValues', { ...model, Parameters: z.array(z.strictObject({ Id: id, Value: z.number().finite() })).min(1).max(1000) }),
  read('ClearParameterValues', model),
]);
