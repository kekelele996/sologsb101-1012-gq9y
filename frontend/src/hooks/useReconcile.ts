/**
 * useReconcile：装备库出库单 × 台站安装登记的序列号对账。
 * 输出「出了库没装上」「装了没出库」「旧数据补号异常」三类单列结果。
 */
import { useMemo } from 'react';
import { useSelector } from 'react-redux';
import { selectOutboundOrders } from '@/stores/warehouseSlice';
import { selectInstalls, selectMigrationIssues } from '@/stores/opsSlice';
import { reconcileSerialFlow, type ReconcileReport } from '@/utils/reconcile';

export function useReconcile(): ReconcileReport {
  const orders = useSelector(selectOutboundOrders);
  const installs = useSelector(selectInstalls);
  const issues = useSelector(selectMigrationIssues);

  return useMemo(() => reconcileSerialFlow(orders, installs, issues), [orders, installs, issues]);
}
