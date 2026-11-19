# mpls-label-stack-validator

多跳 MPLS 标签转发校验器：面向跨机房同时承载 L3VPN 与流量工程隧道的网络，
从入口到出口完整模拟报文的标签栈变化，发现单跳 LFIB 校验无法暴露的问题。

> **重要说明**：本工具只离线分析控制面快照和转发事件（LFIB、路由、接口、
> FRR 配置等的静态导出），**不连接任何路由器**，不下发配置、不采集流量。

## 能力

- 逐跳模拟 push / swap / pop / PHP，支持一次压入多层标签
- 显式空标签（0/2）与隐式空标签（PHP）建模，检测二者混用
- 标签上下文严格隔离：同一标签值在不同 VRF、不同设备上的映射互不干扰，
  切换 VRF / 标签上下文后绝不沿用上一个实例的映射
- 递归下一跳解析（路由表逐层递归），识别递归失效
- ECMP 多分支分别模拟、分别输出每条路径的结果
- FRR 主备路径同时模拟，检测备份路径在汇合点的标签栈不一致
- 检测：标签栈耗尽、非法栈深、转发环、TTL 超限、MTU 超限、
  下一跳不可达、PHP 后被错误再次压栈

## 使用

要求 Node.js >= 22（开发目标版本 24.16.0，使用 `node:test` 与 ESM）。

```bash
node src/cli.js examples/snapshot.json
```

输出 JSON 报告：`summary` 为汇总，`paths` 中每个分支一条结果，
包含逐跳的标签栈变化（`stackIn` / `stackAfter`）、动作、下一跳与错误列表。
存在失败路径时进程退出码为 1。

## 快照格式

见 `examples/snapshot.json`。要点：

- `nodes.<name>.labelContexts.<vrf>.lfib`：LFIB，按 `(节点, 上下文)` 隔离
- LFIB 项：`inLabel`（数字，或 `"ip"` 匹配无标签报文）、`action`
  （`push` / `swap` / `pop` / `php`）、`pushLabels`（从栈底到栈顶）、
  `outLabel`、`nextHop`（节点名或可递归解析的地址）、`outInterface`、
  `egressContext`（转发后切换的标签上下文）、`frr`（备份动作与下一跳）
- `routes`：`{ destination, via, down? }`，用于递归下一跳解析
- `flows`：`ingress`、`vrf`、`inInterface`、`labelStack`、`ttl`、`packetSize`
- `defaults`：`maxStackDepth`、`maxHops`、`maxRecursionDepth`、`defaultMtu` 等上限

## 测试

```bash
node --test
```

覆盖多标签 push、swap、PHP、显式空标签、标签复用、递归下一跳、
ECMP、FRR 切换、转发环与栈深上限等场景。
