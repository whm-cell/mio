import { randomUUID } from 'node:crypto';

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const createId = (): string => randomUUID();
export const isUuidV4 = (value: string): boolean => uuidV4.test(value);
