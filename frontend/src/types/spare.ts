/**
 * 装备库领域模型（账本一：装备库）
 * - SparePart：备件库存（序列号即实物身份，一台备件一条库存记录）
 * - OutboundOrder：出库单（开好即锁序列号；撤回退库与作废是不同终态）
 * 装备库只对自己的事实负责：库存数量与出库/退库单据。
 */

/** 备件类型（与仪器类型对齐，便于安装时核对） */
export type SparePartType = '宽频带' | '短周期' | '强震' | '采集器' | '电源' | '其他';

export const SPARE_PART_TYPES: SparePartType[] = [
  '宽频带',
  '短周期',
  '强震',
  '采集器',
  '电源',
  '其他',
];

/**
 * 备件库存状态：
 * - 在库：实物在库、序列号可用，可开出库单
 * - 已锁定：出库单已开、尚未确认领用，序列号被占用
 * - 已出库：班组已领用（在途或待装），库存为 0
 * - 已装机：台站已回传安装登记，实物在台站上
 * - 已退库：领用撤回后退回入库（序列号重新可开单）
 */
export type SparePartState = '在库' | '已锁定' | '已出库' | '已装机' | '已退库';

export const SPARE_PART_STATES: SparePartState[] = [
  '在库',
  '已锁定',
  '已出库',
  '已装机',
  '已退库',
];

/** 备件库存记录：一台件一条 */
export interface SparePart {
  id: string;
  /** 备件类型 */
  type: SparePartType;
  /** 型号 */
  model: string;
  /** 序列号（全库唯一，两边对账的主键） */
  serialNo: string;
  /** 库存状态 */
  state: SparePartState;
  /** 当前占用它的出库单号（在库/已退库时为空） */
  outboundNo: string;
  /** 入库日期 */
  inboundDate: string;
  /** 库位 */
  location: string;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 出库单状态机：
 *   待领用 ──领用确认→ 已领用 ──安装回传→ 已装机（闭环）
 *     │                  │
 *     └─库管作废         └─班组撤回领用→ 已撤回（退库：库存+1、解锁）
 *
 * - 待领用：开单即锁序列号（备件 已锁定）；此态库管可作废
 * - 已领用：班组已确认领用（备件 已出库）；只能由班组发起撤回退库，库管不能作废
 * - 已装机：台站侧已登记安装；单据不允许回退
 * - 已作废：仅「待领用」可进入；解锁、不写退库流水
 * - 已撤回：从「已领用」退库；原单保留、库存 +1、序列号解锁
 */
export type OutboundState = '待领用' | '已领用' | '已装机' | '已作废' | '已撤回';

export const OUTBOUND_STATES: OutboundState[] = [
  '待领用',
  '已领用',
  '已装机',
  '已作废',
  '已撤回',
];

/** 出库单（一台备件一张单，序列号开单即锁定） */
export interface OutboundOrder {
  id: string;
  /** 出库单号（人读，如 CK-20260901-007），全局唯一 */
  outboundNo: string;
  /** 出库备件序列号（与 SparePart.serialNo 一致，对账主键） */
  serialNo: string;
  /** 备件类型/型号快照（开单时固化） */
  type: SparePartType;
  model: string;
  /** 领用台站码（开单时指定） */
  stationCode: string;
  /** 用途说明（更换 / 新建 / 备机） */
  purpose: string;
  /** 库管开单人 */
  keeper: string;
  /** 班组领用人（待领用时为空） */
  receiver: string;
  /** 出库日期（开单日期） */
  outboundDate: string;
  state: OutboundState;
  /** 退库/作废时间（终态时回写） */
  closedAt: number | null;
  /** 撤回退库操作人（班组侧） */
  returnOperator: string;
  /** 作废/退库原因 */
  closeReason: string;
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 库管能否直接作废：只有开单后尚未领用的单子可作废 */
export function canVoidOrder(state: OutboundState): boolean {
  return state === '待领用';
}

/** 班组能否撤回领用：只有已确认领用、尚未装机的单子可撤回退库 */
export function canWithdrawReceive(state: OutboundState): boolean {
  return state === '已领用';
}

/** 出库单是否处于占用序列号的有效出库态（对账时计入「已出库」） */
export function isEffectiveOutbound(state: OutboundState): boolean {
  return state === '待领用' || state === '已领用' || state === '已装机';
}

/** 生成出库单号：CK-YYYYMMDD-三位序号 */
export function formatOutboundNo(date: string, seq: number): string {
  const compact = date.replace(/-/g, '').slice(0, 8);
  return `CK-${compact}-${String(seq).padStart(3, '0')}`;
}
