// 多跳 MPLS 标签转发校验器核心。
//
// 输入为控制面快照（节点、VRF/标签上下文、LFIB、递归路由、接口），
// 从入口开始逐跳模拟报文的标签栈变化，覆盖 push/swap/pop、PHP、
// 显式空标签、递归下一跳、ECMP 分支与 FRR 备份路径。
//
// 标签查找严格限定在 (节点, 标签上下文) 内：同一个标签值在不同 VRF、
// 不同设备上可以有完全不同的映射，切换上下文后绝不沿用旧映射。

import { ERROR_CODES, EXPLICIT_NULL_LABELS } from './labels.js';

const DEFAULT_LIMITS = Object.freeze({
  maxStackDepth: 8,
  maxHops: 64,
  maxRecursionDepth: 8,
  defaultTtl: 255,
  defaultMtu: 1500,
  defaultPacketSize: 64,
});

export function validateSnapshot(snapshot, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(snapshot.defaults ?? {}), ...options };
  const flows = snapshot.flows ?? [];
  const paths = [];
  for (const flow of flows) {
    paths.push(...validateFlow(snapshot, flow, limits));
  }
  const failed = paths.filter((p) => p.status === 'error').length;
  return {
    summary: { total: paths.length, ok: paths.length - failed, failed },
    paths,
  };
}

export function validateFlow(snapshot, flow, limits = DEFAULT_LIMITS) {
  const merged = { ...DEFAULT_LIMITS, ...limits };
  const initial = {
    node: flow.ingress,
    context: flow.vrf,
    inInterface: flow.inInterface ?? null,
    stack: [...(flow.labelStack ?? [])],
    ttl: flow.ttl ?? merged.defaultTtl,
    hops: [],
    visited: new Set(),
    frr: false,
  };
  const paths = [];
  walk(snapshot, flow, merged, initial, paths);
  checkFrrConsistency(paths);
  return paths.map((path, index) => ({
    id: `${flow.name ?? 'flow'}#${index + 1}`,
    flow: flow.name ?? 'unnamed',
    ...path,
    status: path.errors.length > 0 ? 'error' : 'ok',
  }));
}

function walk(snapshot, flow, limits, state, paths) {
  const { node, context, stack } = state;
  const nodeDef = snapshot.nodes?.[node];

  if (state.hops.length >= limits.maxHops) {
    paths.push(finish(state, [{ code: ERROR_CODES.MAX_HOPS_EXCEEDED, message: `超过最大跳数 ${limits.maxHops}` }]));
    return;
  }

  const stateKey = `${node}|${context}|${stack.join(',')}`;
  if (state.visited.has(stateKey)) {
    paths.push(finish(state, [{ code: ERROR_CODES.LOOP, message: `检测到转发环：状态 ${stateKey} 重复出现` }]));
    return;
  }
  state.visited.add(stateKey);

  if (!nodeDef) {
    paths.push(finish(state, [{ code: ERROR_CODES.NEXT_HOP_UNREACHABLE, message: `节点 ${node} 不在快照中` }]));
    return;
  }

  const lfib = nodeDef.labelContexts?.[context]?.lfib ?? [];

  // 标签栈已空：报文已是纯 IP（通常由 PHP 弹出最后一层标签产生）。
  if (stack.length === 0) {
    paths.push(handleBareIp(snapshot, flow, limits, state, nodeDef, lfib));
    return;
  }

  const top = stack[stack.length - 1];
  const matches = lfib.filter(
    (entry) =>
      entry.inLabel === top &&
      (entry.inInterface === undefined || entry.inInterface === state.inInterface),
  );

  if (matches.length === 0) {
    paths.push(finish(state, [{
      code: ERROR_CODES.NO_LFIB_ENTRY,
      message: `节点 ${node} 上下文 ${context} 中没有匹配入标签 ${top} 的 LFIB 项`,
    }]));
    return;
  }

  // 多个匹配项视为 ECMP 分支，分别模拟、分别输出。
  for (const entry of matches) {
    applyEntry(snapshot, flow, limits, state, nodeDef, entry, paths, { ecmp: matches.length > 1 });
  }
}

function handleBareIp(snapshot, flow, limits, state, nodeDef, lfib) {
  const errors = [];
  // PHP 与显式空标签混用：本节点期望收到显式空标签，却收到纯 IP 报文。
  const expectsExplicitNull = lfib.some((entry) => EXPLICIT_NULL_LABELS.has(entry.inLabel));
  if (expectsExplicitNull) {
    errors.push({
      code: ERROR_CODES.PHP_EXPLICIT_NULL_MIX,
      message: `节点 ${state.node} 期望显式空标签，但上游执行了 PHP，报文已无标签`,
    });
  }
  // PHP 后被错误再次压栈：IP 报文命中了按接口匹配的压栈项。
  const ipEntry = lfib.find(
    (entry) =>
      entry.inLabel === 'ip' &&
      (entry.inInterface === undefined || entry.inInterface === state.inInterface),
  );
  if (ipEntry && (ipEntry.action === 'push' || ipEntry.action === 'swap')) {
    errors.push({
      code: ERROR_CODES.PHP_RE_PUSH,
      message: `节点 ${state.node} 在 PHP 之后对已是无标签的报文再次执行 ${ipEntry.action}`,
    });
  }
  if (ipEntry && (ipEntry.action === 'pop' || ipEntry.action === 'php')) {
    errors.push({
      code: ERROR_CODES.STACK_EXHAUSTED,
      message: `节点 ${state.node} 对已是无标签的报文执行 ${ipEntry.action}，标签栈耗尽`,
    });
  }
  const hop = {
    node: state.node,
    context: state.context,
    inInterface: state.inInterface,
    stackIn: [],
    action: 'deliver',
    stackAfter: [],
    frr: state.frr,
  };
  return finish({ ...state, hops: [...state.hops, hop] }, errors);
}

function applyEntry(snapshot, flow, limits, state, nodeDef, entry, paths, flags) {
  const baseHop = {
    node: state.node,
    context: state.context,
    inInterface: state.inInterface,
    stackIn: [...state.stack],
    inLabel: state.stack[state.stack.length - 1],
    action: entry.action,
    frr: state.frr,
    ...(flags.ecmp ? { ecmp: true } : {}),
  };

  // 主路径。
  forward(snapshot, flow, limits, state, nodeDef, entry, paths, baseHop);

  // FRR：同时模拟备份路径，检验主备标签栈一致性。
  if (entry.frr) {
    const backup = entry.frr;
    const backupHop = { ...baseHop, frr: true, frrBackup: true };
    const backupState = { ...state, frr: true, visited: new Set(state.visited) };
    forward(snapshot, flow, limits, backupState, nodeDef, backup, paths, backupHop);
  }
}

function forward(snapshot, flow, limits, state, nodeDef, entry, paths, hop) {
  const errors = [];
  const stack = [...state.stack];

  // 标签操作。
  let pushed = [];
  switch (entry.action) {
    case 'swap': {
      if (stack.length === 0) {
        errors.push({ code: ERROR_CODES.STACK_EXHAUSTED, message: '标签栈已空，无法 swap' });
      } else {
        stack[stack.length - 1] = entry.outLabel;
      }
      break;
    }
    case 'push': {
      pushed = [...(entry.pushLabels ?? [])];
      // pushLabels 按从底到顶顺序给出，最后一个元素成为新的栈顶。
      for (const label of pushed) stack.push(label);
      break;
    }
    case 'pop':
    case 'php': {
      if (stack.length === 0) {
        errors.push({ code: ERROR_CODES.STACK_EXHAUSTED, message: `标签栈已空，无法 ${entry.action}` });
      } else {
        stack.pop();
      }
      break;
    }
    default:
      errors.push({ code: ERROR_CODES.NO_LFIB_ENTRY, message: `未知动作 ${entry.action}` });
  }

  if (stack.length > limits.maxStackDepth) {
    errors.push({
      code: ERROR_CODES.INVALID_STACK_DEPTH,
      message: `标签栈深度 ${stack.length} 超过上限 ${limits.maxStackDepth}`,
    });
  }

  // TTL：每转发一跳减一，耗尽即超限。
  const ttl = state.ttl - 1;
  if (ttl <= 0) {
    errors.push({ code: ERROR_CODES.TTL_EXCEEDED, message: `TTL 在节点 ${state.node} 耗尽` });
  }

  // MTU：报文大小 + 标签栈字节数 不能超过出接口 MTU。
  const outInterface = entry.outInterface ?? null;
  const ifaceMtu = outInterface ? nodeDef.interfaces?.[outInterface]?.mtu : undefined;
  const mtu = ifaceMtu ?? limits.defaultMtu;
  const wireSize = (flow.packetSize ?? limits.defaultPacketSize) + 4 * stack.length;
  if (wireSize > mtu) {
    errors.push({
      code: ERROR_CODES.MTU_EXCEEDED,
      message: `报文线速大小 ${wireSize} 超过接口 ${outInterface ?? '?'} MTU ${mtu}`,
    });
  }

  // 递归下一跳解析；无下一跳的 LFIB 项表示在本节点终结（如出口 pop）。
  const hasNextHop = entry.nextHop !== undefined && entry.nextHop !== null;
  const resolved = hasNextHop
    ? resolveNextHop(snapshot, state.node, state.context, entry.nextHop, limits, 0)
    : { node: undefined };
  if (resolved.error) {
    errors.push({ code: resolved.error, message: resolved.message });
  }

  const doneHop = {
    ...hop,
    ...(pushed.length > 0 ? { pushed } : {}),
    ...(entry.action === 'swap' ? { outLabel: entry.outLabel } : {}),
    stackAfter: [...stack],
    nextHop: entry.nextHop ?? null,
    outInterface,
    ttlAfter: ttl,
  };
  const nextState = {
    node: resolved.node,
    context: entry.egressContext ?? state.context,
    inInterface: resolved.inInterface ?? null,
    stack,
    ttl,
    hops: [...state.hops, doneHop],
    visited: new Set(state.visited),
    frr: state.frr,
  };

  if (errors.length > 0 || resolved.error || !hasNextHop) {
    paths.push(finish(nextState, errors));
    return;
  }
  walk(snapshot, flow, limits, nextState, paths);
}

// 递归下一跳：nextHop 可以是节点名，也可以是需要经路由表递归解析的 IP。
function resolveNextHop(snapshot, fromNode, context, nextHop, limits, depth) {
  if (nextHop === undefined || nextHop === null) {
    return { error: ERROR_CODES.NEXT_HOP_UNREACHABLE, message: `节点 ${fromNode} 的 LFIB 项缺少下一跳` };
  }
  if (snapshot.nodes?.[nextHop]) {
    return { node: nextHop };
  }
  if (depth >= limits.maxRecursionDepth) {
    return { error: ERROR_CODES.RECURSION_LIMIT, message: `下一跳 ${nextHop} 递归解析超过 ${limits.maxRecursionDepth} 层` };
  }
  const routes = snapshot.nodes?.[fromNode]?.labelContexts?.[context]?.routes ?? [];
  const route = routes.find((r) => r.destination === nextHop);
  if (!route || route.down) {
    return { error: ERROR_CODES.NEXT_HOP_UNREACHABLE, message: `下一跳 ${nextHop} 不可达：递归解析失败` };
  }
  const resolved = resolveNextHop(snapshot, fromNode, context, route.via, limits, depth + 1);
  if (resolved.error) return resolved;
  return { ...resolved, inInterface: route.inInterface };
}

// 主备一致性：FRR 备份路径到达主路径经过的同一节点时，
// 携带的标签栈必须与主路径到达该节点时一致。
function checkFrrConsistency(paths) {
  const primaryArrivals = new Map();
  for (const path of paths) {
    if (path.frrPath) continue;
    for (const hop of path.hops) {
      const key = hop.node;
      if (!primaryArrivals.has(key)) primaryArrivals.set(key, new Set());
      primaryArrivals.get(key).add(hop.stackIn.join(','));
    }
  }
  for (const path of paths) {
    if (!path.frrPath) continue;
    for (const hop of path.hops) {
      const expected = primaryArrivals.get(hop.node);
      if (!expected) continue;
      const actual = hop.stackIn.join(',');
      if (!expected.has(actual)) {
        path.errors.push({
          code: ERROR_CODES.FRR_LABEL_MISMATCH,
          message: `FRR 备份路径在节点 ${hop.node} 的标签栈 [${actual}] 与主路径不一致`,
          hop: hop.node,
        });
        break;
      }
    }
  }
}

function finish(state, errors) {
  return { hops: state.hops, errors, frrPath: state.frr };
}
