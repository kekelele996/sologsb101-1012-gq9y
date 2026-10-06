/**
 * 序列号对账：装备库出库单 × 台站安装登记，按序列号逐台核对。
 * 纯函数，输入两侧表数据，输出三类单列结果：
 *  1. 出了库没装上台站：出库单已领用，但台站侧没有「已安装」登记；
 *     班组已撤回、等装备库确认退库的在途单据不算差异（流程中间态，由台站页单独提示）。
 *  2. 装了又没出库：台站侧「已安装」，但装备库没有已领用（未退库）的出库单
 *  3. 补号异常：旧数据升级补不出出库单号，单列人工处理
 * 另给出序列号对得上的正常配对，便于页面一屏看全。
 */
import type { OutboundOrder } from '@/types/outbound';
import type { InstallRecord } from '@/types/install';
import type { MigrationIssue } from '@/types/migration';

/** 出了库没装上台站 */
export interface ShippedNotInstalledRow {
  order: OutboundOrder;
}

/** 装了又没出库 */
export interface InstalledNotShippedRow {
  install: InstallRecord;
  /** 台站侧有安装、但只找到同序列号的在途单据（已开立锁定未领用）时带出 */
  openOrder: OutboundOrder | null;
}

/** 序列号对得上的配对行 */
export interface MatchedRow {
  order: OutboundOrder;
  install: InstallRecord;
}

export interface ReconcileReport {
  shippedNotInstalled: ShippedNotInstalledRow[];
  installedNotShipped: InstalledNotShippedRow[];
  legacyFillIssues: MigrationIssue[];
  matched: MatchedRow[];
  /** 对账结论汇总 */
  discrepancyCount: number;
  matchedCount: number;
}

/**
 * @param orders  装备库出库单（全量）
 * @param installs 台站安装/拆卸登记（全量）
 * @param issues  升级补号异常（全量，仅取未处理）
 */
export function reconcileSerialFlow(
  orders: OutboundOrder[],
  installs: InstallRecord[],
  issues: MigrationIssue[] = []
): ReconcileReport {
  // 台站侧当前仍装在安装位上的序列号
  const activeInstalls = installs.filter((row) => row.state === '已安装' && !row.withdrawn);
  const activeInstallBySerial = new Map<string, InstallRecord>();
  activeInstalls.forEach((row) => {
    const key = row.serialNo.trim();
    if (key && !activeInstallBySerial.has(key)) activeInstallBySerial.set(key, row);
  });

  // 班组已撤回领用、等装备库确认退库的安装登记（按单据 id 索引）
  const withdrawnInstallByOrderId = new Map<string, InstallRecord>();
  installs.forEach((row) => {
    if (row.withdrawn && row.outboundId) withdrawnInstallByOrderId.set(row.outboundId, row);
  });

  // 已领用且未退库的单据 = 序列号物理上已出装备库
  const effectiveOrders = orders.filter((order) => order.state === '已领用');
  const effectiveOrderBySerial = new Map<string, OutboundOrder>();
  effectiveOrders.forEach((order) => {
    const key = order.serialNo.trim();
    if (key && !effectiveOrderBySerial.has(key)) effectiveOrderBySerial.set(key, order);
  });

  // 已开立（锁定待领用）的单据，用于说明「装了没出库」其实卡在领用确认
  const openOrderBySerial = new Map<string, OutboundOrder>();
  orders
    .filter((order) => order.state === '已开立')
    .forEach((order) => {
      const key = order.serialNo.trim();
      if (key && !openOrderBySerial.has(key)) openOrderBySerial.set(key, order);
    });

  const shippedNotInstalled: ShippedNotInstalledRow[] = [];
  const matched: MatchedRow[] = [];
  effectiveOrders.forEach((order) => {
    // 撤回待退库是双方都知情的流程中间态，不列差异
    if (withdrawnInstallByOrderId.has(order.id)) return;
    const install = activeInstallBySerial.get(order.serialNo.trim());
    if (install) {
      matched.push({ order, install });
    } else {
      shippedNotInstalled.push({ order });
    }
  });

  const installedNotShipped: InstalledNotShippedRow[] = [];
  activeInstalls.forEach((install) => {
    const key = install.serialNo.trim();
    if (!key) return;
    if (!effectiveOrderBySerial.has(key)) {
      installedNotShipped.push({ install, openOrder: openOrderBySerial.get(key) ?? null });
    }
  });

  const legacyFillIssues = issues.filter((issue) => !issue.resolved);

  const discrepancyCount =
    shippedNotInstalled.length + installedNotShipped.length + legacyFillIssues.length;

  return {
    shippedNotInstalled: shippedNotInstalled.sort((a, b) =>
      a.order.outboundDate.localeCompare(b.order.outboundDate)
    ),
    installedNotShipped: installedNotShipped.sort((a, b) =>
      a.install.installDate.localeCompare(b.install.installDate)
    ),
    legacyFillIssues,
    matched,
    discrepancyCount,
    matchedCount: matched.length,
  };
}
