const GPU = /^gpus?$/;
const WRAPPERS = new Set(['ChainExpression', 'TSNonNullExpression', 'TSAsExpression', 'TSSatisfiesExpression']);
const COPIES = new Set(['filter', 'map', 'flatMap', 'slice', 'concat', 'toReversed', 'toSpliced', 'with', 'reverse', 'values']);
const POSITIONAL = new Set(['at', 'pop', 'shift', 'next', 'splice', 'toSpliced', 'with', 'entries', 'keys']);
const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionExpression']);
const INDEX_PARAM = new Map([
  ...['find', 'findIndex', 'findLast', 'findLastIndex', 'filter', 'some', 'every', 'map', 'flatMap', 'forEach'].map((m) => [m, 1]),
  ['reduce', 2],
  ['reduceRight', 2],
]);

const staticKey = (key, computed) => (key.type === 'Literal' ? String(key.value) : computed ? '' : key.name);

const method = (call) => (call.callee.type === 'MemberExpression' ? staticKey(call.callee.property, call.callee.computed) : '');

const takesOrGivesPositions = (call) => POSITIONAL.has(method(call)) || (method(call) === 'slice' && call.arguments.length > 0);

const isCall = (call, object, name) => method(call) === name && call.callee.object.type === 'Identifier' && call.callee.object.name === object;

const hasPositionKey = (pattern) => pattern.properties.some((p) => p.type === 'Property' && (p.computed || (p.key.type === 'Literal' && typeof p.key.value === 'number')));

export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      gpuAt: 'Read a GPU by its index with gpuAt() (lib/gpu.ts): a sample lists only the GPUs that reported, so position 0 can be another vendor.',
    },
  },
  create(context) {
    const report = (node) => context.report({ node, messageId: 'gpuAt' });
    const copies = new Set();
    const variableOf = (id) => {
      for (let scope = context.sourceCode.getScope(id); scope; scope = scope.upper) {
        const v = scope.set.get(id.name);
        if (v) return v;
      }
      return null;
    };
    function derivesFromGpuList(node) {
      while (WRAPPERS.has(node?.type)) node = node.expression;
      switch (node?.type) {
        case 'Identifier':
          return GPU.test(node.name) || copies.has(variableOf(node));
        case 'MemberExpression':
          return GPU.test(staticKey(node.property, node.computed));
        case 'LogicalExpression':
          return derivesFromGpuList(node.left) || derivesFromGpuList(node.right);
        case 'ConditionalExpression':
          return derivesFromGpuList(node.consequent) || derivesFromGpuList(node.alternate);
        case 'ArrayExpression':
          return node.elements.some((e) => e?.type === 'SpreadElement' && derivesFromGpuList(e.argument));
        case 'CallExpression':
          if (isCall(node, 'Array', 'from') || isCall(node, 'Object', 'values')) return derivesFromGpuList(node.arguments[0]);
          if (node.callee.type === 'Identifier' && node.callee.name === 'structuredClone') return derivesFromGpuList(node.arguments[0]);
          if (method(node) === 'concat' && node.arguments.some((a) => derivesFromGpuList(a))) return true;
          return COPIES.has(method(node)) && derivesFromGpuList(node.callee.object);
        default:
          return false;
      }
    }
    return {
      MemberExpression(node) {
        if (node.computed && derivesFromGpuList(node.object)) report(node);
      },
      CallExpression(node) {
        const name = method(node);
        if (!name || !derivesFromGpuList(node.callee.object)) return;
        const callback = node.arguments[0];
        if (takesOrGivesPositions(node) || (INDEX_PARAM.has(name) && FUNCTIONS.has(callback?.type) && callback.params.length > INDEX_PARAM.get(name))) report(node);
      },
      VariableDeclarator(node) {
        if (node.id.type === 'Identifier' && node.init && derivesFromGpuList(node.init)) copies.add(variableOf(node.id));
        if ((node.id.type === 'ArrayPattern' || (node.id.type === 'ObjectPattern' && hasPositionKey(node.id))) && derivesFromGpuList(node.init)) report(node);
      },
      AssignmentExpression(node) {
        if (node.left.type === 'Identifier' && derivesFromGpuList(node.right)) copies.add(variableOf(node.left));
        if ((node.left.type === 'ArrayPattern' || (node.left.type === 'ObjectPattern' && hasPositionKey(node.left))) && derivesFromGpuList(node.right)) report(node);
      },
      'ObjectPattern > Property'(node) {
        const value = node.value.type === 'AssignmentPattern' ? node.value.left : node.value;
        if (value.type === 'ArrayPattern' && GPU.test(staticKey(node.key, node.computed))) report(node);
      },
    };
  },
};
