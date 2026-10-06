/**
 * Redux store：汇总台阵 / 仪器 / 标定 / 装备库 / 台站运维五个 slice。
 * 装备库（备件库存、出库单）与台站运维（安装位、拆卸、回收）是两本独立账，
 * 仅通过序列号与出库单号对账，不共享可写状态。
 * 跨页状态全部放在 slice 中，组件只读 selector 并 dispatch 异步动作落 IndexedDB。
 */
import { configureStore } from '@reduxjs/toolkit';
import { useDispatch, useSelector, type TypedUseSelectorHook } from 'react-redux';
import arrayReducer from '@/stores/arraySlice';
import instrumentReducer from '@/stores/instrumentSlice';
import calibrationReducer from '@/stores/calibrationSlice';
import warehouseReducer from '@/stores/warehouseSlice';
import opsReducer from '@/stores/opsSlice';

export const store = configureStore({
  reducer: {
    array: arrayReducer,
    instrument: instrumentReducer,
    calibration: calibrationReducer,
    warehouse: warehouseReducer,
    ops: opsReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      // IndexedDB 行对象是纯数据，但序列化检查在开发期仍有价值；这里保持默认并放宽时间戳阈值
      serializableCheck: {
        warnAfter: 128,
      },
    }),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

/** 类型化的 hooks，页面统一使用（禁止直接用未类型化的 useSelector） */
export const useAppDispatch = (): AppDispatch => useDispatch<AppDispatch>();
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;

export default store;
