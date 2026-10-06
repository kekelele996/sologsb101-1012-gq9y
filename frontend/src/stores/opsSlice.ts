/**
 * 台站运维班组 slice：安装位与拆卸登记（台站限界上下文）。
 *
 * 职责边界：
 *  - 班组只写 installs / migrationIssues；领用确认、序列号锁定/解锁由装备库掌管，
 *    班组侧的编排动作在同一事务内联动出库单与备件（receiveAndInstall），
 *    但「撤回领用」只改台站这侧（withdrawInstall），解锁必须等装备库 returnOrder。
 *  - 旧机回收失败只重试台站这侧（retryRecovery），出库单保留不回退。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import type {
  InstallDraft,
  InstallFilterState,
  InstallRecord,
  RecoveryResult,
} from '@/types/install';
import { createEmptyInstallFilter } from '@/types/install';
import type { MigrationIssue } from '@/types/migration';
import type { RootState } from '@/stores/store';

type WithOps = RootState;

export interface OpsSliceState {
  installs: InstallRecord[];
  issues: MigrationIssue[];
  ready: boolean;
  error: string | null;
  filter: InstallFilterState;
  lastReceipt: string;
}

const initialState: OpsSliceState = {
  installs: [],
  issues: [],
  ready: false,
  error: null,
  filter: createEmptyInstallFilter(),
  lastReceipt: '',
};

/** 从出库单 + 台站生成安装登记（台站侧序列号以出库单为准） */
export interface ReceiveInstallInput {
  orderId: string;
  stationId: string;
  slot: string;
  installDate: string;
  installer: string;
  remark?: string;
}

/**
 * 领用并安装（班组一站式动作）：
 * 出库单 已开立 → 已领用，备件 锁定 → 已出库，台站侧落安装登记并回填 installId。
 */
export const receiveAndInstall = createAsyncThunk(
  'ops/receiveAndInstall',
  async (input: ReceiveInstallInput, { rejectWithValue }) => {
    const now = Date.now();
    try {
      const installId = createId('ist');
      await db.transaction(
        'rw',
        [db.outboundOrders, db.spares, db.installs, db.stations],
        async () => {
          const order = await db.outboundOrders.get(input.orderId);
          if (!order) throw new Error('出库单不存在');
          if (order.state !== '已开立') throw new Error(`单据当前为「${order.state}」，不能领用安装`);
          const station = await db.stations.get(input.stationId);
          if (!station) throw new Error('台站不存在');
          const installDate = input.installDate || order.outboundDate;
          const install: InstallRecord = {
            id: installId,
            stationId: station.id,
            stationCode: station.code,
            slot: input.slot.trim() || '默认安装位',
            serialNo: order.serialNo,
            type: order.type,
            model: order.model,
            outboundId: order.id,
            outboundNo: order.orderNo,
            installDate,
            installer: input.installer.trim(),
            state: '已安装',
            removeDate: null,
            removeReason: '',
            recoveryResult: null,
            retryCount: 0,
            recoveryNote: '',
            withdrawn: false,
            remark: input.remark?.trim() ?? order.remark,
            createdAt: now,
            updatedAt: now,
          };
          await db.installs.put(install);
          await db.outboundOrders.update(order.id, {
            state: '已领用',
            installId,
            updatedAt: now,
          } as never);
          const spare = await db.spares.where('serialNo').equals(order.serialNo).first();
          if (spare) {
            await db.spares.update(spare.id, { state: '已出库', updatedAt: now } as never);
          }
        }
      );
      return installId;
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '领用安装失败');
    }
  }
);

/**
 * 直接登记安装（不经过装备库出库单）。
 * 用于补现场先装的情况：对账页会把它单列进「装了又没出库」，
 * 若填了已开立单号且序列号一致，则顺带完成领用确认。
 */
export const registerInstall = createAsyncThunk(
  'ops/registerInstall',
  async (payload: InstallDraft & { type: string; model: string }, { rejectWithValue }) => {
    const now = Date.now();
    try {
      await db.transaction(
        'rw',
        [db.installs, db.stations, db.outboundOrders, db.spares],
        async () => {
          const station = await db.stations.get(payload.stationId);
          if (!station) throw new Error('台站不存在');
          const serialNo = payload.serialNo.trim();
          if (!serialNo) throw new Error('序列号不能为空');
          let outboundId: string | null = null;
          let outboundNo = payload.outboundNo.trim();
          if (outboundNo) {
            const order = await db.outboundOrders.where('orderNo').equals(outboundNo).first();
            if (!order) throw new Error(`查无出库单号 ${outboundNo}，请先到装备库开单或留空（将列入对账异常）`);
            if (order.serialNo !== serialNo) {
              throw new Error(`出库单 ${outboundNo} 的序列号是「${order.serialNo}」，与登记序列号不一致`);
            }
            if (order.state === '已退库') throw new Error('该出库单已退库，不能再安装');
            outboundId = order.id;
            if (order.state === '已开立') {
              await db.outboundOrders.update(order.id, { state: '已领用', updatedAt: now } as never);
              const spare = await db.spares.where('serialNo').equals(serialNo).first();
              if (spare) {
                await db.spares.update(spare.id, { state: '已出库', updatedAt: now } as never);
              }
            }
          } else {
            outboundNo = '';
          }
          const installId = createId('ist');
          const install: InstallRecord = {
            id: installId,
            stationId: station.id,
            stationCode: station.code,
            slot: payload.slot.trim() || '默认安装位',
            serialNo,
            type: payload.type,
            model: payload.model,
            outboundId,
            outboundNo,
            installDate: payload.installDate,
            installer: payload.installer.trim(),
            state: '已安装',
            removeDate: null,
            removeReason: '',
            recoveryResult: null,
            retryCount: 0,
            recoveryNote: '',
            withdrawn: false,
            remark: payload.remark.trim(),
            createdAt: now,
            updatedAt: now,
          };
          await db.installs.put(install);
          if (outboundId) {
            await db.outboundOrders.update(outboundId, { installId, updatedAt: now } as never);
          }
        }
      );
      return payload;
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '安装登记失败');
    }
  }
);

/** 拆卸登记：超期名单只认仍在安装位上的记录，拆下来后自动摘除 */
export const removeFromSlot = createAsyncThunk(
  'ops/removeFromSlot',
  async (
    payload: { id: string; removeDate: string; reason: string; recoveryResult: RecoveryResult; note?: string },
    { rejectWithValue }
  ) => {
    const now = Date.now();
    try {
      await db.transaction('rw', [db.installs], async () => {
        const install = await db.installs.get(payload.id);
        if (!install) throw new Error('安装登记不存在');
        if (install.state !== '已安装') throw new Error(`当前为「${install.state}」，不能重复拆卸`);
        await db.installs.update(payload.id, {
          state: payload.recoveryResult === '回收失败' ? '回收失败' : '已拆卸',
          removeDate: payload.removeDate,
          removeReason: payload.reason.trim(),
          recoveryResult: payload.recoveryResult,
          recoveryNote: payload.note?.trim() ?? '',
          retryCount: payload.recoveryResult === '回收失败' ? 1 : 0,
          updatedAt: now,
        } as never);
      });
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '拆卸登记失败');
    }
    return payload;
  }
);

/**
 * 撤回领用（台站侧动作，闭环第一步）：
 * 安装位上的设备拆下退回 → withdrawn=true；装备库的出库单与库存这一步一律不动，
 * 必须等装备库确认退库后才解锁序列号（见 warehouseSlice.returnOrder）。
 */
export const withdrawInstall = createAsyncThunk(
  'ops/withdrawInstall',
  async (payload: { id: string; reason: string; removeDate?: string }, { rejectWithValue }) => {
    const now = Date.now();
    try {
      await db.transaction('rw', [db.installs], async () => {
        const install = await db.installs.get(payload.id);
        if (!install) throw new Error('安装登记不存在');
        if (install.state !== '已安装') throw new Error('只有安装在位的记录可以撤回领用');
        await db.installs.update(payload.id, {
          state: '已拆卸',
          removeDate: payload.removeDate ?? new Date().toISOString().slice(0, 10),
          removeReason: payload.reason.trim() || '班组撤回领用',
          recoveryResult: '已回收',
          withdrawn: true,
          updatedAt: now,
        } as never);
      });
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '撤回领用失败');
    }
    return payload;
  }
);

/**
 * 旧机回收重试：只动台站侧登记（累计重试次数与备注）。
 * 装备库出库单不回退、不联动。重试成功则回到「已拆卸」。
 */
export const retryRecovery = createAsyncThunk(
  'ops/retryRecovery',
  async (payload: { id: string; result: RecoveryResult; note: string }, { rejectWithValue }) => {
    const now = Date.now();
    try {
      await db.transaction('rw', [db.installs], async () => {
        const install = await db.installs.get(payload.id);
        if (!install) throw new Error('安装登记不存在');
        if (install.state !== '回收失败' && install.recoveryResult !== '回收失败') {
          throw new Error('只有回收失败的记录可以重试回收');
        }
        const retryCount = (install.retryCount ?? 0) + 1;
        await db.installs.update(payload.id, {
          state: payload.result === '回收失败' ? '回收失败' : '已拆卸',
          recoveryResult: payload.result,
          retryCount,
          recoveryNote: payload.note.trim()
            ? `第 ${retryCount} 次：${payload.note.trim()}`
            : install.recoveryNote,
          updatedAt: now,
        } as never);
      });
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '回收重试失败');
    }
    return payload;
  }
);

/** 人工处理补号异常：补录出库单号并关联安装记录后解除异常标记 */
export const resolveMigrationIssue = createAsyncThunk(
  'ops/resolveMigrationIssue',
  async (payload: { issueId: string; outboundNo: string; note?: string }, { rejectWithValue }) => {
    const now = Date.now();
    try {
      await db.transaction('rw', [db.migrationIssues, db.outboundOrders, db.installs], async () => {
        const issue = await db.migrationIssues.get(payload.issueId);
        if (!issue) throw new Error('异常记录不存在');
        const order = await db.outboundOrders.where('orderNo').equals(payload.outboundNo.trim()).first();
        if (!order) throw new Error(`查无出库单号 ${payload.outboundNo}`);
        if (issue.serialNo && order.serialNo !== issue.serialNo) {
          throw new Error(`出库单序列号「${order.serialNo}」与异常记录序列号不一致`);
        }
        const install = issue.sourceInstrumentId
          ? await db.installs.get(`ist_legacy_${issue.sourceInstrumentId}`)
          : undefined;
        if (install) {
          await db.installs.update(install.id, {
            outboundId: order.id,
            outboundNo: order.orderNo,
            updatedAt: now,
          } as never);
        }
        await db.migrationIssues.update(issue.id, {
          resolved: true,
          reason: payload.note?.trim()
            ? `${issue.reason}；已人工补录：${payload.note.trim()}`
            : `${issue.reason}；已人工补单号 ${order.orderNo}`,
          updatedAt: now,
        } as never);
      });
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '补录失败');
    }
    return payload;
  }
);

const opsSlice = createSlice({
  name: 'ops',
  initialState,
  reducers: {
    setInstalls(state, action: PayloadAction<InstallRecord[]>) {
      state.installs = action.payload;
      state.ready = true;
      state.error = null;
    },
    setMigrationIssues(state, action: PayloadAction<MigrationIssue[]>) {
      state.issues = action.payload;
    },
    patchFilter(state, action: PayloadAction<Partial<InstallFilterState>>) {
      state.filter = { ...state.filter, ...action.payload };
    },
    resetFilter(state) {
      state.filter = createEmptyInstallFilter();
    },
    setOpsError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setOpsReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(receiveAndInstall.fulfilled, (state) => {
        state.lastReceipt = '领用安装完成：出库单已领用、序列号已出库，安装位登记已建立';
        state.error = null;
      })
      .addCase(registerInstall.fulfilled, (state, action) => {
        state.lastReceipt = action.payload.outboundNo
          ? '安装登记已建立，已关联出库单'
          : '安装登记已建立（无出库单号，将列入「装了又没出库」对账异常）';
      })
      .addCase(withdrawInstall.fulfilled, (state) => {
        state.lastReceipt = '台站侧已撤回领用；请通知装备库确认退库，之后序列号才会解锁放回在库';
      })
      .addCase(removeFromSlot.fulfilled, (state) => {
        state.lastReceipt = '拆卸登记完成，该序列号已从安装位摘除，不再计入超期名单';
      })
      .addCase(retryRecovery.fulfilled, (state, action) => {
        state.lastReceipt =
          action.payload.result === '回收失败'
            ? '本次回收仍失败，已登记（装备库出库单不动）'
            : '回收重试成功，旧机状态改为已拆卸（装备库出库单仍保留）';
      })
      .addMatcher(
        (action) =>
          action.type.endsWith('/rejected') &&
          typeof (action as unknown as { payload?: unknown }).payload === 'string',
        (state, action) => {
          state.error = (action as unknown as { payload: string }).payload;
        }
      );
  },
});

export const {
  setInstalls,
  setMigrationIssues,
  patchFilter,
  resetFilter,
  setOpsError,
  setOpsReceipt,
} = opsSlice.actions;

let started = false;

/** 启动台站两表实时订阅（幂等） */
export function startOpsSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<InstallRecord>(() => db.installs).subscribe((rows) => dispatch(setInstalls(rows)));
  watchTable<MigrationIssue>(() => db.migrationIssues).subscribe((rows) => dispatch(setMigrationIssues(rows)));
}

/* ------------------------------ Selector ------------------------------ */

export const selectOpsState = (state: WithOps): OpsSliceState => state.ops;
export const selectInstalls = (state: WithOps): InstallRecord[] => state.ops.installs;
export const selectMigrationIssues = (state: WithOps): MigrationIssue[] => state.ops.issues;
export const selectOpsReady = (state: WithOps): boolean => state.ops.ready;
export const selectOpsFilter = (state: WithOps): InstallFilterState => state.ops.filter;

/** 当前仍在安装位上的登记（超期名单的唯一数据源） */
export const selectActiveInstalls = (state: WithOps): InstallRecord[] =>
  state.ops.installs.filter((row) => row.state === '已安装' && !row.withdrawn);

/** 撤回领用、等装备库退库的登记 */
export const selectWithdrawnPendingReturn = (state: WithOps): InstallRecord[] =>
  state.ops.installs.filter((row) => row.withdrawn);

/** 回收失败待重试 */
export const selectRecoveryFailed = (state: WithOps): InstallRecord[] =>
  state.ops.installs.filter((row) => row.state === '回收失败' || row.recoveryResult === '回收失败');

export const selectInstallById = (state: WithOps, id: string | null | undefined): InstallRecord | null =>
  id ? state.ops.installs.find((row) => row.id === id) ?? null : null;

export default opsSlice.reducer;
