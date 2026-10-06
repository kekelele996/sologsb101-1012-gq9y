/**
 * 装备库限界上下文：出库单。
 * 出库单开好 → 序列号锁住（备件在库 ⇄ 锁定的占用由装备库掌管）。
 * 领用撤回的口径（本项目的取舍，见 docs）：
 *   班组先「撤回领用」，台站侧安装登记回退；装备库确认退库后再解锁序列号、备件回在库。
 *   出库单不作废、不物理删除（序列号一经开单必须留有去向），装备库侧没有「作废」写动作，
 *   回退一律走「退库」，单据以「已退库」状态保留留痕。
 * 旧机回收失败只重试台站侧，本单（装备库凭证）永不回退。
 */

/** 出库单状态 */
export type OutboundState = '已开立' | '已领用' | '已退库';

export const OUTBOUND_STATES: OutboundState[] = ['已开立', '已领用', '已退库'];

/** 出库单：装备库开给台站运维班组的备件领用凭证 */
export interface OutboundOrder {
  id: string;
  /** 出库单号（装备库侧业务单号，全库唯一；旧数据升级时按台站码 + 安装日期补齐） */
  orderNo: string;
  /** 出库备件序列号（开单即锁定，与备件 1:1） */
  serialNo: string;
  /** 备件类型/型号（开单时快照，便于留痕） */
  type: string;
  model: string;
  /** 领用台站码（班组申报，如 LTX02） */
  stationCode: string;
  /** 用途 / 故障单号 */
  purpose: string;
  /** 领用人 */
  receiver: string;
  /** 开单日期 */
  outboundDate: string;
  /** 状态 */
  state: OutboundState;
  /** 退库日期（班组撤回领用、装备库确认退库时回填） */
  returnDate: string | null;
  /** 退库原因 */
  returnReason: string;
  /** 关联的台站安装记录 id（领用确认安装后回填，退库时清空） */
  installId: string | null;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 开单草稿 */
export interface OutboundDraft {
  serialNo: string;
  stationCode: string;
  purpose: string;
  receiver: string;
  outboundDate: string;
  remark: string;
}

export function createEmptyOutboundDraft(): OutboundDraft {
  return {
    serialNo: '',
    stationCode: '',
    purpose: '',
    receiver: '',
    outboundDate: new Date().toISOString().slice(0, 10),
    remark: '',
  };
}

/** 旧数据补单号时的前缀与标记 */
export const LEGACY_ORDER_NO_PREFIX = 'CK-BU';
/** 无法按台站码 + 安装日期补出单号的异常标记，进升级异常清单 */
export const LEGACY_FILL_FAILED = '__FILL_FAILED__';

/** 生成出库单号：CK-YYYYMMDD-NNN（同日序号由装备库服务在开单事务内续号） */
export function buildOrderNo(date: string, seq: number): string {
  const compact = date.replace(/-/g, '').slice(0, 8);
  return `CK-${compact}-${String(seq).padStart(3, '0')}`;
}

/** 旧数据补号：CK-BU-台站码-安装日期（日期紧凑写法），补不出返回 null */
export function buildLegacyOrderNo(stationCode: string | null | undefined, installDate: string | null | undefined): string | null {
  const code = stationCode?.trim();
  const date = installDate?.trim();
  if (!code || !date || !/^\d{4}-\d{2}-\d{2}/.test(date)) return null;
  return `${LEGACY_ORDER_NO_PREFIX}-${code}-${date.replace(/-/g, '').slice(0, 8)}`;
}

/** 装备库侧筛选条件 */
export interface OutboundFilterState {
  keyword: string;
  states: OutboundState[];
}

export function createEmptyOutboundFilter(): OutboundFilterState {
  return { keyword: '', states: [] };
}
