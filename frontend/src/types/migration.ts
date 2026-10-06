/**
 * 升级异常登记：v3 迁移时旧数据补不出出库单号（缺台站码或安装日期）的记录。
 * 单列于对账页「补号异常」分区，不进正常出库/安装流程，人工补录后解除。
 */
export type MigrationIssueKind = '旧数据补号失败';

export interface MigrationIssue {
  id: string;
  kind: MigrationIssueKind;
  /** 来源仪器档案 id（v2 instruments 主键，迁移时留痕） */
  sourceInstrumentId: string;
  /** 迁移时的序列号快照（可能为空，空也单列） */
  serialNo: string;
  stationCode: string;
  installDate: string;
  /** 缺失原因说明 */
  reason: string;
  /** 是否已人工补录处理 */
  resolved: boolean;
  createdAt: number;
  updatedAt: number;
}
