/**
 * 台站运维领域模型（账本二：台站运维班组）
 * - InstallRecord：安装位 + 安装登记（哪个序列号装在哪个台站、什么时间）
 * - RemovalRecord：拆卸登记（旧机拆下、回收结果可重试）
 * 班组只对自己的事实负责：安装位、装机与拆卸、旧机回收，不写库存。
 */

/**
 * 安装登记状态：
 * - 已装机：新设备已在安装位投运
 * - 已拆除：该安装位上的这台设备已登记拆卸（终态，关联 removalId）
 * 超期名单只统计「已装机且未拆除」的序列号，拆下的那台不再挂超期。
 */
export type InstallState = '已装机' | '已拆除';

export const INSTALL_STATES: InstallState[] = ['已装机', '已拆除'];

/** 安装位类型（仪器在台站上的安装位置） */
export type InstallSlotType = '宽频带' | '短周期' | '强震' | '采集器' | '电源' | '其他';

export const INSTALL_SLOT_TYPES: InstallSlotType[] = [
  '宽频带',
  '短周期',
  '强震',
  '采集器',
  '电源',
  '其他',
];

/**
 * 安装登记：一台设备一次安装一条记录（安装位 + 装机事实）。
 * 关联出库单号可空：历史数据（v3 升级前）没有单号，按台站码 + 安装日期补，
 * 补不出的保持空并在对账页单列。
 */
export interface InstallRecord {
  id: string;
  /** 安装位所在台站码 */
  stationCode: string;
  /** 安装位编号（台站内唯一，如 BB-主井 / ST-地表） */
  slotCode: string;
  /** 安装位类型 */
  slotType: InstallSlotType;
  /** 实际装上去的序列号（以实物扫码为准，两边对账主键） */
  serialNo: string;
  /** 型号 */
  model: string;
  /** 安装日期（YYYY-MM-DD，历史单号回填的匹配键之一） */
  installDate: string;
  /** 关联出库单号；历史数据补不出时为空串 */
  outboundNo: string;
  /** 单号来源：new 新流程登记 / backfilled 升级回填 / none 补不出单列 */
  outboundRef: 'new' | 'backfilled' | 'none';
  state: InstallState;
  /** 拆除后关联的拆卸登记 id */
  removalId: string;
  /** 安装班组 / 操作人 */
  operator: string;
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 旧机回收结果：
 * - 待回收：拆下来还没交回装备库
 * - 回收成功：旧机已交库（只更新台站侧状态）
 * - 回收失败：交库失败（物流/损坏争议等），仅台站侧可重试，不影响库的出库单
 */
export type RecycleState = '待回收' | '回收成功' | '回收失败';

export const RECYCLE_STATES: RecycleState[] = ['待回收', '回收成功', '回收失败'];

/** 拆卸登记：一次拆旧机一条 */
export interface RemovalRecord {
  id: string;
  /** 被拆下设备的安装登记 id */
  installId: string;
  /** 台站码（冗余，便于列表筛选） */
  stationCode: string;
  /** 安装位编号 */
  slotCode: string;
  /** 拆下的旧机序列号 */
  serialNo: string;
  /** 拆卸日期 */
  removeDate: string;
  /** 拆卸原因（故障 / 超期 / 轮换 / 升级） */
  reason: string;
  /** 旧机回收结果 */
  recycle: RecycleState;
  /** 最近一次回收尝试时间（失败重试时刷新） */
  retryAt: number | null;
  /** 已重试次数 */
  retryCount: number;
  /** 最近一次失败原因 */
  lastError: string;
  operator: string;
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 旧机回收是否只允许台站侧重试（库的出库单永不回退） */
export function canRetryRecycle(record: RemovalRecord): boolean {
  return record.recycle === '回收失败' || record.recycle === '待回收';
}
