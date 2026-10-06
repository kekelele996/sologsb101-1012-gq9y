/**
 * 台站运维班组限界上下文：安装位与拆卸登记。
 * 班组只管「哪个台站的哪个安装位、装上/拆下了哪台序列号」，不碰库存与出库单状态。
 * 每条登记是一笔台账流水：领用安装 → 拆卸回收；序列号以装备库出库单为来源，但允许
 * 旧数据无单号（升级补号），补不出单号的进异常清单。
 */

/** 安装登记状态 */
export type InstallState = '已安装' | '已拆卸' | '回收失败';

export const INSTALL_STATES: InstallState[] = ['已安装', '已拆卸', '回收失败'];

/** 回收结果（拆卸时登记） */
export type RecoveryResult = '已回收' | '回收失败';

/** 安装位登记：台站侧一笔安装/拆卸流水 */
export interface InstallRecord {
  id: string;
  /** 安装台站 id */
  stationId: string;
  /** 台站码冗余字段（旧数据可能只剩台站码，升级时反查不到台站 id 也能保留） */
  stationCode: string;
  /** 安装位编号（台站自定义，如「井下位 A」「地表基岩位」） */
  slot: string;
  /** 实际装上的仪器序列号（与出库单/备件序列号对账的唯一键） */
  serialNo: string;
  /** 类型/型号快照 */
  type: string;
  model: string;
  /** 来源出库单 id（正常流程必有；旧数据升级补号后回填，补不出为 null） */
  outboundId: string | null;
  /** 来源出库单号（同上，升级回填；补不出为空串并列异常清单） */
  outboundNo: string;
  /** 安装日期 */
  installDate: string;
  /** 安装人 */
  installer: string;
  /** 状态 */
  state: InstallState;
  /** 拆卸日期 */
  removeDate: string | null;
  /** 拆卸原因 */
  removeReason: string;
  /** 旧机回收结果（拆卸时填写；回收失败只重试台站这侧，出库单不回退） */
  recoveryResult: RecoveryResult | null;
  /** 回收重试次数 */
  retryCount: number;
  /** 回收备注（每次重试追加/覆盖说明） */
  recoveryNote: string;
  /** 撤回领用标记：班组在安装后又撤回领用，等待装备库退库确认 */
  withdrawn: boolean;
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 安装登记草稿 */
export interface InstallDraft {
  stationId: string;
  slot: string;
  serialNo: string;
  outboundNo: string;
  installDate: string;
  installer: string;
  remark: string;
}

export function createEmptyInstallDraft(stationId = ''): InstallDraft {
  return {
    stationId,
    slot: '',
    serialNo: '',
    outboundNo: '',
    installDate: new Date().toISOString().slice(0, 10),
    installer: '',
    remark: '',
  };
}

/** 台站侧筛选条件 */
export interface InstallFilterState {
  keyword: string;
  states: InstallState[];
  /** 仅看撤回领用待退库 */
  onlyWithdrawn: boolean;
}

export function createEmptyInstallFilter(): InstallFilterState {
  return { keyword: '', states: [], onlyWithdrawn: false };
}
