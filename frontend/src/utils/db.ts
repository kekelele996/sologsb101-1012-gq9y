/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbseisarray，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（台阵 → 台站 → 仪器 → 标定 / 更换）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie';
import type { SeisArray } from '@/types/array';
import type { SeisStation } from '@/types/station';
import type { Instrument } from '@/types/instrument';
import { judgeCalibration } from '@/types/calibration';
import type { Calibration } from '@/types/calibration';
import type { Replace } from '@/types/replace';
import type { SparePart } from '@/types/spare';
import type { OutboundOrder } from '@/types/outbound';
import type { InstallRecord } from '@/types/install';
import type { MigrationIssue } from '@/types/migration';
import { buildLegacyOrderNo, buildOrderNo } from '@/types/outbound';

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3;

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbseisarray';

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbseisarray:db-version',
  lastBackupAt: 'gbseisarray:last-backup-at',
  lastArrayId: 'gbseisarray:last-array-id',
} as const;

/** 备份文件结构，供 utils/export.ts 与几何页使用 */
export interface BackupPayload {
  app: 'gbseisarray';
  dbVersion: number;
  exportedAt: string;
  arrays: SeisArray[];
  stations: SeisStation[];
  instruments: Instrument[];
  calibrations: Calibration[];
  replaces: Replace[];
  spares: SparePart[];
  outboundOrders: OutboundOrder[];
  installs: InstallRecord[];
  migrationIssues: MigrationIssue[];
}

export class SeisArrayDatabase extends Dexie {
  arrays!: Table<SeisArray, string>;
  stations!: Table<SeisStation, string>;
  instruments!: Table<Instrument, string>;
  calibrations!: Table<Calibration, string>;
  replaces!: Table<Replace, string>;
  /** 装备库：备件库存 */
  spares!: Table<SparePart, string>;
  /** 装备库：出库单 */
  outboundOrders!: Table<OutboundOrder, string>;
  /** 台站班组：安装位 / 拆卸登记 */
  installs!: Table<InstallRecord, string>;
  /** 升级补号异常清单 */
  migrationIssues!: Table<MigrationIssue, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      arrays: 'id, name, state',
      stations: 'id, arrayId, code',
      instruments: 'id, stationId, serialNo, state',
      calibrations: 'id, instrumentId, date',
      replaces: 'id, instrumentId, state',
    });

    // v2：补齐筛选与统计需要的索引（孔径/布设日期、经纬度/基岩、类型/序列号、灵敏度/结论、原因）
    this.version(2)
      .stores({
        arrays: 'id, name, state, apertureKm, deployDate, department, updatedAt',
        stations: 'id, arrayId, code, lat, lng, elevM, bedrock, updatedAt',
        instruments: 'id, stationId, type, model, serialNo, installDate, state, updatedAt',
        calibrations: 'id, instrumentId, date, sensitivity, selfNoise, responseVerdict, updatedAt',
        replaces: 'id, instrumentId, state, date, newSerialNo, updatedAt',
      })
      .upgrade(async (tx) => {
        // 迁移：历史数据补齐时间戳与必填字段，避免列表排序与筛选拿到 undefined
        const defaults: Array<[string, () => Record<string, unknown>]> = [
          ['arrays', () => ({ apertureKm: 0, stationCount: 0, department: '' })],
          ['stations', () => ({ lat: 0, lng: 0, elevM: 0, bedrock: '花岗岩', siteNote: '' })],
          ['instruments', () => ({ type: '宽频带', model: '', state: '在用', remark: '' })],
          ['calibrations', () => ({ sensitivity: 0, selfNoise: 0, responseVerdict: '待判定', agency: '' })],
          ['replaces', () => ({ state: '待更换', newSerialNo: '', operator: '' })],
        ];
        for (const [tableName, factory] of defaults) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              const now = Date.now();
              if (typeof row.createdAt !== 'number') row.createdAt = now;
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt;
              Object.assign(row, factory());
            });
        }
      });

    // v3：装备库 / 台站班组分账 —— 备件库存、出库单、安装位登记、补号异常四张表。
    // 旧 instruments 流水拆成「装备库出库单 + 台站安装登记」，缺单号的按台站码 + 安装日期补，补不出单列。
    this.version(DB_VERSION)
      .stores({
        spares: 'id, serialNo, state, outboundId, type, inboundDate, updatedAt',
        outboundOrders: 'id, orderNo, serialNo, stationCode, state, outboundDate, installId, updatedAt',
        installs: 'id, stationId, stationCode, serialNo, outboundId, state, installDate, removedDate:removeDate, withdrawn, updatedAt',
        migrationIssues: 'id, kind, sourceInstrumentId, resolved, updatedAt',
      })
      .upgrade(async (tx) => {
        const now = Date.now();
        const stations = await tx.table<SeisStation, string>('stations').toArray();
        const stationById = new Map(stations.map((station) => [station.id, station]));
        const legacyInstruments = await tx
          .table<Instrument, string>('instruments')
          .toArray();

        const spareRows: SparePart[] = [];
        const orderRows: OutboundOrder[] = [];
        const installRows: InstallRecord[] = [];
        const issueRows: MigrationIssue[] = [];

        legacyInstruments.forEach((ins, index) => {
          const station = stationById.get(ins.stationId);
          const stationCode = station?.code ?? '';
          const legacyNo = buildLegacyOrderNo(stationCode, ins.installDate);
          const stamp = now + index;
          const baseSnapshot = {
            serialNo: ins.serialNo ?? '',
            type: ins.type ?? '宽频带',
            model: ins.model ?? '',
          };

          // 台站侧：安装位登记（全部旧仪器都视为曾装上台站；已停用即已拆卸）
          installRows.push({
            id: `ist_legacy_${ins.id}`,
            stationId: ins.stationId,
            stationCode,
            slot: '默认安装位',
            ...baseSnapshot,
            outboundId: legacyNo ? `ob_legacy_${ins.id}` : null,
            outboundNo: legacyNo ?? '',
            installDate: ins.installDate ?? '',
            installer: '',
            state: ins.state === '已停用' ? '已拆卸' : '已安装',
            removeDate: null,
            removeReason: ins.state === '已停用' ? (ins.remark ?? '历史停用') : '',
            recoveryResult: null,
            retryCount: 0,
            recoveryNote: '',
            withdrawn: false,
            remark: ins.remark ?? '',
            createdAt: typeof ins.createdAt === 'number' ? ins.createdAt : stamp,
            updatedAt: typeof ins.updatedAt === 'number' ? ins.updatedAt : stamp,
          });

          // 装备库侧：能补出单号才视为历史出库凭证；补不出的不造假单，只留库存快照 + 异常清单
          if (legacyNo) {
            spareRows.push({
              id: `spr_legacy_${ins.id}`,
              ...baseSnapshot,
              state: ins.state === '已停用' ? '在库' : '已出库',
              inboundDate: ins.installDate ?? '',
              outboundId: `ob_legacy_${ins.id}`,
              remark: '旧数据迁移生成',
              createdAt: stamp,
              updatedAt: stamp,
            });
            orderRows.push({
              id: `ob_legacy_${ins.id}`,
              orderNo: legacyNo,
              ...baseSnapshot,
              stationCode,
              purpose: '历史安装数据补单',
              receiver: '',
              outboundDate: ins.installDate ?? '',
              state: ins.state === '已停用' ? '已退库' : '已领用',
              returnDate: ins.state === '已停用' ? ins.installDate ?? null : null,
              returnReason: ins.state === '已停用' ? '历史停用回库' : '',
              installId: `ist_legacy_${ins.id}`,
              remark: '升级时按台站码 + 安装日期补号',
              createdAt: stamp,
              updatedAt: stamp,
            });
          } else {
            const missing = [
              !stationCode ? '台站码' : null,
              !ins.installDate ? '安装日期' : null,
            ]
              .filter(Boolean)
              .join('、');
            issueRows.push({
              id: `mig_legacy_${ins.id}`,
              kind: '旧数据补号失败',
              sourceInstrumentId: ins.id,
              serialNo: ins.serialNo ?? '',
              stationCode,
              installDate: ins.installDate ?? '',
              reason: `缺少${missing || '关键信息'}，无法按台站码 + 安装日期补出库单号`,
              resolved: false,
              createdAt: stamp,
              updatedAt: stamp,
            });
          }
        });

        await tx.table('spares').bulkPut(spareRows);
        await tx.table('outboundOrders').bulkPut(orderRows);
        await tx.table('installs').bulkPut(installRows);
        await tx.table('migrationIssues').bulkPut(issueRows);
      });
  }
}

export const db = new SeisArrayDatabase();

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** 订阅单表变化（Dexie liveQuery），返回取消订阅函数 */
export function watchTable<T>(
  table: () => Table<T, string>
): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray());
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([]),
      });
      return () => subscription.unsubscribe();
    },
  };
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedCalibration {
  id: string;
  instrumentId: string;
  date: string;
  sensitivity: number;
  selfNoise: number;
  operator: string;
  agency: string;
  remark: string;
}

interface SeedInstrument {
  id: string;
  stationId: string;
  type: Instrument['type'];
  model: string;
  serialNo: string;
  installDate: string;
  state: Instrument['state'];
  remark: string;
  calibrations: SeedCalibration[];
}

interface SeedStation {
  id: string;
  arrayId: string;
  code: string;
  lat: number;
  lng: number;
  elevM: number;
  bedrock: SeisStation['bedrock'];
  siteNote: string;
  instruments: SeedInstrument[];
}

interface SeedArray {
  id: string;
  name: string;
  apertureKm: number;
  deployDate: string;
  state: SeisArray['state'];
  department: string;
  stations: SeedStation[];
}

/**
 * 播种演示数据：2 个台阵 → 5 个台站 → 8 台仪器 → 14 条标定 + 3 条更换，
 * 覆盖「在用 / 待标定 / 已停用」与「合格 / 不合格」以及超期未标定样本。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const daysAgo = (days: number): string => new Date(now - days * 86400000).toISOString().slice(0, 10);

  const arrays: SeedArray[] = [
    {
      id: 'arr_ltx',
      name: '龙门峡流动台阵',
      apertureKm: 24.6,
      deployDate: '2021-04-18',
      state: '运行中',
      department: '省地震局监测中心',
      stations: [
        {
          id: 'stn_ltx_01',
          arrayId: 'arr_ltx',
          code: 'LTX01',
          lat: 30.8421,
          lng: 103.5624,
          elevM: 1180,
          bedrock: '花岗岩',
          siteNote: '基岩出露，噪声本底低',
          instruments: [
            {
              id: 'ins_ltx01_bb',
              stationId: 'stn_ltx_01',
              type: '宽频带',
              model: 'CMG-3ESPC',
              serialNo: 'CMG-3E-20210418-01',
              installDate: '2021-04-18',
              state: '在用',
              remark: '主用宽频带，配 24 位采集器',
              calibrations: [
                {
                  id: 'cal_ltx01_bb_1',
                  instrumentId: 'ins_ltx01_bb',
                  date: '2023-04-20',
                  sensitivity: 1502.4,
                  selfNoise: 1.82,
                  operator: '陈立群',
                  agency: '省地震局计量站',
                  remark: '响应曲线平滑',
                },
                {
                  id: 'cal_ltx01_bb_2',
                  instrumentId: 'ins_ltx01_bb',
                  date: '2024-04-12',
                  sensitivity: 1468.9,
                  selfNoise: 1.95,
                  operator: '陈立群',
                  agency: '省地震局计量站',
                  remark: '灵敏度略降 2.2%，仍在限内',
                },
              ],
            },
            {
              id: 'ins_ltx01_st',
              stationId: 'stn_ltx_01',
              type: '短周期',
              model: 'FSS-3B',
              serialNo: 'FSS3B-20210418-02',
              installDate: '2021-04-18',
              state: '待标定',
              remark: '备份仪器，已逾标定周期',
              calibrations: [
                {
                  id: 'cal_ltx01_st_1',
                  instrumentId: 'ins_ltx01_st',
                  date: '2022-05-06',
                  sensitivity: 412.6,
                  selfNoise: 2.4,
                  operator: '周渝',
                  agency: '省地震局计量站',
                  remark: '首次标定',
                },
              ],
            },
          ],
        },
        {
          id: 'stn_ltx_02',
          arrayId: 'arr_ltx',
          code: 'LTX02',
          lat: 30.9187,
          lng: 103.6412,
          elevM: 1425,
          bedrock: '玄武岩',
          siteNote: '半山台基，交通便利',
          instruments: [
            {
              id: 'ins_ltx02_bb',
              stationId: 'stn_ltx_02',
              type: '宽频带',
              model: 'Trillium-120',
              serialNo: 'T120-20220315-07',
              installDate: '2022-03-15',
              state: '在用',
              remark: '井下安装，深度 42 m',
              calibrations: [
                {
                  id: 'cal_ltx02_bb_1',
                  instrumentId: 'ins_ltx02_bb',
                  date: '2024-03-18',
                  sensitivity: 1204.8,
                  selfNoise: 1.42,
                  operator: '林之遥',
                  agency: '省地震局计量站',
                  remark: '响应一致性良好',
                },
              ],
            },
            {
              id: 'ins_ltx02_st',
              stationId: 'stn_ltx_02',
              type: '短周期',
              model: 'L-4C-3D',
              serialNo: 'L4C-20220315-08',
              installDate: '2022-03-15',
              state: '已停用',
              remark: '2024 年雷击损坏，已提交更换',
              calibrations: [
                {
                  id: 'cal_ltx02_st_1',
                  instrumentId: 'ins_ltx02_st',
                  date: '2023-03-10',
                  sensitivity: 265.2,
                  selfNoise: 4.8,
                  operator: '周渝',
                  agency: '省地震局计量站',
                  remark: '自噪超标，判定不合格',
                },
              ],
            },
          ],
        },
        {
          id: 'stn_ltx_03',
          arrayId: 'arr_ltx',
          code: 'LTX03',
          lat: 30.7802,
          lng: 103.4987,
          elevM: 986,
          bedrock: '石灰岩',
          siteNote: '河谷阶地，需注意汛期供电',
          instruments: [
            {
              id: 'ins_ltx03_bb',
              stationId: 'stn_ltx_03',
              type: '宽频带',
              model: 'STS-2.5',
              serialNo: 'STS25-20230902-11',
              installDate: '2023-09-02',
              state: '在用',
              remark: '新建站首台仪器',
              calibrations: [
                {
                  id: 'cal_ltx03_bb_1',
                  instrumentId: 'ins_ltx03_bb',
                  date: '2024-09-05',
                  sensitivity: 2251.3,
                  selfNoise: 2.05,
                  operator: '林之遥',
                  agency: '省地震局计量站',
                  remark: '脉冲响应合格',
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'arr_hx',
      name: '海西宽频带台阵',
      apertureKm: 46.2,
      deployDate: '2019-09-25',
      state: '运行中',
      department: '国家测震台网中心',
      stations: [
        {
          id: 'stn_hx_01',
          arrayId: 'arr_hx',
          code: 'HX01',
          lat: 25.4321,
          lng: 119.3421,
          elevM: 62,
          bedrock: '花岗岩',
          siteNote: '海岛台，防盐雾处理',
          instruments: [
            {
              id: 'ins_hx01_bb',
              stationId: 'stn_hx_01',
              type: '宽频带',
              model: 'Trillium-Compact',
              serialNo: 'TC-20190925-03',
              installDate: '2019-09-25',
              state: '在用',
              remark: '海岛主用观测设备',
              calibrations: [
                {
                  id: 'cal_hx01_bb_1',
                  instrumentId: 'ins_hx01_bb',
                  date: '2023-09-28',
                  sensitivity: 1498.2,
                  selfNoise: 2.25,
                  operator: '陈立群',
                  agency: '国家测震台网计量中心',
                  remark: '响应合格',
                },
                {
                  id: 'cal_hx01_bb_2',
                  instrumentId: 'ins_hx01_bb',
                  date: '2024-09-30',
                  sensitivity: 1483.6,
                  selfNoise: 2.42,
                  operator: '陈立群',
                  agency: '国家测震台网计量中心',
                  remark: '变化 0.97%，合格',
                },
              ],
            },
            {
              id: 'ins_hx01_sm',
              stationId: 'stn_hx_01',
              type: '强震',
              model: 'ES-T',
              serialNo: 'EST-20190925-04',
              installDate: '2019-09-25',
              state: '在用',
              remark: '结构台阵强震观测',
              calibrations: [
                {
                  id: 'cal_hx01_sm_1',
                  instrumentId: 'ins_hx01_sm',
                  date: '2024-09-30',
                  sensitivity: 1.24,
                  selfNoise: 1.05,
                  operator: '周渝',
                  agency: '国家测震台网计量中心',
                  remark: '强震通道合格',
                },
              ],
            },
          ],
        },
        {
          id: 'stn_hx_02',
          arrayId: 'arr_hx',
          code: 'HX02',
          lat: 25.2894,
          lng: 119.5112,
          elevM: 128,
          bedrock: '砂岩',
          siteNote: '覆盖层较厚，需做场地响应校正',
          instruments: [
            {
              id: 'ins_hx02_bb',
              stationId: 'stn_hx_02',
              type: '宽频带',
              model: 'CMG-3ESPC',
              serialNo: 'CMG-3E-20190926-05',
              installDate: '2019-09-26',
              state: '待标定',
              remark: '夜间自噪抬升，待复标',
              calibrations: [
                {
                  id: 'cal_hx02_bb_1',
                  instrumentId: 'ins_hx02_bb',
                  date: '2023-06-11',
                  sensitivity: 1388.4,
                  selfNoise: 3.9,
                  operator: '林之遥',
                  agency: '国家测震台网计量中心',
                  remark: '自噪接近上限，判定不合格',
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  const replaces: Replace[] = [
    {
      id: 'rpl_ltx02_st',
      instrumentId: 'ins_ltx02_st',
      reason: '雷击导致仪器损坏，标定不合格',
      newSerialNo: 'L4C-20250301-21',
      date: today,
      state: '待更换',
      operator: '周渝',
      remark: '新仪器已到货，待停电窗口安装',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'rpl_hx02_bb',
      instrumentId: 'ins_hx02_bb',
      reason: '自噪持续超标，按台网要求整机更换',
      newSerialNo: 'CMG-3E-20250410-33',
      date: daysAgo(20),
      state: '已更换',
      operator: '林之遥',
      remark: '已完成安装，待复核标定',
      createdAt: now - 20 * 86400000,
      updatedAt: now - 18 * 86400000,
    },
    {
      id: 'rpl_ltx01_st',
      instrumentId: 'ins_ltx01_st',
      reason: '超期未标定，更换为新型号',
      newSerialNo: 'FSS3B-20250506-24',
      date: daysAgo(60),
      state: '已复核',
      operator: '陈立群',
      remark: '复核标定合格，序列号已回写',
      createdAt: now - 60 * 86400000,
      updatedAt: now - 30 * 86400000,
    },
  ];

  /* -------- v3：装备库备件 / 出库单 × 台站安装登记 的分账演示数据 --------
   * 刻意覆盖：在库/锁定/已出库、已开立未领用、出了库没装上、装了没出库、
   * 撤回领用待退库、旧机回收失败（只重试台站侧）、补号异常各一类。 */
  const spareRows: SparePart[] = [
    // 已开立（锁定待领用）：雷击损坏那台的新备件已开单
    {
      id: 'spr_l4c_new',
      type: '短周期',
      model: 'L-4C-3D',
      serialNo: 'L4C-20250301-21',
      state: '锁定',
      inboundDate: daysAgo(90),
      outboundId: 'ob_ltx02_open',
      remark: '待停电窗口领用',
      createdAt: now - 90 * 86400000,
      updatedAt: now - 2 * 86400000,
    },
    // 已出库：HX02 已领已装
    {
      id: 'spr_cmg_hx02',
      type: '宽频带',
      model: 'CMG-3ESPC',
      serialNo: 'CMG-3E-20250410-33',
      state: '已出库',
      inboundDate: daysAgo(120),
      outboundId: 'ob_hx02_received',
      remark: '',
      createdAt: now - 120 * 86400000,
      updatedAt: now - 20 * 86400000,
    },
    // 出了库没装上：LTX03 备件已领，班组还没登记安装
    {
      id: 'spr_sts_ltx03',
      type: '宽频带',
      model: 'STS-2.5',
      serialNo: 'STS25-20250920-42',
      state: '已出库',
      inboundDate: daysAgo(200),
      outboundId: 'ob_ltx03_received',
      remark: '已随车带到台站，未安装',
      createdAt: now - 200 * 86400000,
      updatedAt: now - 3 * 86400000,
    },
    // 撤回领用待退库：备件物理上还在班组，装备库尚未确认退库
    {
      id: 'spr_fss_withdraw',
      type: '短周期',
      model: 'FSS-3B',
      serialNo: 'FSS3B-20250812-38',
      state: '已出库',
      inboundDate: daysAgo(150),
      outboundId: 'ob_ltx01_withdrawn',
      remark: '班组已撤回领用，等待装备库退库确认',
      createdAt: now - 150 * 86400000,
      updatedAt: now - 5 * 86400000,
    },
    // 回收失败的旧机已拆回装备库（出库单保持已领用不回退）
    {
      id: 'spr_cmg_ltx03_old',
      type: '宽频带',
      model: 'CMG-3ESPC',
      serialNo: 'CMG-3E-20200115-09',
      state: '在库',
      inboundDate: daysAgo(400),
      outboundId: 'ob_ltx03_old_received',
      remark: '回收失败旧机，待返厂',
      createdAt: now - 400 * 86400000,
      updatedAt: now - 9 * 86400000,
    },
    // 在库备件（无单据占用）
    {
      id: 'spr_stock_1',
      type: '宽频带',
      model: 'Trillium-120',
      serialNo: 'T120-20250701-05',
      state: '在库',
      inboundDate: daysAgo(60),
      outboundId: null,
      remark: '新到货',
      createdAt: now - 60 * 86400000,
      updatedAt: now - 60 * 86400000,
    },
    {
      id: 'spr_stock_2',
      type: '强震',
      model: 'ES-T',
      serialNo: 'EST-20250715-12',
      state: '在库',
      inboundDate: daysAgo(50),
      outboundId: null,
      remark: '',
      createdAt: now - 50 * 86400000,
      updatedAt: now - 50 * 86400000,
    },
  ];

  const outboundRows: OutboundOrder[] = [
    {
      id: 'ob_ltx02_open',
      orderNo: buildOrderNo(today, 1),
      serialNo: 'L4C-20250301-21',
      type: '短周期',
      model: 'L-4C-3D',
      stationCode: 'LTX02',
      purpose: '雷击损坏更换（待更换工单）',
      receiver: '周渝',
      outboundDate: daysAgo(2),
      state: '已开立',
      returnDate: null,
      returnReason: '',
      installId: null,
      remark: '已开单，序列号锁定待领用',
      createdAt: now - 2 * 86400000,
      updatedAt: now - 2 * 86400000,
    },
    {
      id: 'ob_hx02_received',
      orderNo: buildOrderNo(daysAgo(20), 1),
      serialNo: 'CMG-3E-20250410-33',
      type: '宽频带',
      model: 'CMG-3ESPC',
      stationCode: 'HX02',
      purpose: '自噪超标整机更换',
      receiver: '林之遥',
      outboundDate: daysAgo(20),
      state: '已领用',
      returnDate: null,
      returnReason: '',
      installId: 'ist_hx02_new',
      remark: '',
      createdAt: now - 20 * 86400000,
      updatedAt: now - 20 * 86400000,
    },
    {
      id: 'ob_ltx03_received',
      orderNo: buildOrderNo(daysAgo(3), 1),
      serialNo: 'STS25-20250920-42',
      type: '宽频带',
      model: 'STS-2.5',
      stationCode: 'LTX03',
      purpose: '备件轮换',
      receiver: '周渝',
      outboundDate: daysAgo(3),
      state: '已领用',
      returnDate: null,
      returnReason: '',
      installId: null,
      remark: '对账异常：出了库还没装上台站',
      createdAt: now - 3 * 86400000,
      updatedAt: now - 3 * 86400000,
    },
    {
      id: 'ob_ltx01_withdrawn',
      orderNo: buildOrderNo(daysAgo(12), 1),
      serialNo: 'FSS3B-20250812-38',
      type: '短周期',
      model: 'FSS-3B',
      stationCode: 'LTX01',
      purpose: '备份位升级',
      receiver: '陈立群',
      outboundDate: daysAgo(12),
      state: '已领用',
      returnDate: null,
      returnReason: '',
      installId: 'ist_ltx01_withdrawn',
      remark: '班组已撤回领用，待装备库确认退库后解锁序列号',
      createdAt: now - 12 * 86400000,
      updatedAt: now - 5 * 86400000,
    },
    {
      id: 'ob_ltx03_old_received',
      orderNo: buildOrderNo(daysAgo(400), 2),
      serialNo: 'CMG-3E-20200115-09',
      type: '宽频带',
      model: 'CMG-3ESPC',
      stationCode: 'LTX03',
      purpose: '历史装机出库',
      receiver: '陈立群',
      outboundDate: daysAgo(400),
      state: '已领用',
      returnDate: null,
      returnReason: '',
      installId: 'ist_ltx03_old',
      remark: '旧机回收失败，出库单不回退',
      createdAt: now - 400 * 86400000,
      updatedAt: now - 9 * 86400000,
    },
  ];

  const installRows: InstallRecord[] = [
    {
      id: 'ist_hx02_new',
      stationId: 'stn_hx_02',
      stationCode: 'HX02',
      slot: '地表基岩位',
      serialNo: 'CMG-3E-20250410-33',
      type: '宽频带',
      model: 'CMG-3ESPC',
      outboundId: 'ob_hx02_received',
      outboundNo: buildOrderNo(daysAgo(20), 1),
      installDate: daysAgo(20),
      installer: '林之遥',
      state: '已安装',
      removeDate: null,
      removeReason: '',
      recoveryResult: null,
      retryCount: 0,
      recoveryNote: '',
      withdrawn: false,
      remark: '更换后待复核标定',
      createdAt: now - 20 * 86400000,
      updatedAt: now - 20 * 86400000,
    },
    {
      id: 'ist_ltx01_withdrawn',
      stationId: 'stn_ltx_01',
      stationCode: 'LTX01',
      slot: '备份短周期位',
      serialNo: 'FSS3B-20250812-38',
      type: '短周期',
      model: 'FSS-3B',
      outboundId: 'ob_ltx01_withdrawn',
      outboundNo: buildOrderNo(daysAgo(12), 1),
      installDate: daysAgo(10),
      installer: '陈立群',
      state: '已拆卸',
      removeDate: daysAgo(5),
      removeReason: '撤回领用：型号与采集器不匹配',
      recoveryResult: '已回收',
      retryCount: 0,
      recoveryNote: '',
      withdrawn: true,
      remark: '台站侧已撤回，等装备库退库',
      createdAt: now - 10 * 86400000,
      updatedAt: now - 5 * 86400000,
    },
    {
      id: 'ist_ltx03_old',
      stationId: 'stn_ltx_03',
      stationCode: 'LTX03',
      slot: '井下位 B',
      serialNo: 'CMG-3E-20200115-09',
      type: '宽频带',
      model: 'CMG-3ESPC',
      outboundId: 'ob_ltx03_old_received',
      outboundNo: buildOrderNo(daysAgo(400), 2),
      installDate: daysAgo(400),
      installer: '陈立群',
      state: '回收失败',
      removeDate: daysAgo(9),
      removeReason: '到期轮换',
      recoveryResult: '回收失败',
      retryCount: 2,
      recoveryNote: '第 1 次：运输车辆故障；第 2 次：旧机底座锈蚀未拆成，已约井下作业窗口',
      withdrawn: false,
      remark: '只在台站侧重试回收，装备库出库单不动',
      createdAt: now - 400 * 86400000,
      updatedAt: now - 1 * 86400000,
    },
    {
      // 装了没出库：班组先装后补手续，装备库查无已领用单
      id: 'ist_hx01_unplanned',
      stationId: 'stn_hx_01',
      stationCode: 'HX01',
      slot: '强震备机位',
      serialNo: 'GLP2-20250928-07',
      type: '强震',
      model: 'GL-P2B',
      outboundId: null,
      outboundNo: '',
      installDate: daysAgo(8),
      installer: '林之遥',
      state: '已安装',
      removeDate: null,
      removeReason: '',
      recoveryResult: null,
      retryCount: 0,
      recoveryNote: '',
      withdrawn: false,
      remark: '应急先装，出库手续未补',
      createdAt: now - 8 * 86400000,
      updatedAt: now - 8 * 86400000,
    },
  ];

  // 升级补号异常演示：来源仪器缺失安装日期，补不出单号（新库演示等价物）
  const migrationIssueRows: MigrationIssue[] = [
    {
      id: 'mig_demo_missing_date',
      kind: '旧数据补号失败',
      sourceInstrumentId: 'ins_legacy_demo_unknown',
      serialNo: 'TC-20180707-00',
      stationCode: 'LTX03',
      installDate: '',
      reason: '缺少安装日期，无法按台站码 + 安装日期补出库单号',
      resolved: false,
      createdAt: now - 30 * 86400000,
      updatedAt: now - 30 * 86400000,
    },
  ];

  await db.transaction(
    'rw',
    [
      db.arrays,
      db.stations,
      db.instruments,
      db.calibrations,
      db.replaces,
      db.spares,
      db.outboundOrders,
      db.installs,
      db.migrationIssues,
    ],
    async () => {
      const stamp = (offset: number): { createdAt: number; updatedAt: number } => ({
        createdAt: now + offset,
        updatedAt: now + offset,
      });

      const arrayRows: SeisArray[] = [];
      const stationRows: SeisStation[] = [];
      const instrumentRows: Instrument[] = [];
      const calibrationRows: Calibration[] = [];

      arrays.forEach((seed, arrayIndex) => {
        const { stations, ...arrayRest } = seed;
        arrayRows.push({ ...arrayRest, stationCount: stations.length, ...stamp(arrayIndex) });
        stations.forEach((stationSeed, stationIndex) => {
          const { instruments, ...stationRest } = stationSeed;
          stationRows.push({ ...stationRest, ...stamp(100 + arrayIndex * 100 + stationIndex) });
          instruments.forEach((instrumentSeed, instrumentIndex) => {
            const { calibrations, ...instrumentRest } = instrumentSeed;
            instrumentRows.push({
              ...instrumentRest,
              ...stamp(200 + arrayIndex * 200 + stationIndex * 50 + instrumentIndex),
            });
            calibrations.forEach((calibrationSeed, calibrationIndex) => {
              const verdict = judgeCalibration(
                instrumentRest.type,
                calibrationSeed.sensitivity,
                calibrationSeed.selfNoise
              );
              calibrationRows.push({
                ...calibrationSeed,
                responseVerdict: verdict,
                ...stamp(
                  400 + arrayIndex * 400 + stationIndex * 100 + instrumentIndex * 20 + calibrationIndex
                ),
              });
            });
          });
        });
      });

      await db.arrays.bulkPut(arrayRows);
      await db.stations.bulkPut(stationRows);
      await db.instruments.bulkPut(instrumentRows);
      await db.calibrations.bulkPut(calibrationRows);
      await db.replaces.bulkPut(replaces);
      await db.spares.bulkPut(spareRows);
      await db.outboundOrders.bulkPut(outboundRows);
      await db.installs.bulkPut(installRows);
      await db.migrationIssues.bulkPut(migrationIssueRows);
    }
  );
}

/** 打开数据库并幂等播种：仅当台阵表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open();
  const count = await db.arrays.count();
  if (count === 0) {
    await seedDemoData();
  }
  stampDbVersion();
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.arrays,
      db.stations,
      db.instruments,
      db.calibrations,
      db.replaces,
      db.spares,
      db.outboundOrders,
      db.installs,
      db.migrationIssues,
    ],
    async () => {
      await Promise.all([
        db.arrays.clear(),
        db.stations.clear(),
        db.instruments.clear(),
        db.calibrations.clear(),
        db.replaces.clear(),
        db.spares.clear(),
        db.outboundOrders.clear(),
        db.installs.clear(),
        db.migrationIssues.clear(),
      ]);
    }
  );
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDemoData();
}

/** 统计各表行数，供页脚概览与几何页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [arrays, stations, instruments, calibrations, replaces, spares, outboundOrders, installs, migrationIssues] =
    await Promise.all([
      db.arrays.count(),
      db.stations.count(),
      db.instruments.count(),
      db.calibrations.count(),
      db.replaces.count(),
      db.spares.count(),
      db.outboundOrders.count(),
      db.installs.count(),
      db.migrationIssues.count(),
    ]);
  return { arrays, stations, instruments, calibrations, replaces, spares, outboundOrders, installs, migrationIssues };
}

/** 写入结构版本号到 localStorage，便于几何页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION));
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion);
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION;
  } catch {
    return DB_VERSION;
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso);
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt);
  } catch {
    return null;
  }
}

export function readLastArrayId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastArrayId);
  } catch {
    return null;
  }
}

export function writeLastArrayId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastArrayId);
    else localStorage.setItem(LS_KEYS.lastArrayId, id);
  } catch {
    // 忽略
  }
}
