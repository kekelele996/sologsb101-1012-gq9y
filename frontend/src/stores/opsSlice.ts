/**
 * 台站运维 slice：安装位 + 安装登记 + 拆卸登记 + 旧机回收（账本二）。
 *
 * 边界：本侧绝不改库存数量。撤回领用按「先撤台站侧、再解锁库侧」在一个事务里编排：
 * 先确认台站侧没有在装记录（撤的是领用而不是拆机），再把库的出库单置「已撤回」并退库。
 * 旧机回收失败只重试本侧 removals，装备库出库单永不回退。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import type { InstallRecord, InstallSlotType, RemovalRecord, RecycleState } from '@/types/ops';
import type { RootState } from '@/stores/store';

type WithOps = RootState;

export interface OpsSliceState {
  installs: InstallRecord[];
  removals: RemovalRecord[];
  ready: boolean;
  error: string | null;
  lastReceipt: string;
}

const initialState: OpsSliceState = {
  installs: [],
  removals: [],
  ready: false,
  error: null,
  lastReceipt: '',
};

/** 登记安装：必须引用有效出库单，且实物序列号必须与锁定序列号一致（对不上直接拦截） */
export const registerInstall = createAsyncThunk(
  'ops/registerInstall',
  async (
    payload: {
      stationCode: string;
      slotCode: string;
      slotType: InstallSlotType;
      serialNo: string;
      model: string;
      installDate: string;
      outboundNo: string;
      operator: string;
      remark: string;
    },
    { rejectWithValue }
  ) => {
    const serialNo = payload.serialNo.trim();
    const outboundNo = payload.outboundNo.trim();
    const order = await db.outboundOrders.where('outboundNo').equals(outboundNo).first();
    if (!order) return rejectWithValue(`出库单 ${outboundNo} 不存在，不能登记安装`);
    if (order.state !== '待领用' && order.state !== '已领用') {
      return rejectWithValue(`出库单 ${outboundNo} 为「${order.state}」，不能再装机`);
    }
    if (order.serialNo !== serialNo) {
      return rejectWithValue(
        `序列号对不上：出库单 ${outboundNo} 锁定的是 ${order.serialNo}，实物扫码为 ${serialNo}。请核对是否拿错备件。`
      );
    }
    const activeDuplicate = await db.installs
      .where('serialNo')
      .equals(serialNo)
      .filter((row) => row.state === '已装机')
      .first();
    if (activeDuplicate) {
      return rejectWithValue(`序列号 ${serialNo} 已装在 ${activeDuplicate.stationCode}（${activeDuplicate.slotCode}），不能重复装机`);
    }

    const now = Date.now();
    const install: InstallRecord = {
      id: createId('ist'),
      stationCode: payload.stationCode.trim(),
      slotCode: payload.slotCode.trim(),
      slotType: payload.slotType,
      serialNo,
      model: payload.model.trim(),
      installDate: payload.installDate,
      outboundNo,
      outboundRef: 'new',
      state: '已装机',
      removalId: '',
      operator: payload.operator.trim(),
      remark: payload.remark.trim(),
      createdAt: now,
      updatedAt: now,
    };

    await db.transaction('rw', [db.installs, db.outboundOrders, db.spareParts], async () => {
      await db.installs.put(install);
      await db.outboundOrders.update(order.id, { state: '已装机', updatedAt: now } as never);
      const part = await db.spareParts.where('serialNo').equals(serialNo).first();
      if (part) await db.spareParts.update(part.id, { state: '已装机', updatedAt: now } as never);
    });
    return install;
  }
);

/**
 * 班组撤回领用（先撤台站侧，再让装备库解锁退库）：
 * - 先确认该序列号在台站侧没有「已装机」记录（领用了但没装，撤的才是领用）；
 * - 同一事务内：出库单 → 已撤回（保留），备件 → 在库（库存 +1、序列号解锁）。
 */
export const withdrawReceiveFromStation = createAsyncThunk(
  'ops/withdrawReceiveFromStation',
  async (
    payload: { orderId: string; returnOperator: string; closeReason: string },
    { rejectWithValue }
  ) => {
    const order = await db.outboundOrders.get(payload.orderId);
    if (!order) return rejectWithValue('出库单不存在');
    if (order.state !== '已领用') {
      return rejectWithValue(`只有「已领用」的单子能撤回退库，当前为「${order.state}」`);
    }
    const activeInstall = await db.installs
      .where('serialNo')
      .equals(order.serialNo)
      .filter((row) => row.state === '已装机')
      .first();
    if (activeInstall) {
      return rejectWithValue('该序列号已登记安装，不能按「撤回领用」处理，请走拆卸登记');
    }

    const now = Date.now();
    await db.transaction('rw', [db.installs, db.outboundOrders, db.spareParts], async () => {
      // 第一步：台站侧确认无在装（撤领用事实成立）；这里无需新增/改安装记录
      // 第二步：装备库据撤回退库解锁
      await db.outboundOrders.update(order.id, {
        state: '已撤回',
        closedAt: now,
        returnOperator: payload.returnOperator.trim(),
        closeReason: payload.closeReason.trim(),
        updatedAt: now,
      } as never);
      const part = await db.spareParts.where('serialNo').equals(order.serialNo).first();
      if (part) {
        await db.spareParts.update(part.id, {
          state: '在库',
          outboundNo: '',
          updatedAt: now,
        } as never);
      }
    });
    return payload;
  }
);

/** 登记拆卸：在装记录 → 已拆除（超期名单随即不再挂它），新建拆卸记录待回收。
 *  不动装备库出库单与库存（留着不回退）。 */
export const registerRemoval = createAsyncThunk(
  'ops/registerRemoval',
  async (
    payload: {
      installId: string;
      removeDate: string;
      reason: string;
      operator: string;
      remark: string;
    },
    { rejectWithValue }
  ) => {
    const install = await db.installs.get(payload.installId);
    if (!install) return rejectWithValue('安装记录不存在');
    if (install.state !== '已装机') return rejectWithValue('该设备已拆除，不能重复登记');

    const now = Date.now();
    const removal: RemovalRecord = {
      id: createId('rmv'),
      installId: install.id,
      stationCode: install.stationCode,
      slotCode: install.slotCode,
      serialNo: install.serialNo,
      removeDate: payload.removeDate,
      reason: payload.reason.trim(),
      recycle: '待回收',
      retryAt: null,
      retryCount: 0,
      lastError: '',
      operator: payload.operator.trim(),
      remark: payload.remark.trim(),
      createdAt: now,
      updatedAt: now,
    };

    await db.transaction('rw', [db.removals, db.installs], async () => {
      await db.removals.put(removal);
      await db.installs.update(install.id, {
        state: '已拆除',
        removalId: removal.id,
        updatedAt: now,
      } as never);
    });
    return removal;
  }
);

/**
 * 旧机回收重试：只改台站侧 removals。
 * 成功置「回收成功」；失败累计次数、刷新重试时间、记失败原因。装备库出库单不动。
 */
export const retryRecycle = createAsyncThunk(
  'ops/retryRecycle',
  async (
    payload: { removalId: string; result: RecycleState; error?: string },
    { rejectWithValue }
  ) => {
    const removal = await db.removals.get(payload.removalId);
    if (!removal) return rejectWithValue('拆卸记录不存在');
    if (removal.recycle === '回收成功') {
      return rejectWithValue('已回收成功，无需再重试');
    }
    const now = Date.now();
    await db.removals.update(removal.id, {
      recycle: payload.result,
      retryAt: now,
      retryCount: removal.retryCount + 1,
      lastError: payload.result === '回收失败' ? (payload.error ?? '').trim() : '',
      updatedAt: now,
    } as never);
    return payload;
  }
);

/** 人工补录历史安装的出库单号（处理对账页「补不出」的旧数据） */
export const resolveLegacyOutboundNo = createAsyncThunk(
  'ops/resolveLegacyOutboundNo',
  async (payload: { installId: string; outboundNo: string }, { rejectWithValue }) => {
    const install = await db.installs.get(payload.installId);
    if (!install) return rejectWithValue('安装记录不存在');
    const order = await db.outboundOrders
      .where('outboundNo')
      .equals(payload.outboundNo.trim())
      .first();
    if (!order) return rejectWithValue(`出库单 ${payload.outboundNo} 不存在`);
    await db.installs.update(install.id, {
      outboundNo: order.outboundNo,
      outboundRef: 'backfilled',
      updatedAt: Date.now(),
    } as never);
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
    setRemovals(state, action: PayloadAction<RemovalRecord[]>) {
      state.removals = action.payload;
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
      .addCase(registerInstall.fulfilled, (state) => {
        state.lastReceipt = '安装已登记：序列号与出库单核对一致，出库单闭环';
      })
      .addCase(withdrawReceiveFromStation.fulfilled, (state) => {
        state.lastReceipt = '已先撤台站侧领用、再由装备库退库解锁（原出库单保留）';
      })
      .addCase(registerRemoval.fulfilled, (state) => {
        state.lastReceipt = '拆卸已登记：该序列号即时移出超期名单，旧机进入回收跟踪（出库单不回退）';
      })
      .addCase(retryRecycle.fulfilled, (state) => {
        state.lastReceipt = '旧机回收状态已更新（仅台站侧）';
      })
      .addCase(resolveLegacyOutboundNo.fulfilled, (state) => {
        state.lastReceipt = '历史安装已补录出库单号';
      });
  },
});

export const { setInstalls, setRemovals, setOpsError, setOpsReceipt } = opsSlice.actions;

let started = false;

/** 启动台站运维两表实时订阅（幂等） */
export function startOpsSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<InstallRecord>(() => db.installs).subscribe((rows) => dispatch(setInstalls(rows)));
  watchTable<RemovalRecord>(() => db.removals).subscribe((rows) => dispatch(setRemovals(rows)));
}

/* ------------------------------ Selector ------------------------------ */

export const selectOpsState = (state: WithOps): OpsSliceState => state.ops;
export const selectInstalls = (state: WithOps): InstallRecord[] => state.ops.installs;
export const selectRemovals = (state: WithOps): RemovalRecord[] => state.ops.removals;
export const selectOpsReady = (state: WithOps): boolean => state.ops.ready;
export const selectOpsError = (state: WithOps): string | null => state.ops.error;

/** 当前在安装位上的设备（已装机未拆除）——超期名单只统计这批 */
export const selectActiveInstalls = (state: WithOps): InstallRecord[] =>
  state.ops.installs.filter((row) => row.state === '已装机');

/** 已拆卸未回收成功的记录 */
export const selectPendingRecycle = (state: WithOps): RemovalRecord[] =>
  state.ops.removals.filter((row) => row.recycle !== '回收成功');

export function recycleTone(recycle: RecycleState): string {
  switch (recycle) {
    case '回收成功':
      return 'green';
    case '回收失败':
      return 'red';
    default:
      return 'orange';
  }
}

export default opsSlice.reducer;
