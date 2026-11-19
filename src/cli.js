#!/usr/bin/env node
// CLI：读取控制面快照 JSON，输出多跳标签转发校验报告。
//
// 用法: node src/cli.js <snapshot.json>
//
// 本工具只离线分析控制面快照与转发事件，不连接任何路由器。

import { readFile } from 'node:fs/promises';
import { validateSnapshot } from './validator.js';

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('用法: node src/cli.js <snapshot.json>');
    process.exit(64);
  }
  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    console.error(`无法读取快照文件 ${file}: ${err.message}`);
    process.exit(66);
  }

  const report = validateSnapshot(snapshot);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.summary.failed > 0 ? 1 : 0);
}

main();
