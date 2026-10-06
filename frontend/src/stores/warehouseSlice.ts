/**
 * 装备库 slice：备件库存 + 出库单（装备库限界上下文）。
 *
 * 关键不变量：
 *  - 开单即锁：createOutboundOrder 成功后，备件 在库→锁定，序列号只能被这张单占用；
 *  - 序列号一经开单必须留痕：出库单不做物理删除、不设「作废」写动作；
 *  - 撤回领用的顺序闸门：班组先在台站侧撤回（withdrawn），装备库才能 returnOrder 解锁，
 *    本侧只读台站安装表作为校验，不写台站表；
 *  - 旧机回收失败不回退本侧任何单据（台站侧重试与本 slice 无关）。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import type { SparePart, SpareState } from '@/types/spare';
import {
  buildOrderNo,
  createEmptyOutboundFilter,
  type OutboundFilterState,
  type OutboundOrder,
  type OutboundState,
} from '@/types/outbound';
import type { RootState } from '@/stores/store';

type WithWarehouse = RootState;

export interface WarehouseSliceState {
  spares: SparePart[];
  orders: OutboundOrder[];
  ready: boolean;
  error: string | null;
  filter: OutboundFilterState;
  lastReceipt: string;
}

const initialState: WarehouseSliceState = {
  spares: [],
  orders: [],
  ready: false,
  error: null,
  filter: createEmptyOutboundFilter(),
  lastReceipt: '',
};

/** 备件序列号在装备库内唯一（在库/锁定/已出库都算占用） */
async function findSpareSerialConflict(serialNo: string, excludeId?: string): Promise<SparePart | undefined> {
  const rows = await db.spares.where('serialNo').equals(serialNo.trim()).toArray();
  return rows.find((row) => row.id !== excludeId);
}

/** 同日出库单号续号（事务内调用，避开重号） */
async function nextOrderNo(tx: typeof db, date: string): Promise<string> {
  const compact = date.replace(/-/g, '').slice(0, 8);
  const prefix = `CK-${compact}-`;
  const sameDay = await tx.outboundOrders.where('orderNo').startsWith(prefix).toArray();
  let seq = sameDay.length + 1;
  const used = new Set(sameDay.map((row) => row.orderNo));
  while (used.has(buildOrderNo(date, seq))) seq += 1;
  return buildOrderNo(date, seq);
}

/* ------------------------------ 备件 ------------------------------ */

export const addSpare = createAsyncThunk(
  'warehouse/addSpare',
  async (payload: Omit<SparePart, 'id' | 'createdAt' | 'updatedAt' | 'state' | 'outboundId'>, {
    rejectWithValue,
  }) => {
    const serialNo = payload.serialNo.trim();
    if (!serialNo) return rejectWithValue('序列号不能为空');
    const conflict = await findSpareSerialConflict(serialNo);
    if (conflict) return rejectWithValue(`序列号「${serialNo}」已在装备库登记（${conflict.state}）`);
    const now = Date.now();
    const row: SparePart = {
      ...payload,
      serialNo,
      state: '在库',
      outboundId: null,
      id: createId('spr'),
      createdAt: now,
      updatedAt: now,
    };
    await db.spares.put(row);
    return row;
  }
);

export const updateSpare = createAsyncThunk(
  'warehouse/updateSpare',
  async (payload: { id: string; patch: Partial<SparePart> }, { rejectWithValue }) => {
    if (payload.patch.serialNo) {
      const conflict = await findSpareSerialConflict(payload.patch.serialNo, payload.id);
      if (conflict) return rejectWithValue(`序列号「${payload.patch.serialNo}」已被占用`);
    }
    // 库存状态 / 单据占用只能走开单与退库流程，普通编辑改不到：从 patch 中剥离
    const { state: _ignoredState, outboundId: _ignoredOutbound, ...editable } = payload.patch;
    void _ignoredState;
    void _ignoredOutbound;
    await db.spares.update(payload.id, { ...editable, updatedAt: Date.now() });
    return payload;
  }
);

/** 仅允许删除从未被单据占用的在库备件 */
export const removeSpare = createAsyncThunk(
  'warehouse/removeSpare',
  async (id: string, { rejectWithValue }) => {
    const spare = await db.spares.get(id);
    if (!spare) return rejectWithValue('备件不存在');
    if (spare.state !== '在库' || spare.outboundId) {
      return rejectWithValue('备件已被出库单锁定或已出库，不能删除，只能按退库流程回库');
    }
    await db.spares.delete(id);
    return id;
  }
);

/* ------------------------------ 出库单 ------------------------------ */

export interface CreateOrderInput {
  /** 从哪台在库备件开单（装备库管库存，必须选备件而不是手填序列号） */
  spareId: string;
  stationCode: string;
  purpose: string;
  receiver: string;
  outboundDate: string;
  remark: string;
}

/** 开单：选一台在库备件 → 生成出库单（已开立），序列号锁定 */
export const createOutboundOrder = createAsyncThunk(
  'warehouse/createOutboundOrder',
  async (input: CreateOrderInput, { rejectWithValue }) => {
    const now = Date.now();
    const result = await db.transaction('rw', [db.spares, db.outboundOrders], async () => {
      const spare = await db.spares.get(input.spareId);
      if (!spare) throw new Error('备件不存在');
      if (spare.state !== '在库' || spare.outboundId) {
        throw new Error(`序列号「${spare.serialNo}」已锁定或已出库，不能重复开单`);
      }
      const stationCode = input.stationCode.trim();
      if (!stationCode) throw new Error('领用台站码不能为空');
      const outboundDate = input.outboundDate || new Date().toISOString().slice(0, 10);
      const orderId = createId('ob');
      const orderNo = await nextOrderNo(db, outboundDate);
      const order: OutboundOrder = {
        id: orderId,
        orderNo,
        serialNo: spare.serialNo,
        type: spare.type,
        model: spare.model,
        stationCode,
        purpose: input.purpose.trim(),
        receiver: input.receiver.trim(),
        outboundDate,
        state: '已开立',
        returnDate: null,
        returnReason: '',
        installId: null,
        remark: input.remark.trim(),
        createdAt: now,
        updatedAt: now,
      };
      await db.outboundOrders.put(order);
      await db.spares.update(spare.id, {
        state: '锁定' as SpareState,
        outboundId: orderId,
        updatedAt: now,
      });
      return order;
    }).catch((error: unknown) => {
      throw error instanceof Error ? error : new Error('开单失败');
    });
    if (result instanceof Error) return rejectWithValue(result.message);
    return result;
  }
);

/** 装备库确认领用：已开立 → 已领用（备件 锁定 → 已出库）。安装动作在台站侧另登记。 */
export const confirmReceive = createAsyncThunk(
  'warehouse/confirmReceive',
  async (orderId: string, { rejectWithValue }) => {
    const now = Date.now();
    try {
      await db.transaction('rw', [db.spares, db.outboundOrders], async () => {
        const order = await db.outboundOrders.get(orderId);
        if (!order) throw new Error('出库单不存在');
        if (order.state !== '已开立') throw new Error(`单据当前为「${order.state}」，不能确认领用`);
        const spare = await db.spares.where('serialNo').equals(order.serialNo).first();
        await db.outboundOrders.update(orderId, { state: '已领用' as OutboundState, updatedAt: now });
        if (spare) {
          await db.spares.update(spare.id, {
            state: '已出库' as SpareState,
            outboundId: orderId,
            updatedAt: now,
          });
        }
      });
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '确认领用失败');
    }
    return orderId;
  }
);

/** 修改在途单据的非状态字段（用途/领用人/备注），状态与序列号不可改 */
export const updateOrderInfo = createAsyncThunk(
  'warehouse/updateOrderInfo',
  async (payload: { id: string; patch: Partial<Pick<OutboundOrder, 'purpose' | 'receiver' | 'remark' | 'stationCode'>> }, {
    rejectWithValue,
  }) => {
    const order = await db.outboundOrders.get(payload.id);
    if (!order) return rejectWithValue('出库单不存在');
    if (order.state === '已退库') return rejectWithValue('已退库单据不能修改');
    await db.outboundOrders.update(payload.id, { ...payload.patch, updatedAt: Date.now() } as never);
    return payload;
  }
);

/**
 * 装备库确认退库（撤回领用闭环的第二步）：
 * 必须先由台站班组撤回领用（安装登记 withdrawn 或已拆卸），装备库才解锁：
 * 单据 已领用 → 已退库；备件 → 在库，outboundId 清空；单据保留不删除。
 */
export const returnOrder = createAsyncThunk(
  'warehouse/returnOrder',
  async (payload: { id: string; reason: string; returnDate?: string }, { rejectWithValue }) => {
    const now = Date.now();
    try {
      await db.transaction('rw', [db.spares, db.outboundOrders, db.installs], async () => {
        const order = await db.outboundOrders.get(payload.id);
        if (!order) throw new Error('出库单不存在');
        if (order.state !== '已领用' && order.state !== '已开立') {
          throw new Error(`单据当前为「${order.state}」，不能退库`);
        }
        if (order.installId) {
          const install = await db.installs.get(order.installId);
          if (install && install.state === '已安装' && !install.withdrawn) {
            throw new Error('台站尚未撤回领用（安装位仍在用），请先由班组撤回，装备库再解锁退库');
          }
        }
        const spare = await db.spares.where('serialNo').equals(order.serialNo).first();
        await db.outboundOrders.update(order.id, {
          state: '已退库' as OutboundState,
          returnDate: payload.returnDate ?? new Date().toISOString().slice(0, 10),
          returnReason: payload.reason.trim() || '班组撤回领用',
          installId: null,
          updatedAt: now,
        });
        if (spare) {
          await db.spares.update(spare.id, {
            state: '在库' as SpareState,
            outboundId: null,
            updatedAt: now,
          });
        }
      });
    } catch (error) {
      return rejectWithValue(error instanceof Error ? error.message : '退库失败');
    }
    return payload;
  }
);

const warehouseSlice = createSlice({
  name: 'warehouse',
  initialState,
  reducers: {
    setSpares(state, action: PayloadAction<SparePart[]>) {
      state.spares = action.payload;
      state.ready = true;
      state.error = null;
    },
    setOrders(state, action: PayloadAction<OutboundOrder[]>) {
      state.orders = action.payload;
    },
    patchFilter(state, action: PayloadAction<Partial<OutboundFilterState>>) {
      state.filter = { ...state.filter, ...action.payload };
    },
    resetFilter(state) {
      state.filter = createEmptyOutboundFilter();
    },
    setWarehouseError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(createOutboundOrder.fulfilled, (state, action) => {
        state.lastReceipt = `出库单 ${action.payload.orderNo} 已开立，序列号「${action.payload.serialNo}」已锁定`;
        state.error = null;
      })
      .addCase(createOutboundOrder.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '开单失败';
      })
      .addCase(confirmReceive.fulfilled, (state, action) => {
        const order = state.orders.find((row) => row.id === action.payload);
        state.lastReceipt = `出库单 ${order?.orderNo ?? ''} 已确认领用，备件出`;
      })
      .addCase(returnOrder.fulfilled, (state, action) => {
        const order = state.orders.find((row) => row.id === action.payload.id);
        state.lastReceipt = `出库单 ${order?.orderNo ?? ''} 已退库，序列号已解锁放回在库（单据保留）`;
      })
      .addCase(removeSpare.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '删除备件失败';
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

export const { setSpares, setOrders, patchFilter, resetFilter, setWarehouseError, setReceipt } =
  warehouseSlice.actions;

let started = false;

/** 启动装备库两表实时订阅（幂等） */
export function startWarehouseSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<SparePart>(() => db.spares).subscribe((rows) => dispatch(setSpares(rows)));
  watchTable<OutboundOrder>(() => db.outboundOrders).subscribe((rows) => dispatch(setOrders(rows)));
}

/* ------------------------------ Selector ------------------------------ */

export const selectWarehouseState = (state: WithWarehouse): WarehouseSliceState => state.warehouse;
export const selectSpares = (state: WithWarehouse): SparePart[] => state.warehouse.spares;
export const selectOutboundOrders = (state: WithWarehouse): OutboundOrder[] => state.warehouse.orders;
export const selectWarehouseReady = (state: WithWarehouse): boolean => state.warehouse.ready;
export const selectWarehouseFilter = (state: WithWarehouse): OutboundFilterState => state.warehouse.filter;

export const selectSpareById = (state: WithWarehouse, id: string | null | undefined): SparePart | null =>
  id ? state.warehouse.spares.find((row) => row.id === id) ?? null : null;

/** 可开单的备件：仅在库且无单据占用 */
export const selectAvailableSpares = (state: WithWarehouse): SparePart[] =>
  state.warehouse.spares.filter((row) => row.state === '在库' && row.outboundId === null);

/** 库存分状态计数 */
export const selectSpareStateCounts = (
  state: WithWarehouse
): { 在库: number; 锁定: number; 已出库: number } => {
  const counts = { 在库: 0, 锁定: 0, 已出库: 0 };
  state.warehouse.spares.forEach((row) => {
    counts[row.state] += 1;
  });
  return counts;
};

export default warehouseSlice.reducer;
