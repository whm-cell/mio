import ts from 'typescript';
import type { CheckedProject } from './source-projects.ts';

function property(node: ts.Node, name: string): ts.Expression | undefined {
  if (ts.isPropertyAccessExpression(node) && node.name.text === name) return node.expression;
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    node.argumentExpression.text === name
  )
    return node.expression;
  return undefined;
}

export function directProcessObject(receiver: ts.Node): boolean {
  if (ts.isIdentifier(receiver) && receiver.text === 'process') return true;
  const global = property(receiver, 'process');
  return !!global && ts.isIdentifier(global) && global.text === 'globalThis';
}

/** Recognize direct global process access; computed names and arbitrary aliases are not data-flow analysis. */
export function directBuiltinAccess(node: ts.Node): boolean {
  const receiver = property(node, 'getBuiltinModule');
  return !!receiver && directProcessObject(receiver);
}

export function restrictedCapability(specifier: string): string | undefined {
  const name = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  const category = name.split('/')[0];
  return category &&
    ['fs', 'child_process', 'sqlite', 'vm', 'worker_threads', 'module'].includes(category)
    ? category
    : undefined;
}

export function allowsCapability(
  project: CheckedProject | undefined,
  file: string,
  name: string,
): boolean {
  if (name !== 'fs' && name !== 'child_process' && name !== 'sqlite') return false;
  return project?.declaration.capabilities?.[name]?.includes(file) ?? false;
}

export function allowsPackageAdapter(
  project: CheckedProject | undefined,
  file: string,
  name: 'cos-nodejs-sdk-v5' | 'amqplib',
): boolean {
  return project?.declaration.packageAdapters?.[name]?.includes(file) ?? false;
}
