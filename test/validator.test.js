import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSnapshot, validateFlow } from '../src/validator.js';
import { ERROR_CODES } from '../src/labels.js';

function node(lfib, extra = {}) {
  return { interfaces: {}, labelContexts: { CTX: { lfib, routes: [], ...(extra.ctx ?? {}) } }, ...extra };
}

function flow(overrides = {}) {
  return {
    name: 'f',
    ingress: 'A',
    vrf: 'CTX',
    labelStack: [100],
    ttl: 64,
    packetSize: 100,
    ...overrides,
  };
}

test('多标签 push：栈底到栈顶依次压入，栈顶为最后一个元素', () => {
  const snapshot = {
    nodes: {
      A: node([{ inLabel: 100, action: 'push', pushLabels: [200, 300], nextHop: 'B' }]),
      B: node([{ inLabel: 300, action: 'pop' }]),
    },
  };
  const [path] = validateFlow(snapshot, flow());
  assert.equal(path.status, 'ok');
  assert.deepEqual(path.hops[0].stackAfter, [100, 200, 300]);
  assert.deepEqual(path.hops[1].stackAfter, [100, 200]);
});

test('swap 链：跨三台设备逐跳交换标签', () => {
  const snapshot = {
    nodes: {
      A: node([{ inLabel: 100, action: 'swap', outLabel: 200, nextHop: 'B' }]),
      B: node([{ inLabel: 200, action: 'swap', outLabel: 300, nextHop: 'C' }]),
      C: node([{ inLabel: 300, action: 'pop' }]),
    },
  };
  const [path] = validateFlow(snapshot, flow());
  assert.equal(path.status, 'ok');
  assert.deepEqual(path.hops.map((h) => h.node), ['A', 'B', 'C']);
  assert.deepEqual(path.hops.map((h) => h.stackAfter), [[200], [300], []]);
});

test('PHP：倒数第二跳弹出标签，出口收到纯 IP 报文并正常交付', () => {
  const snapshot = {
    nodes: {
      A: node([{ inLabel: 100, action: 'swap', outLabel: 200, nextHop: 'B' }]),
      B: node([{ inLabel: 200, action: 'php', nextHop: 'C' }]),
      C: node([]),
    },
  };
  const [path] = validateFlow(snapshot, flow());
  assert.equal(path.status, 'ok');
  assert.equal(path.hops.at(-1).action, 'deliver');
});

test('显式空标签：倒数第二跳压入 0，出口按显式空标签弹出', () => {
  const snapshot = {
    nodes: {
      A: node([{ inLabel: 100, action: 'swap', outLabel: 0, nextHop: 'B' }]),
      B: node([{ inLabel: 0, action: 'pop' }]),
    },
  };
  const [path] = validateFlow(snapshot, flow());
  assert.equal(path.status, 'ok');
  assert.deepEqual(path.hops[0].stackAfter, [0]);
});

test('PHP 与显式空标签混用：上游 PHP 而出口期望显式空标签', () => {
  const snapshot = {
    nodes: {
      A: node([{ inLabel: 100, action: 'php', nextHop: 'B' }]),
      B: node([{ inLabel: 0, action: 'pop' }]),
    },
  };
  const [path] = validateFlow(snapshot, flow());
  assert.equal(path.status, 'error');
  assert.equal(path.errors[0].code, ERROR_CODES.PHP_EXPLICIT_NULL_MIX);
});

test('标签复用：同一标签值在不同 VRF 中映射互不干扰', () => {
  const snapshot = {
    nodes: {
      A: {
        interfaces: {},
        labelContexts: {
          'VRF-A': { lfib: [{ inLabel: 100, action: 'swap', outLabel: 200, nextHop: 'B' }] },
          'VRF-B': { lfib: [{ inLabel: 100, action: 'pop' }] },
        },
      },
      B: {
        interfaces: {},
        labelContexts: {
          'VRF-A': { lfib: [{ inLabel: 200, action: 'pop' }] },
          'VRF-B': { lfib: [] },
        },
      },
    },
  };
  const [pathA] = validateFlow(snapshot, flow({ vrf: 'VRF-A' }));
  assert.equal(pathA.status, 'ok');
  assert.deepEqual(pathA.hops[0].stackAfter, [200]);

  const [pathB] = validateFlow(snapshot, flow({ vrf: 'VRF-B' }));
  assert.equal(pathB.status, 'ok');
  assert.deepEqual(pathB.hops[0].stackAfter, []);
});

test('上下文切换：切换 VRF 后使用新上下文的标签映射，不沿用旧映射', () => {
  const snapshot = {
    nodes: {
      A: {
        interfaces: {},
        labelContexts: {
          'VRF-A': {
            lfib: [{ inLabel: 100, action: 'swap', outLabel: 100, nextHop: 'B', egressContext: 'VRF-B' }],
          },
          'VRF-B': { lfib: [] },
        },
      },
      B: {
        interfaces: {},
        labelContexts: {
          'VRF-A': { lfib: [{ inLabel: 100, action: 'swap', outLabel: 900, nextHop: 'C' }] },
          'VRF-B': { lfib: [{ inLabel: 100, action: 'pop' }] },
        },
      },
      C: node([]),
    },
  };
  const [path] = validateFlow(snapshot, flow({ vrf: 'VRF-A' }));
  assert.equal(path.status, 'ok');
  assert.equal(path.hops[1].context, 'VRF-B');
  assert.equal(path.hops[1].action, 'pop');
});

test('递归下一跳：经路由表逐层解析到节点', () => {
  const snapshot = {
    nodes: {
      A: node(
        [{ inLabel: 100, action: 'swap', outLabel: 200, nextHop: '192.0.2.1' }],
        {
          ctx: {
            routes: [
              { destination: '192.0.2.1', via: '198.51.100.1' },
              { destination: '198.51.100.1', via: 'B' },
            ],
          },
        },
      ),
      B: node([{ inLabel: 200, action: 'pop' }]),
    },
  };
  const [path] = validateFlow(snapshot, flow());
  assert.equal(path.status, 'ok');
  assert.equal(path.hops[1].node, 'B');
});

test('递归下一跳失效：路由缺失时报下一跳不可达', () => {
  const snapshot = {
    nodes: {
      A: node([{ inLabel: 100, action: 'swap', outLabel: 200, nextHop: '192.0.2.1' }]),
      B: node([]),
    },
  };
  const [path] = validateFlow(snapshot, flow());
  assert.equal(path.status, 'error');
  assert.equal(path.errors[0].code, ERROR_CODES.NEXT_HOP_UNREACHABLE);
});

test('ECMP：两个匹配项产生两条路径，分别输出结果', () => {
  const snapshot = {
    nodes: {
      A: node([
        { inLabel: 100, action: 'swap', outLabel: 200, nextHop: 'B' },
        { inLabel: 100, action: 'swap', outLabel: 201, nextHop: 'C' },
      ]),
      B: node([{ inLabel: 200, action: 'pop' }]),
      C: node([{ inLabel: 201, action: 'pop' }]),
    },
  };
  const paths = validateFlow(snapshot, flow());
  assert.equal(paths.length, 2);
  assert.ok(paths.every((p) => p.status === 'ok'));
  assert.deepEqual(paths.map((p) => p.hops[0].nextHop).sort(), ['B', 'C']);
  assert.ok(paths.every((p) => p.hops[0].ecmp));
});

test('FRR：主备路径标签栈一致时备份路径校验通过', () => {
  const snapshot = {
    nodes: {
      A: node([{
        inLabel: 100,
        action: 'swap',
        outLabel: 200,
        nextHop: 'B',
        frr: { action: 'swap', outLabel: 200, nextHop: 'D' },
      }]),
      B: node([{ inLabel: 200, action: 'pop' }]),
      D: node([{ inLabel: 200, action: 'pop' }]),
    },
  };
  const paths = validateFlow(snapshot, flow());
  assert.equal(paths.length, 2);
  const backup = paths.find((p) => p.frrPath);
  assert.ok(backup);
  assert.equal(backup.status, 'ok');
});

test('FRR：备份路径在汇合点标签栈与主路径不一致时被检出', () => {
  const snapshot = {
    nodes: {
      A: node([{
        inLabel: 100,
        action: 'swap',
        outLabel: 200,
        nextHop: 'B',
        frr: { action: 'swap', outLabel: 250, nextHop: 'D' },
      }]),
      B: node([{ inLabel: 200, action: 'swap', outLabel: 300, nextHop: 'C' }]),
      D: node([{ inLabel: 250, action: 'swap', outLabel: 301, nextHop: 'C' }]),
      C: node([
        { inLabel: 300, action: 'pop' },
        { inLabel: 301, action: 'pop' },
      ]),
    },
  };
  const paths = validateFlow(snapshot, flow());
  const backup = paths.find((p) => p.frrPath);
  assert.equal(backup.status, 'error');
  assert.ok(backup.errors.some((e) => e.code === ERROR_CODES.FRR_LABEL_MISMATCH));
});

test('转发环：相同 (节点, 上下文, 标签栈) 状态重复出现即判环', () => {
  const snapshot = {
    nodes: {
      A: node([{ inLabel: 100, action: 'swap', outLabel: 100, nextHop: 'B' }]),
      B: node([{ inLabel: 100, action: 'swap', outLabel: 100, nextHop: 'A' }]),
    },
  };
  const [path] = validateFlow(snapshot, flow());
  assert.equal(path.status, 'error');
  assert.equal(path.errors.at(-1).code, ERROR_CODES.LOOP);
});

test('栈深上限：push 后超过 maxStackDepth 报非法栈深', () => {
  const snapshot = {
    nodes: {
      A: node([{ inLabel: 100, action: 'push', pushLabels: [200, 300, 400], nextHop: 'B' }]),
      B: node([]),
    },
  };
  const [path] = validateFlow(snapshot, flow(), { maxStackDepth: 3 });
  assert.equal(path.status, 'error');
  assert.ok(path.errors.some((e) => e.code === ERROR_CODES.INVALID_STACK_DEPTH));
});

test('标签栈耗尽：空栈报文命中按接口匹配的转发项', () => {
  const snapshot = {
    nodes: {
      A: node([{ inLabel: 100, action: 'php', nextHop: 'B' }]),
      B: node([{ inLabel: 'ip', action: 'push', pushLabels: [500], nextHop: 'C' }]),
      C: node([]),
    },
  };
  const [path] = validateFlow(snapshot, flow());
  assert.equal(path.status, 'error');
  assert.ok(path.errors.some((e) => e.code === ERROR_CODES.PHP_RE_PUSH));
});

test('标签栈耗尽：对无标签报文执行 pop', () => {
  const snapshot = {
    nodes: {
      A: node([{ inLabel: 100, action: 'php', nextHop: 'B' }]),
      B: node([{ inLabel: 'ip', action: 'pop', nextHop: 'C' }]),
      C: node([]),
    },
  };
  const [path] = validateFlow(snapshot, flow());
  assert.equal(path.status, 'error');
  assert.ok(path.errors.some((e) => e.code === ERROR_CODES.STACK_EXHAUSTED));
});

test('TTL 超限：TTL 在到达出口前耗尽', () => {
  const snapshot = {
    nodes: {
      A: node([{ inLabel: 100, action: 'swap', outLabel: 200, nextHop: 'B' }]),
      B: node([{ inLabel: 200, action: 'swap', outLabel: 300, nextHop: 'C' }]),
      C: node([{ inLabel: 300, action: 'pop' }]),
    },
  };
  const [path] = validateFlow(snapshot, flow({ ttl: 1 }));
  assert.equal(path.status, 'error');
  assert.ok(path.errors.some((e) => e.code === ERROR_CODES.TTL_EXCEEDED));
});

test('MTU 超限：报文加标签栈超过出接口 MTU', () => {
  const snapshot = {
    nodes: {
      A: {
        interfaces: { eth0: { mtu: 120 } },
        labelContexts: {
          CTX: { lfib: [{ inLabel: 100, action: 'push', pushLabels: [200, 300], nextHop: 'B', outInterface: 'eth0' }] },
        },
      },
      B: node([]),
    },
  };
  const [path] = validateFlow(snapshot, flow({ packetSize: 120 }));
  assert.equal(path.status, 'error');
  assert.ok(path.errors.some((e) => e.code === ERROR_CODES.MTU_EXCEEDED));
});

test('下一跳不可达：下一跳既不是节点也无法递归解析', () => {
  const snapshot = {
    nodes: {
      A: node([{ inLabel: 100, action: 'swap', outLabel: 200, nextHop: 'NOWHERE' }]),
    },
  };
  const [path] = validateFlow(snapshot, flow());
  assert.equal(path.status, 'error');
  assert.equal(path.errors[0].code, ERROR_CODES.NEXT_HOP_UNREACHABLE);
});

test('validateSnapshot：汇总多条流与多分支路径', () => {
  const snapshot = {
    nodes: {
      A: node([
        { inLabel: 100, action: 'swap', outLabel: 200, nextHop: 'B' },
        { inLabel: 100, action: 'swap', outLabel: 201, nextHop: 'C' },
      ]),
      B: node([{ inLabel: 200, action: 'pop' }]),
      C: node([]),
    },
    flows: [flow({ name: 'ecmp-flow' })],
  };
  const report = validateSnapshot(snapshot);
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.ok, 1);
  assert.equal(report.summary.failed, 1);
});
