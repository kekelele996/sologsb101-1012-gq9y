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
import type { SparePart, OutboundOrder } from '@/types/spare';
import type { InstallRecord, RemovalRecord } from '@/types/ops';
import { backfillLegacyOutboundNo } from '@/utils/reconcile';

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
  spareParts: SparePart[];
  outboundOrders: OutboundOrder[];
  installs: InstallRecord[];
  removals: RemovalRecord[];
}

export class SeisArrayDatabase extends Dexie {
  arrays!: Table<SeisArray, string>;
  stations!: Table<SeisStation, string>;
  instruments!: Table<Instrument, string>;
  calibrations!: Table<Calibration, string>;
  replaces!: Table<Replace, string>;
  spareParts!: Table<SparePart, string>;
  outboundOrders!: Table<OutboundOrder, string>;
  installs!: Table<InstallRecord, string>;
  removals!: Table<RemovalRecord, string>;

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
    this.version(DB_VERSION)
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

    // v3：装备库（备件库存 / 出库单）与台站运维（安装登记 / 拆卸登记）两套账本。
    // 旧数据没有出库单号：升级时按台站码 + 安装日期回填，补不出的 outboundRef='none' 单列。
    this.version(DB_VERSION)
      .stores({
        arrays: 'id, name, state, apertureKm, deployDate, department, updatedAt',
        stations: 'id, arrayId, code, lat, lng, elevM, bedrock, updatedAt',
        instruments: 'id, stationId, type, model, serialNo, installDate, state, updatedAt',
        calibrations: 'id, instrumentId, date, sensitivity, selfNoise, responseVerdict, updatedAt',
        replaces: 'id, instrumentId, state, date, newSerialNo, updatedAt',
        spareParts: 'id, serialNo, state, type, outboundNo, updatedAt',
        outboundOrders: 'id, outboundNo, serialNo, stationCode, state, outboundDate, updatedAt',
        installs: 'id, stationCode, slotCode, serialNo, installDate, outboundNo, state, outboundRef, updatedAt',
        removals: 'id, installId, stationCode, serialNo, removeDate, recycle, updatedAt',
      })
      .upgrade(async (tx) => {
        // 旧库的「仪器」记录整体转成台站侧安装登记（安装位 + 装机事实），
        // 单号先留空（none），再按台站码 + 安装日期与出库单尝试唯一匹配回填。
        const stations = await tx.table<SeisStation, string>('stations').toArray();
        const stationCodeById = new Map(stations.map((station) => [station.id, station.code]));
        const legacyInstruments = await tx.table<Instrument, string>('instruments').toArray();
        const now = Date.now();

        const installs: InstallRecord[] = legacyInstruments.map((instrument) => {
          const stationCode = stationCodeById.get(instrument.stationId) ?? '';
          const slotType: InstallRecord['slotType'] =
            instrument.type === '宽频带' || instrument.type === '短周期' || instrument.type === '强震'
              ? instrument.type
              : '其他';
          return {
            id: createId('inslog'),
            stationCode,
            slotCode: `${slotType}-${stationCode || 'UNK'}`,
            slotType,
            serialNo: instrument.serialNo,
            model: instrument.model,
            installDate: instrument.installDate,
            outboundNo: '',
            outboundRef: 'none',
            state: instrument.state === '已停用' ? '已拆除' : '已装机',
            removalId: '',
            operator: '',
            remark: 'v3 升级自旧仪器档案',
            createdAt: instrument.createdAt ?? now,
            updatedAt: now,
          };
        });

        const orders = await tx.table<OutboundOrder, string>('outboundOrders').toArray();
        backfillLegacyOutboundNo(installs, orders);
        if (installs.length > 0) {
          await tx.table<InstallRecord, string>('installs').bulkPut(installs);
        }
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

  /* ----------------- 装备库 / 台站运维双账本演示数据 -----------------
   * 刻意覆盖：正常对得上、出了库没装上、装了没出库、旧数据补不出单号、
   * 撤回退库（原单保留解锁）、库管作废（待领用）、旧机回收失败待重试。
   */
  const spareParts: SparePart[] = [];
  const outboundOrders: OutboundOrder[] = [];
  const installs: InstallRecord[] = [];
  const removals: RemovalRecord[] = [];

  const addPart = (
    id: string,
    serialNo: string,
    type: SparePart['type'],
    model: string,
    state: SparePart['state'],
    outboundNo: string,
    inboundDate: string,
    location: string
  ): void => {
    spareParts.push({
      id,
      type,
      model,
      serialNo,
      state,
      outboundNo,
      inboundDate,
      location,
      remark: '',
      createdAt: now,
      updatedAt: now,
    });
  };

  const addOrder = (order: Omit<OutboundOrder, 'createdAt' | 'updatedAt'>): void => {
    outboundOrders.push({ ...order, createdAt: now, updatedAt: now });
  };

  // 已装机（对得上）：8 台在用仪器里，CMG33 为新机，其余 5 台在用旧机走旧单
  const matchedLegacy: Array<[string, string, string, string]> = [
    // [序列号, 台站码, 出库日期, 库位]
    ['CMG-3E-20210418-01', 'LTX01', '2021-04-18', 'A-01'],
    ['T120-20220315-07', 'LTX02', '2022-03-15', 'A-03'],
    ['STS25-20230902-11', 'LTX03', '2023-09-02', 'A-05'],
    ['TC-20190925-03', 'HX01', '2019-09-25', 'A-07'],
    ['EST-20190925-04', 'HX01', '2019-09-25', 'B-02'],
  ];
  matchedLegacy.forEach(([serialNo, stationCode, date, location], index) => {
    const no = `CK-${date.replace(/-/g, '')}-${String(101 + index).padStart(3, '0')}`;
    addPart(`prt_old_${index}`, serialNo, '宽频带', serialNo.split('-')[0], '已装机', no, date, location);
    addOrder({
      id: `ob_old_${index}`,
      outboundNo: no,
      serialNo,
      type: '宽频带',
      model: serialNo.split('-')[0],
      stationCode,
      purpose: '台站建设装机',
      keeper: '库管-赵敏',
      receiver: '陈立群',
      outboundDate: date,
      state: '已装机',
      closedAt: null,
      returnOperator: '',
      closeReason: '',
      remark: '历史出库单',
    });
  });

  // 新机 CMG33（HX02 更换已完成，已装机）
  addPart('prt_cmg33', 'CMG-3E-20250410-33', '宽频带', 'CMG-3ESPC', '已装机', 'CK-20250320-006', daysAgo(190), 'A-09');
  addOrder({
    id: 'ob_cmg33',
    outboundNo: 'CK-20250320-006',
    serialNo: 'CMG-3E-20250410-33',
    type: '宽频带',
    model: 'CMG-3ESPC',
    stationCode: 'HX02',
    purpose: '更换自噪超标旧机',
    keeper: '库管-赵敏',
    receiver: '林之遥',
    outboundDate: daysAgo(190),
    state: '已装机',
    closedAt: null,
    returnOperator: '',
    closeReason: '',
    remark: '',
  });

  // 已拆除旧机：出库单保留（不回退），回收失败待台站侧重试
  addPart('prt_cmg05', 'CMG-3E-20190926-05', '宽频带', 'CMG-3ESPC', '已出库', 'CK-20190926-106', '2019-09-26', '');
  addOrder({
    id: 'ob_cmg05',
    outboundNo: 'CK-20190926-106',
    serialNo: 'CMG-3E-20190926-05',
    type: '宽频带',
    model: 'CMG-3ESPC',
    stationCode: 'HX02',
    purpose: '台站建设装机',
    keeper: '库管-赵敏',
    receiver: '林之遥',
    outboundDate: '2019-09-26',
    state: '已装机',
    closedAt: null,
    returnOperator: '',
    closeReason: '',
    remark: '旧机已拆，回收失败，单不回退',
  });

  // 出了库没装上①：已领用、班组还没装
  addPart('prt_l4c21', 'L4C-20250301-21', '短周期', 'L-4C-3D', '已出库', 'CK-20260928-007', daysAgo(120), '');
  addOrder({
    id: 'ob_l4c21',
    outboundNo: 'CK-20260928-007',
    serialNo: 'L4C-20250301-21',
    type: '短周期',
    model: 'L-4C-3D',
    stationCode: 'LTX02',
    purpose: '雷击损坏更换',
    keeper: '库管-赵敏',
    receiver: '周渝',
    outboundDate: daysAgo(8),
    state: '已领用',
    closedAt: null,
    returnOperator: '',
    closeReason: '',
    remark: '已领用待停电窗口安装',
  });

  // 出了库没装上②：开单待领用，序列号锁定
  addPart('prt_fss24', 'FSS3B-20250506-24', '短周期', 'FSS-3B', '已锁定', 'CK-20261005-008', daysAgo(60), '');
  addOrder({
    id: 'ob_fss24',
    outboundNo: 'CK-20261005-008',
    serialNo: 'FSS3B-20250506-24',
    type: '短周期',
    model: 'FSS-3B',
    stationCode: 'LTX01',
    purpose: '超期整机更换',
    keeper: '库管-赵敏',
    receiver: '',
    outboundDate: daysAgo(1),
    state: '待领用',
    closedAt: null,
    returnOperator: '',
    closeReason: '',
    remark: '开单即锁，待班组领用',
  });

  // 撤回退库：班组领用后撤回，原单置「已撤回」保留，库存 +1、序列号解锁
  addPart('prt_sts26', 'STS25-20250608-26', '宽频带', 'STS-2.5', '在库', '', daysAgo(200), 'A-11');
  addOrder({
    id: 'ob_sts26',
    outboundNo: 'CK-20260920-005',
    serialNo: 'STS25-20250608-26',
    type: '宽频带',
    model: 'STS-2.5',
    stationCode: 'LTX03',
    purpose: '备机更换（后取消）',
    keeper: '库管-赵敏',
    receiver: '周渝',
    outboundDate: daysAgo(16),
    state: '已撤回',
    closedAt: now - 10 * 86400000,
    returnOperator: '周渝',
    closeReason: '现场判断旧机仍可用，撤回领用退库',
    remark: '先撤领用再解锁，库存已回补',
  });

  // 库管作废：开单后尚未领用即发现开错，作废解锁（不写退库流水）
  addPart('prt_void', 'CMG-3E-20250801-30', '宽频带', 'CMG-3ESPC', '在库', '', daysAgo(90), 'A-12');
  addOrder({
    id: 'ob_void',
    outboundNo: 'CK-20261002-009',
    serialNo: 'CMG-3E-20250801-30',
    type: '宽频带',
    model: 'CMG-3ESPC',
    stationCode: 'HX01',
    purpose: '台站码开错，作废重开',
    keeper: '库管-赵敏',
    receiver: '',
    outboundDate: daysAgo(4),
    state: '已作废',
    closedAt: now - 3 * 86400000,
    returnOperator: '',
    closeReason: '领用台站开错，库管作废',
    remark: '待领用态可作废，已领用不可',
  });

  // 装了没出库：台站上有、装备库查无有效出库单
  addPart('prt_ghost', 'CDJ-20240707-77', '短周期', 'CDJ-S2C', '已装机', '', '2024-07-01', '');
  // （无出库单，刻意制造异常）

  // 在库可用备件
  addPart('prt_stock_1', 'FSS3B-20260101-40', '短周期', 'FSS-3B', '在库', '', daysAgo(30), 'C-01');
  addPart('prt_stock_2', 'ES-T-20260102-41', '强震', 'ES-T', '在库', '', daysAgo(29), 'C-02');
  addPart('prt_stock_3', 'PWR-20260103-42', '电源', 'PS-12V', '在库', '', daysAgo(28), 'D-01');
  addPart('prt_stock_4', 'CMG-3E-20260104-43', '宽频带', 'CMG-3ESPC', '在库', '', daysAgo(27), 'A-13');

  /* ---- 台站侧安装登记（安装位 + 装机事实） ---- */
  const addInstall = (row: Omit<InstallRecord, 'createdAt' | 'updatedAt'>): void => {
    installs.push({ ...row, createdAt: now, updatedAt: now });
  };
  const addRemoval = (row: Omit<RemovalRecord, 'createdAt' | 'updatedAt'>): void => {
    removals.push({ ...row, createdAt: now, updatedAt: now });
  };

  // 5 台旧机（升级回填成功：台站码+安装日期唯一命中历史出库单）
  const legacyInstallSlots: Array<[string, string, string, string, string, string]> = [
    // [序列号, 台站码, 安装位, 型号, 安装日期, 类型]
    ['CMG-3E-20210418-01', 'LTX01', 'BB-主台', 'CMG-3ESPC', '2021-04-18', '宽频带'],
    ['T120-20220315-07', 'LTX02', 'BB-井下42m', 'Trillium-120', '2022-03-15', '宽频带'],
    ['STS25-20230902-11', 'LTX03', 'BB-地表', 'STS-2.5', '2023-09-02', '宽频带'],
    ['TC-20190925-03', 'HX01', 'BB-海岛基岩', 'Trillium-Compact', '2019-09-25', '宽频带'],
    ['EST-20190925-04', 'HX01', 'SM-结构台阵', 'ES-T', '2019-09-25', '强震'],
  ];
  legacyInstallSlots.forEach(([serialNo, stationCode, slotCode, model, installDate, slotType], index) => {
    addInstall({
      id: `ist_old_${index}`,
      stationCode,
      slotCode,
      slotType: slotType as InstallRecord['slotType'],
      serialNo,
      model,
      installDate,
      outboundNo: '',
      outboundRef: 'none',
      state: '已装机',
      removalId: '',
      operator: '陈立群',
      remark: '旧数据，待按台站码+安装日期回填单号',
    });
  });

  // 已拆除旧机 CMG05（HX02），回收失败；新机 CMG33 在其安装位
  addInstall({
    id: 'ist_cmg05',
    stationCode: 'HX02',
    slotCode: 'BB-覆盖层台基',
    slotType: '宽频带',
    serialNo: 'CMG-3E-20190926-05',
    model: 'CMG-3ESPC',
    installDate: '2019-09-26',
    outboundNo: 'CK-20190926-106',
    outboundRef: 'new',
    state: '已拆除',
    removalId: 'rmv_cmg05',
    operator: '林之遥',
    remark: '自噪超标拆下，旧机回收失败',
  });
  addRemoval({
    id: 'rmv_cmg05',
    installId: 'ist_cmg05',
    stationCode: 'HX02',
    slotCode: 'BB-覆盖层台基',
    serialNo: 'CMG-3E-20190926-05',
    removeDate: daysAgo(20),
    reason: '自噪持续超标，整机更换',
    recycle: '回收失败',
    retryAt: now - 12 * 86400000,
    retryCount: 2,
    lastError: '物流公司称外包装破损拒收，待重新打包',
    operator: '林之遥',
    remark: '只在台站侧重试，出库单 CK-20190926-106 不回退',
  });
  addInstall({
    id: 'ist_cmg33',
    stationCode: 'HX02',
    slotCode: 'BB-覆盖层台基',
    slotType: '宽频带',
    serialNo: 'CMG-3E-20250410-33',
    model: 'CMG-3ESPC',
    installDate: daysAgo(20),
    outboundNo: 'CK-20250320-006',
    outboundRef: 'new',
    state: '已装机',
    removalId: '',
    operator: '林之遥',
    remark: '更换已完成，待复核标定',
  });

  // 装了没出库（异常）
  addInstall({
    id: 'ist_ghost',
    stationCode: 'LTX01',
    slotCode: 'ST-地表备份',
    slotType: '短周期',
    serialNo: 'CDJ-20240707-77',
    model: 'CDJ-S2C',
    installDate: '2024-07-07',
    outboundNo: '',
    outboundRef: 'new',
    state: '已装机',
    removalId: '',
    operator: '周渝',
    remark: '班组自行调拨，未走装备库出库',
  });

  // 旧数据补不出单号（同日同台站多机，无法唯一匹配）：LTX01 旧短周期，与 BB 主台同日
  addInstall({
    id: 'ist_fss02',
    stationCode: 'LTX01',
    slotCode: 'ST-备份位',
    slotType: '短周期',
    serialNo: 'FSS3B-20210418-02',
    model: 'FSS-3B',
    installDate: '2021-04-18',
    outboundNo: '',
    outboundRef: 'none',
    state: '已装机',
    removalId: '',
    operator: '周渝',
    remark: '与 BB 主台同日同站，回填歧义，单列人工补',
  });

  // 升级回填演示：对旧安装执行一次「台站码+安装日期」唯一匹配
  backfillLegacyOutboundNo(installs, outboundOrders);

  await db.transaction(
    'rw',
    [
      db.arrays,
      db.stations,
      db.instruments,
      db.calibrations,
      db.replaces,
      db.spareParts,
      db.outboundOrders,
      db.installs,
      db.removals,
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
      await db.spareParts.bulkPut(spareParts);
      await db.outboundOrders.bulkPut(outboundOrders);
      await db.installs.bulkPut(installs);
      await db.removals.bulkPut(removals);
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
      db.spareParts,
      db.outboundOrders,
      db.installs,
      db.removals,
    ],
    async () => {
      await Promise.all([
        db.arrays.clear(),
        db.stations.clear(),
        db.instruments.clear(),
        db.calibrations.clear(),
        db.replaces.clear(),
        db.spareParts.clear(),
        db.outboundOrders.clear(),
        db.installs.clear(),
        db.removals.clear(),
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
  const [arrays, stations, instruments, calibrations, replaces, spareParts, outboundOrders, installs, removals] =
    await Promise.all([
      db.arrays.count(),
      db.stations.count(),
      db.instruments.count(),
      db.calibrations.count(),
      db.replaces.count(),
      db.spareParts.count(),
      db.outboundOrders.count(),
      db.installs.count(),
      db.removals.count(),
    ]);
  return {
    arrays,
    stations,
    instruments,
    calibrations,
    replaces,
    spareParts,
    outboundOrders,
    installs,
    removals,
  };
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
