import type { Rule, Scope } from 'eslint';

type Node = Parameters<Rule.RuleContext['sourceCode']['getScope']>[0];

function unwrapped(node: Node): Node {
  while (
    [
      'ChainExpression',
      'TSAsExpression',
      'TSTypeAssertion',
      'TSNonNullExpression',
      'TSSatisfiesExpression',
    ].includes(node.type)
  )
    node = (node as unknown as { expression: Node }).expression;
  return node;
}

function member(node: Node) {
  node = unwrapped(node);
  if (node.type !== 'MemberExpression') return undefined;
  const name =
    !node.computed && node.property.type === 'Identifier'
      ? node.property.name
      : node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string'
        ? node.property.value
        : undefined;
  return name === undefined ? undefined : { object: node.object, name };
}

/** Reuse ESLint's value-reference resolution; do not build a second scope or type graph. */
export const foundationPrimitives: Rule.RuleModule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      uuid: 'FOUNDATION_UUID: use createId from @mio/foundation/identifiers.',
      epoch: 'FOUNDATION_TIME: use epochMs from @mio/foundation/time.',
      monotonic: 'FOUNDATION_TIME: use monotonicMs from @mio/foundation/time.',
      date: 'FOUNDATION_TIME: use epochMs/utcISOString from @mio/foundation/time.',
    },
  },
  create(context) {
    const references = new WeakMap<Node, Scope.Variable | null>();
    const local = (node: Node) => {
      node = unwrapped(node);
      const variable = references.get(node);
      return variable?.defs.length ? variable : undefined;
    };
    const globalObject = (node: Node, name: string): boolean => {
      node = unwrapped(node);
      if (node.type === 'Identifier') return node.name === name && !local(node);
      const property = member(node);
      if (property?.name !== name) return false;
      const object = unwrapped(property.object);
      return object.type === 'Identifier' && object.name === 'globalThis' && !local(object);
    };
    const imported = (node: Node, module: string, name?: string): boolean => {
      node = unwrapped(node);
      if (node.type !== 'Identifier') return false;
      return (
        local(node)?.defs.some((definition) => {
          if (definition.type !== 'ImportBinding') return false;
          const source = definition.parent.source.value;
          if (source !== module && source !== 'node:' + module) return false;
          const specifier = definition.node;
          if (specifier.type !== 'ImportSpecifier') return name === undefined;
          const exported =
            specifier.imported.type === 'Identifier'
              ? specifier.imported.name
              : specifier.imported.value;
          return exported === name;
        }) ?? false
      );
    };
    const performanceObject = (node: Node): boolean => {
      if (globalObject(node, 'performance') || imported(node, 'perf_hooks', 'performance'))
        return true;
      const property = member(node);
      return property?.name === 'performance' && imported(property.object, 'perf_hooks');
    };
    return {
      Program() {
        for (const scope of context.sourceCode.scopeManager.scopes)
          for (const reference of scope.references)
            if (reference.identifier.type === 'Identifier')
              references.set(reference.identifier, reference.resolved);
      },
      CallExpression(node) {
        const expression = unwrapped(node.callee);
        const property = member(expression);
        if (
          imported(expression, 'crypto', 'randomUUID') ||
          (property?.name === 'randomUUID' &&
            (globalObject(property.object, 'crypto') || imported(property.object, 'crypto')))
        )
          context.report({ node, messageId: 'uuid' });
        if (property?.name === 'now' && globalObject(property.object, 'Date'))
          context.report({ node, messageId: 'epoch' });
        if (property?.name === 'now' && performanceObject(property.object))
          context.report({ node, messageId: 'monotonic' });
      },
      NewExpression(node) {
        if (node.arguments.length === 0 && globalObject(node.callee, 'Date'))
          context.report({ node, messageId: 'date' });
      },
    };
  },
};
