/**
 * 装备库 slice：备件库存 + 出库单（账本一）。
 *
 * 不变量：
 * - 开单：选「在库/已退库」序列号，出库单置「待领用」并把备件置「已锁定」（开单即锁）。
 * - 领用确认：单 → 已领用，备件 → 已出库（库存 -1）。
 * - 撤回领用：只能对「已领用」单，由班组侧触发；本侧收到后单 → 已撤回，
 *   备件回「在库」（库存 +1、解锁）。原单保留不删除。
 * - 库管作废：只能对「待领用」单；单 → 已作废，备件回「在库」。
 * - 安装回传：单 → 已装机，备件 → 已装机。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import type { OutboundOrder, SparePart, SparePartType } from '@/types/spare';
import { canVoidOrder, canWithdrawReceive, formatOutboundNo } from '@/types/spare';
import type { RootState } from '@/stores/store';

type WithWarehouse = RootState;

export interface WarehouseSliceState {
  parts: SparePart[];
  orders: OutboundOrder[];
  ready: boolean;
  error: string | null;
  lastReceipt: string;
}

const initialState: WarehouseSliceState = {
  parts: [],
  orders: [],
  ready: false,
  error: null,
  lastReceipt: '',
};

/** 新增备件入库（一台件一条，序列号全库唯一） */
export const createSparePart = createAsyncThunk(
  'warehouse/createSparePart',
  async (
    payload: Omit<SparePart, 'id' | 'state' | 'outboundNo' | 'createdAt' | 'updatedAt'>,
    { rejectWithValue }
  ) => {
    const serialNo = payload.serialNo.trim();
    const existing = await db.spareParts.where('serialNo').equals(serialNo).first();
    if (existing) return rejectWithValue(`序列号 ${serialNo} 已在备件库登记，不能重复入库`);
    const now = Date.now();
    const row: SparePart = {
      ...payload,
      serialNo,
      id: createId('prt'),
      state: '在库',
      outboundNo: '',
      createdAt: now,
      updatedAt: now,
    };
    await db.spareParts.put(row);
    return row;
  }
);

/** 开出库单：序列号随即锁定（待领用态库管可作废） */
export const createOutboundOrder = createAsyncThunk(
  'warehouse/createOutboundOrder',
  async (
    payload: {
      serialNo: string;
      stationCode: string;
      purpose: string;
      keeper: string;
      outboundDate: string;
      remark: string;
    },
    { rejectWithValue }
  ) => {
    const serialNo = payload.serialNo.trim();
    const part = await db.spareParts.where('serialNo').equals(serialNo).first();
    if (!part) return rejectWithValue(`序列号 ${serialNo} 不在备件库，无法出库`);
    if (part.state !== '在库' && part.state !== '已退库') {
      return rejectWithValue(`序列号 ${serialNo} 当前为「${part.state}」，不可开单（已锁定/出库）`);
    }
    const now = Date.now();
    const sameDay = await db.outboundOrders
      .where('outboundDate')
      .equals(payload.outboundDate)
      .count();
    const outboundNo = formatOutboundNo(payload.outboundDate, sameDay + 1);
    const duplicateNo = await db.outboundOrders.where('outboundNo').equals(outboundNo).first();
    const finalNo = duplicateNo
      ? formatOutboundNo(payload.outboundDate, sameDay + Math.floor(Math.random() * 900) + 10)
      : outboundNo;

    const order: OutboundOrder = {
      id: createId('ob'),
      outboundNo: finalNo,
      serialNo: part.serialNo,
      type: part.type,
      model: part.model,
      stationCode: payload.stationCode.trim(),
      purpose: payload.purpose.trim(),
      keeper: payload.keeper.trim(),
      receiver: '',
      outboundDate: payload.outboundDate,
      state: '待领用',
      closedAt: null,
      returnOperator: '',
      closeReason: '',
      remark: payload.remark.trim(),
      createdAt: now,
      updatedAt: now,
    };

    await db.transaction('rw', [db.outboundOrders, db.spareParts], async () => {
      await db.outboundOrders.put(order);
      await db.spareParts.update(part.id, {
        state: '已锁定',
        outboundNo: finalNo,
        updatedAt: now,
      } as never);
    });
    return order;
  }
);

/** 班组确认领用：待领用 → 已领用，备件 已锁定 → 已出库 */
export const confirmReceive = createAsyncThunk(
  'warehouse/confirmReceive',
  async (payload: { id: string; receiver: string }, { rejectWithValue }) => {
    const order = await db.outboundOrders.get(payload.id);
    if (!order) return rejectWithValue('出库单不存在');
    if (order.state !== '待领用') {
      return rejectWithValue(`单据为「${order.state}」，不能确认领用`);
    }
    const now = Date.now();
    await db.transaction('rw', [db.outboundOrders, db.spareParts], async () => {
      await db.outboundOrders.update(order.id, {
        state: '已领用',
        receiver: payload.receiver.trim() || order.receiver,
        updatedAt: now,
      } as never);
      const part = await db.spareParts.where('serialNo').equals(order.serialNo).first();
      if (part) {
        await db.spareParts.update(part.id, { state: '已出库', updatedAt: now } as never);
      }
    });
    return payload;
  }
);

/**
 * 撤回领用（班组先撤回 → 装备库据撤回退库解锁）：
 * 仅「已领用」可撤回；单据置「已撤回」保留，备件回「在库」（库存 +1、序列号解锁）。
 */
export const withdrawReceive = createAsyncThunk(
  'warehouse/withdrawReceive',
  async (
    payload: { id: string; returnOperator: string; closeReason: string },
    { rejectWithValue }
  ) => {
    const order = await db.outboundOrders.get(payload.id);
    if (!order) return rejectWithValue('出库单不存在');
    if (!canWithdrawReceive(order.state)) {
      return rejectWithValue(`只有「已领用」的单据能撤回退库，当前为「${order.state}」`);
    }
    const now = Date.now();
    await db.transaction('rw', [db.outboundOrders, db.spareParts], async () => {
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

/** 库管作废：仅「待领用」（开错单、还没人领）可作废，备件回在库 */
export const voidOutboundOrder = createAsyncThunk(
  'warehouse/voidOutboundOrder',
  async (payload: { id: string; closeReason: string }, { rejectWithValue }) => {
    const order = await db.outboundOrders.get(payload.id);
    if (!order) return rejectWithValue('出库单不存在');
    if (!canVoidOrder(order.state)) {
      return rejectWithValue(
        order.state === '已领用'
          ? '该单已被领用，不能作废，请由班组走「撤回领用退库」'
          : `单据为「${order.state}」，不能作废`
      );
    }
    const now = Date.now();
    await db.transaction('rw', [db.outboundOrders, db.spareParts], async () => {
      await db.outboundOrders.update(order.id, {
        state: '已作废',
        closedAt: now,
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

/** 台站安装回传后，把有效出库单推进到「已装机」、备件置「已装机」 */
export const markOrderInstalled = createAsyncThunk(
  'warehouse/markOrderInstalled',
  async (payload: { outboundNo: string; serialNo: string }, { rejectWithValue }) => {
    if (!payload.outboundNo) return rejectWithValue('缺少出库单号');
    const order = await db.outboundOrders.where('outboundNo').equals(payload.outboundNo).first();
    if (!order) return rejectWithValue(`出库单 ${payload.outboundNo} 不存在`);
    if (order.serialNo !== payload.serialNo) {
      return rejectWithValue(
        `序列号不符：出库单 ${payload.outboundNo} 锁的是 ${order.serialNo}，台站报装的是 ${payload.serialNo}`
      );
    }
    if (order.state !== '已领用' && order.state !== '待领用') {
      return rejectWithValue(`单据为「${order.state}」，不能回传装机`);
    }
    const now = Date.now();
    await db.transaction('rw', [db.outboundOrders, db.spareParts], async () => {
      await db.outboundOrders.update(order.id, { state: '已装机', updatedAt: now } as never);
      const part = await db.spareParts.where('serialNo').equals(order.serialNo).first();
      if (part) {
        await db.spareParts.update(part.id, { state: '已装机', updatedAt: now } as never);
      }
    });
    return payload;
  }
);

/** 删除备件（仅在库且无单据关联） */
export const removeSparePart = createAsyncThunk(
  'warehouse/removeSparePart',
  async (id: string, { rejectWithValue }) => {
    const part = await db.spareParts.get(id);
    if (!part) return rejectWithValue('备件不存在');
    if (part.state !== '在库' && part.state !== '已退库') {
      return rejectWithValue(`「${part.state}」状态的备件不能删除`);
    }
    await db.spareParts.delete(id);
    return id;
  }
);

const warehouseSlice = createSlice({
  name: 'warehouse',
  initialState,
  reducers: {
    setSpareParts(state, action: PayloadAction<SparePart[]>) {
      state.parts = action.payload;
      state.ready = true;
      state.error = null;
    },
    setOutboundOrders(state, action: PayloadAction<OutboundOrder[]>) {
      state.orders = action.payload;
    },
    setWarehouseError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setWarehouseReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(createOutboundOrder.fulfilled, (state, action) => {
        state.lastReceipt = `出库单 ${action.payload.outboundNo} 已开，序列号 ${action.payload.serialNo} 已锁定`;
      })
      .addCase(confirmReceive.fulfilled, (state) => {
        state.lastReceipt = '领用已确认，备件出库（库存 -1）';
      })
      .addCase(withdrawReceive.fulfilled, (state) => {
        state.lastReceipt = '撤回领用成功：原出库单保留为「已撤回」，备件退库（库存 +1、序列号解锁）';
      })
      .addCase(voidOutboundOrder.fulfilled, (state) => {
        state.lastReceipt = '出库单已作废，序列号已解锁回库';
      })
      .addCase(markOrderInstalled.fulfilled, (state) => {
        state.lastReceipt = '台站装机回传成功，出库单闭环为「已装机」';
      });
  },
});

export const { setSpareParts, setOutboundOrders, setWarehouseError, setWarehouseReceipt } =
  warehouseSlice.actions;

let started = false;

/** 启动装备库两表实时订阅（幂等） */
export function startWarehouseSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<SparePart>(() => db.spareParts).subscribe((rows) => dispatch(setSpareParts(rows)));
  watchTable<OutboundOrder>(() => db.outboundOrders).subscribe((rows) =>
    dispatch(setOutboundOrders(rows))
  );
}

/* ------------------------------ Selector ------------------------------ */

export const selectWarehouseState = (state: WithWarehouse): WarehouseSliceState => state.warehouse;
export const selectSpareParts = (state: WithWarehouse): SparePart[] => state.warehouse.parts;
export const selectOutboundOrders = (state: WithWarehouse): OutboundOrder[] => state.warehouse.orders;
export const selectWarehouseReady = (state: WithWarehouse): boolean => state.warehouse.ready;
export const selectWarehouseError = (state: WithWarehouse): string | null => state.warehouse.error;
export const selectWarehouseReceipt = (state: WithWarehouse): string => state.warehouse.lastReceipt;

/** 可开单的备件（序列号未锁定） */
export const selectAvailableParts = (state: WithWarehouse): SparePart[] =>
  state.warehouse.parts.filter((part) => part.state === '在库' || part.state === '已退库');

export function spareStateTone(state: SparePart['state']): string {
  switch (state) {
    case '在库':
    case '已退库':
      return 'green';
    case '已锁定':
      return 'orange';
    case '已出库':
      return 'blue';
    case '已装机':
      return 'purple';
    default:
      return 'default';
  }
}

export function outboundStateTone(state: OutboundOrder['state']): string {
  switch (state) {
    case '待领用':
      return 'orange';
    case '已领用':
      return 'blue';
    case '已装机':
      return 'green';
    case '已作废':
      return 'default';
    case '已撤回':
      return 'gold';
    default:
      return 'default';
  }
}

export type { SparePartType };

export default warehouseSlice.reducer;
