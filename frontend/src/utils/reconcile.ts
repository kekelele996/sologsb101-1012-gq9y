/**
 * 序列号对账（装备库 ⇄ 台站运维，两边各记各的，以序列号对账）
 *
 * 两类不一致单列：
 * - outNotInstalled：出了库（有效出库单）但台站没有「已装机」安装记录
 * - installedNotOut：台站「已装机且未拆除」但装备库没有有效出库单
 * 另单列升级回填补不出单号的历史安装记录（legacyMissingOrder）。
 *
 * 纯函数，输入两边表的行，输出对账结果；页面只读 selector/直接调用均可。
 */
import type { OutboundOrder, SparePart } from '@/types/spare';
import { isEffectiveOutbound } from '@/types/spare';
import type { InstallRecord, RemovalRecord } from '@/types/ops';

/** 出了库没装上台站 */
export interface OutNotInstalledRow {
  serialNo: string;
  outboundNo: string;
  stationCode: string;
  type: string;
  model: string;
  outboundState: OutboundOrder['state'];
  outboundDate: string;
  /** 库认为它已退库/作废等，对账时不进异常，这里只列有效态 */
  reason: string;
}

/** 装了又没出库 */
export interface InstalledNotOutRow {
  serialNo: string;
  stationCode: string;
  slotCode: string;
  installDate: string;
  outboundNo: string;
  reason: string;
}

/** 旧数据升级补不出单号 */
export interface LegacyMissingOrderRow {
  installId: string;
  serialNo: string;
  stationCode: string;
  slotCode: string;
  installDate: string;
  reason: string;
}

/** 序列号两侧能对上的正常行 */
export interface MatchedRow {
  serialNo: string;
  outboundNo: string;
  stationCode: string;
  slotCode: string;
  installDate: string;
}

/** 已拆卸但回收未闭环（超期名单不再挂它，但回收要跟踪） */
export interface RemovedPendingRecycleRow {
  removalId: string;
  serialNo: string;
  stationCode: string;
  slotCode: string;
  removeDate: string;
  recycle: RemovalRecord['recycle'];
  retryCount: number;
  lastError: string;
}

/**
 * 升级回填：旧安装数据没有出库单号，按「台站码 + 安装日期」匹配有效出库单。
 * 规则：同站台同日恰好一张有效出库单才回填（唯一匹配）；0 张或 ≥2 张（同日多机、
 * 无法区分）一律保持 outboundRef='none'，交对账页单列人工补。
 * 直接就地改写 install 行并返回回填条数。
 */
export function backfillLegacyOutboundNo(
  installs: InstallRecord[],
  orders: OutboundOrder[]
): { backfilled: number; unresolved: number } {
  const keyOf = (stationCode: string, date: string): string => `${stationCode}@${date}`;
  const groups = new Map<string, OutboundOrder[]>();
  orders
    .filter((order) => isEffectiveOutbound(order.state))
    .forEach((order) => {
      const key = keyOf(order.stationCode, order.outboundDate);
      const list = groups.get(key) ?? [];
      list.push(order);
      groups.set(key, list);
    });

  // 一张出库单只能回填一台安装记录
  const usedOrderIds = new Set<string>();
  let backfilled = 0;
  let unresolved = 0;

  installs
    .filter((row) => row.outboundRef === 'none')
    .forEach((install) => {
      const candidates = (groups.get(keyOf(install.stationCode, install.installDate)) ?? []).filter(
        (order) => !usedOrderIds.has(order.id)
      );
      if (candidates.length === 1) {
        install.outboundNo = candidates[0].outboundNo;
        install.outboundRef = 'backfilled';
        usedOrderIds.add(candidates[0].id);
        backfilled += 1;
      } else {
        unresolved += 1;
      }
    });

  return { backfilled, unresolved };
}

export interface ReconcileResult {
  matched: MatchedRow[];
  outNotInstalled: OutNotInstalledRow[];
  installedNotOut: InstalledNotOutRow[];
  legacyMissingOrder: LegacyMissingOrderRow[];
  removedPendingRecycle: RemovedPendingRecycleRow[];
}

/**
 * 以序列号为键做对账。
 * @param parts     装备库备件库存
 * @param orders    出库单
 * @param installs  台站安装登记
 * @param removals  台站拆卸登记
 */
export function reconcileBySerial(
  parts: SparePart[],
  orders: OutboundOrder[],
  installs: InstallRecord[],
  removals: RemovalRecord[]
): ReconcileResult {
  // 台站当前在安装位上的设备：已装机且未拆除（装机未出库 / 超期名单只看这批）
  const activeInstalls = installs.filter((row) => row.state === '已装机');
  const activeInstallBySerial = new Map(activeInstalls.map((row) => [row.serialNo, row]));

  // 该序列号在台站侧是否「装过」（含已拆除）：装过就不算「出库未装机」，
  // 拆下未回收的在「旧机回收」清单里单独跟踪。
  const everInstalledSerials = new Set(installs.map((row) => row.serialNo));

  // 装备库有效出库（在途/已领用/已装机），同一序列号只取最近一张
  const effectiveOrders = orders.filter((order) => isEffectiveOutbound(order.state));
  const latestOrderBySerial = new Map<string, OutboundOrder>();
  effectiveOrders
    .slice()
    .sort((a, b) => b.outboundDate.localeCompare(a.outboundDate))
    .forEach((order) => {
      if (!latestOrderBySerial.has(order.serialNo)) latestOrderBySerial.set(order.serialNo, order);
    });

  const matched: MatchedRow[] = [];
  const outNotInstalled: OutNotInstalledRow[] = [];

  latestOrderBySerial.forEach((order, serialNo) => {
    const install = activeInstallBySerial.get(serialNo);
    if (install) {
      matched.push({
        serialNo,
        outboundNo: order.outboundNo,
        stationCode: install.stationCode,
        slotCode: install.slotCode,
        installDate: install.installDate,
      });
    } else if (everInstalledSerials.has(serialNo)) {
      // 装过且已拆除：旧机走回收跟踪，不属于「出库未装机」异常
    } else {
      outNotInstalled.push({
        serialNo,
        outboundNo: order.outboundNo,
        stationCode: order.stationCode,
        type: order.type,
        model: order.model,
        outboundState: order.state,
        outboundDate: order.outboundDate,
        reason:
          order.state === '已装机'
            ? '出库单标记已装机但台站查无在装记录'
            : '备件已出库，台站尚未登记安装',
      });
    }
  });

  const installedNotOut: InstalledNotOutRow[] = [];
  activeInstalls.forEach((install) => {
    if (!latestOrderBySerial.has(install.serialNo)) {
      installedNotOut.push({
        serialNo: install.serialNo,
        stationCode: install.stationCode,
        slotCode: install.slotCode,
        installDate: install.installDate,
        outboundNo: install.outboundNo,
        reason: install.outboundNo
          ? `安装单填了 ${install.outboundNo}，但装备库查无有效出库单`
          : '台站已装机，装备库无出库记录',
      });
    }
  });

  // 历史数据：升级时按台站码+安装日期补单号，补不出（outboundRef=none）的单列
  const legacyMissingOrder: LegacyMissingOrderRow[] = installs
    .filter((row) => row.outboundRef === 'none')
    .map((row) => ({
      installId: row.id,
      serialNo: row.serialNo,
      stationCode: row.stationCode,
      slotCode: row.slotCode,
      installDate: row.installDate,
      reason: '旧数据无出库单号，按台站码+安装日期未能唯一匹配',
    }));

  // 已拆卸设备的回收跟踪（成功的不列）
  const removedPendingRecycle: RemovedPendingRecycleRow[] = removals
    .filter((row) => row.recycle !== '回收成功')
    .map((row) => ({
      removalId: row.id,
      serialNo: row.serialNo,
      stationCode: row.stationCode,
      slotCode: row.slotCode,
      removeDate: row.removeDate,
      recycle: row.recycle,
      retryCount: row.retryCount,
      lastError: row.lastError,
    }));

  return {
    matched,
    outNotInstalled,
    installedNotOut,
    legacyMissingOrder,
    removedPendingRecycle,
  };
}
