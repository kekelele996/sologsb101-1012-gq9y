/**
 * 装备库限界上下文：备件库存。
 * 装备库只认序列号与库存状态，不关心台站安装位。
 * 状态流转：在库 ⇄ 锁定（出库单开立时锁定）→ 已出库；撤回领用经退库回到在库。
 */
import type { InstrumentType } from '@/types/instrument';

/** 备件库存状态 */
export type SpareState = '在库' | '锁定' | '已出库';

export const SPARE_STATES: SpareState[] = ['在库', '锁定', '已出库'];

/** 备件：装备库内按序列号管理的库存设备 */
export interface SparePart {
  id: string;
  /** 仪器类型（宽频带 / 短周期 / 强震） */
  type: InstrumentType;
  /** 型号 */
  model: string;
  /** 序列号（装备库内唯一，开立出库单后即锁定，不可再被别的单据选用） */
  serialNo: string;
  /** 库存状态 */
  state: SpareState;
  /** 入库日期 */
  inboundDate: string;
  /** 当前占用该备件的出库单 id（锁定 / 已出库时有值，退库后清空） */
  outboundId: string | null;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 备件登记草稿 */
export interface SpareDraft {
  type: InstrumentType;
  model: string;
  serialNo: string;
  inboundDate: string;
  remark: string;
}

export function createEmptySpareDraft(): SpareDraft {
  return {
    type: '宽频带',
    model: '',
    serialNo: '',
    inboundDate: new Date().toISOString().slice(0, 10),
    remark: '',
  };
}

/** 出库单号生成时使用的前缀 */
export const OUTBOUND_NO_PREFIX = 'CK';
