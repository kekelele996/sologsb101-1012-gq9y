/* eslint-disable no-console */
/**
 * 端到端验证（fake-indexeddb）：
 * 1) v2 旧库 → v3 升级：按台站码 + 安装日期补单号，补不出单列
 * 2) 开单即锁序列号
 * 3) 撤回领用顺序闸门：未撤回不能退库；先撤回再退库才解锁
 * 4) 旧机回收失败只动台站侧，出库单保持已领用
 * 5) 序列号对账三类差异分类正确
 *
 * 运行：npx tsx scripts/verify-bounded-context.ts
 */
import 'fake-indexeddb/auto';
import Dexie from 'dexie';

const DB_NAME = 'gbseisarray';

async function deleteDb(name: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

function ok(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${msg}`);
  }
}

/** 场景 1：手工构造 v2 旧库，再用真实 db.ts 打开触发 v3 升级 */
async function scenarioMigration(): Promise<void> {
  await deleteDb(DB_NAME);

  const old = new Dexie(DB_NAME);
  old.version(2).stores({
    arrays: 'id, name, state, apertureKm, deployDate, department, updatedAt',
    stations: 'id, arrayId, code, lat, lng, elevM, bedrock, updatedAt',
    instruments: 'id, stationId, type, model, serialNo, installDate, state, updatedAt',
    calibrations: 'id, instrumentId, date, sensitivity, selfNoise, responseVerdict, updatedAt',
    replaces: 'id, instrumentId, state, date, newSerialNo, updatedAt',
  });
  await old.open();
  const now = Date.now();
  await old.table('arrays').put({
    id: 'a1', name: '旧台阵', apertureKm: 10, stationCount: 1, deployDate: '2020-01-01',
    state: '运行中', department: 'x', createdAt: now, updatedAt: now,
  });
  await old.table('stations').put({
    id: 's1', arrayId: 'a1', code: 'OLD01', lat: 30, lng: 103, elevM: 100,
    bedrock: '花岗岩', siteNote: '', createdAt: now, updatedAt: now,
  });
  await old.table('instruments').put({
    id: 'i1', stationId: 's1', type: '宽频带', model: 'STS-2.5', serialNo: 'SN-OK-001',
    installDate: '2021-05-01', state: '在用', remark: '', createdAt: now, updatedAt: now,
  });
  await old.table('instruments').put({
    id: 'i2', stationId: 's1', type: '短周期', model: 'FSS-3B', serialNo: 'SN-OLD-002',
    installDate: '2020-03-03', state: '已停用', remark: '雷击', createdAt: now, updatedAt: now,
  });
  await old.table('instruments').put({
    id: 'i3', stationId: 's1', type: '强震', model: 'ES-T', serialNo: 'SN-MISS-003',
    installDate: '', state: '在用', remark: '', createdAt: now, updatedAt: now,
  });
  await old.close();

  const { db } = await import('@/utils/db');
  await db.open();

  const orders = await db.outboundOrders.toArray();
  const installs = await db.installs.toArray();
  const issues = await db.migrationIssues.toArray();
  const spares = await db.spares.toArray();

  ok(orders.length === 2, `补出 2 张出库单（实际 ${orders.length}）`);
  const o1 = orders.find((row) => row.serialNo === 'SN-OK-001');
  ok(!!o1 && o1.orderNo === 'CK-BU-OLD01-20210501' && o1.state === '已领用', '按台站码+安装日期补单号，在用→已领用');
  const o2 = orders.find((row) => row.serialNo === 'SN-OLD-002');
  ok(!!o2 && o2.state === '已退库', '停用旧仪器对应单据补为已退库');

  const i3issue = issues.find((row) => row.sourceInstrumentId === 'i3');
  ok(!!i3issue && !i3issue.resolved, '缺安装日期的进补号异常清单');
  const i3install = installs.find((row) => row.serialNo === 'SN-MISS-003');
  ok(!!i3install && i3install.outboundNo === '' && i3install.outboundId === null, '补不出单号的安装登记留空不造假单');
  ok(issues.length === 1, `异常清单恰好 1 条（实际 ${issues.length}）`);
  ok(spares.filter((row) => row.serialNo === 'SN-MISS-003').length === 0, '补号失败的不造假库存出库记录');
  ok(spares.length === 2, `备件快照 2 条（实际 ${spares.length}）`);

  await db.close();
  await deleteDb(DB_NAME);
}

async function scenarioFlow(): Promise<void> {
  await deleteDb(DB_NAME);
  const { db } = await import('@/utils/db');
  await db.open();

  const { store } = await import('@/stores/store');
  const { createOutboundOrder, confirmReceive, returnOrder } = await import('@/stores/warehouseSlice');
  const {
    receiveAndInstall,
    withdrawInstall,
    removeFromSlot,
    retryRecovery,
    registerInstall,
  } = await import('@/stores/opsSlice');
  const { reconcileSerialFlow } = await import('@/utils/reconcile');

  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  await db.arrays.put({
    id: 'a1', name: '台阵', apertureKm: 1, stationCount: 1, deployDate: '2025-01-01',
    state: '运行中', department: 'x', createdAt: now, updatedAt: now,
  });
  await db.stations.put({
    id: 's1', arrayId: 'a1', code: 'ST01', lat: 30, lng: 103, elevM: 1,
    bedrock: '花岗岩', siteNote: '', createdAt: now, updatedAt: now,
  });
  await db.spares.bulkPut([
    { id: 'sp1', type: '宽频带', model: 'M1', serialNo: 'S-A', state: '在库', inboundDate: today, outboundId: null, remark: '', createdAt: now, updatedAt: now },
    { id: 'sp2', type: '强震', model: 'M2', serialNo: 'S-B', state: '在库', inboundDate: today, outboundId: null, remark: '', createdAt: now, updatedAt: now },
    { id: 'sp3', type: '宽频带', model: 'M3', serialNo: 'S-C', state: '在库', inboundDate: today, outboundId: null, remark: '', createdAt: now, updatedAt: now },
    { id: 'sp4', type: '短周期', model: 'M4', serialNo: 'S-D', state: '在库', inboundDate: today, outboundId: null, remark: '', createdAt: now, updatedAt: now },
  ]);

  const reconcile = () =>
    reconcileSerialFlow(
      // slice 订阅不会在脚本里跑；直接读表
      [] as never,
      [] as never,
      [] as never
    );
  const report = async () =>
    reconcileSerialFlow(
      await db.outboundOrders.toArray(),
      await db.installs.toArray(),
      await db.migrationIssues.toArray()
    );
  void reconcile;

  const created = (await store.dispatch(
    createOutboundOrder({ spareId: 'sp1', stationCode: 'ST01', purpose: '故障更换', receiver: '张三', outboundDate: today, remark: '' })
  )) as { meta: { requestStatus: string }; payload?: { id: string } };
  ok(created.meta.requestStatus === 'fulfilled', `开单成功（${created.meta.requestStatus}）`);
  const orderId = created.payload!.id;
  const spareA1 = await db.spares.get('sp1');
  ok(spareA1?.state === '锁定' && spareA1.outboundId === orderId, '开单即锁：备件→锁定且绑定单号');

  const dup = await store.dispatch(
    createOutboundOrder({ spareId: 'sp1', stationCode: 'ST01', purpose: 'x', receiver: 'x', outboundDate: today, remark: '' })
  );
  ok(dup.meta.requestStatus === 'rejected', '已锁定备件不能重复开单');

  // 另开一单并由装备库直接确认领用（班组还没装）→ 出了库没装上
  const cShip = await store.dispatch(
    createOutboundOrder({ spareId: 'sp4', stationCode: 'ST01', purpose: '备机', receiver: '钱七', outboundDate: today, remark: '' })
  );
  const shipOrderId = (cShip as { payload?: { id: string } }).payload!.id;
  await store.dispatch(confirmReceive(shipOrderId));
  ok((await db.outboundOrders.get(shipOrderId))?.state === '已领用', '确认领用后单据→已领用');
  let r = await report();
  ok(
    r.shippedNotInstalled.some((row) => row.order.id === shipOrderId),
    '对账：出了库没装上 被识别'
  );

  // 正常路径：班组凭已开立单直接「领用并安装」（单据 已开立→已领用）
  const installed = await store.dispatch(
    receiveAndInstall({ orderId, stationId: 's1', slot: 'A位', installDate: today, installer: '李四', remark: '' })
  );
  ok(installed.meta.requestStatus === 'fulfilled', '领用安装成功');
  const inst = (await db.installs.toArray()).find((row) => row.serialNo === 'S-A')!;
  ok(!!inst && inst.state === '已安装' && inst.outboundId === orderId, '安装登记建立且关联单号');
  r = await report();
  ok(r.matched.some((row) => row.order.id === orderId), '安装后该序列号对账一致');

  const blocked = await store.dispatch(returnOrder({ id: orderId, reason: '强行退库' }));
  ok(blocked.meta.requestStatus === 'rejected', '顺序闸门：班组未撤回时装备库不能退库解锁');
  ok((await db.spares.get('sp1'))?.state === '已出库', '闸门挡住后序列号仍为已出库');

  await store.dispatch(withdrawInstall({ id: inst.id, reason: '型号不匹配' }));
  const instAfter = await db.installs.get(inst.id);
  ok(instAfter?.withdrawn === true && instAfter.state === '已拆卸', '撤回领用只改台站侧（已拆卸+撤回标记）');
  ok((await db.outboundOrders.get(orderId))?.state === '已领用', '撤回后装备库出库单仍为已领用（未解锁）');
  ok((await db.spares.get('sp1'))?.state === '已出库', '撤回后备件仍已出库，等装备库确认');
  r = await report();
  ok(
    !r.shippedNotInstalled.some((row) => row.order.id === orderId),
    '撤回待退库属于流程中间态，不计入「出了库没装上」'
  );
  // 但仍未对得上（没在位、也没退库），matched 也不含它
  ok(!r.matched.some((row) => row.order.id === orderId), '撤回中的序列号不出现在已对得上清单');

  const returned = await store.dispatch(returnOrder({ id: orderId, reason: '型号不匹配，退回' }));
  ok(returned.meta.requestStatus === 'fulfilled', '撤回后装备库可退库');
  const orderReturned = await db.outboundOrders.get(orderId);
  const spareReturned = await db.spares.get('sp1');
  ok(orderReturned!.state === '已退库' && !!orderReturned!.returnDate, '单据→已退库留痕（不删除/不作废）');
  ok(spareReturned!.state === '在库' && spareReturned!.outboundId === null, '序列号解锁放回在库');

  const c2 = await store.dispatch(
    createOutboundOrder({ spareId: 'sp2', stationCode: 'ST01', purpose: '轮换', receiver: '王五', outboundDate: today, remark: '' })
  );
  const order2Id = (c2 as { payload?: { id: string } }).payload!.id;
  const r2 = await store.dispatch(
    receiveAndInstall({ orderId: order2Id, stationId: 's1', slot: 'B位', installDate: today, installer: '王五' })
  );
  ok(r2.meta.requestStatus === 'fulfilled', '第二台领用安装');
  const inst2 = (await db.installs.toArray()).find((row) => row.serialNo === 'S-B')!;
  await store.dispatch(removeFromSlot({
    id: inst2.id, removeDate: today, reason: '到期轮换', recoveryResult: '回收失败', note: '底座锈死',
  }));
  const inst2Fail = await db.installs.get(inst2.id);
  ok(inst2Fail?.state === '回收失败' && inst2Fail.retryCount === 1, '回收失败登记在台站侧');
  ok((await db.outboundOrders.get(order2Id))?.state === '已领用', '回收失败时出库单保持已领用不回退');

  await store.dispatch(retryRecovery({ id: inst2.id, result: '回收失败', note: '仍未拆成' }));
  const inst2Retry = await db.installs.get(inst2.id);
  ok(inst2Retry?.retryCount === 2 && inst2Retry.recoveryNote.includes('第 2 次'), '台站侧重试计数 + 备注追加');
  ok((await db.outboundOrders.get(order2Id))?.state === '已领用', '重试回收不影响装备库单据');

  await store.dispatch(retryRecovery({ id: inst2.id, result: '已回收', note: '已拆回' }));
  const inst2Ok = await db.installs.get(inst2.id);
  ok(inst2Ok?.state === '已拆卸' && inst2Ok.recoveryResult === '已回收', '重试成功回到已拆卸');
  ok((await db.outboundOrders.get(order2Id))?.state === '已领用', '即使回收成功，出库单依旧保留不回退');

  const noOrder = await store.dispatch(
    registerInstall({
      stationId: 's1', slot: 'C位', type: '宽频带', model: 'M3', serialNo: 'S-C',
      outboundNo: '', installDate: today, installer: '赵六', remark: '先装',
    })
  );
  ok(noOrder.meta.requestStatus === 'fulfilled', '无单号直接安装被允许');
  r = await report();
  ok(r.installedNotShipped.some((row) => row.install.serialNo === 'S-C'), '对账：装了又没出库 被识别');

  const bad = await store.dispatch(
    registerInstall({
      stationId: 's1', slot: 'X', type: '宽频带', model: 'M3', serialNo: 'S-X',
      outboundNo: orderReturned!.orderNo, installDate: today, installer: 'x', remark: '',
    })
  );
  ok(bad.meta.requestStatus === 'rejected', '安装登记时单号与序列号不一致被拒绝');

  await db.close();
  await deleteDb(DB_NAME);
}

async function main(): Promise<void> {
  console.log('== 场景 1：v2→v3 迁移补号 ==');
  await scenarioMigration();
  console.log('== 场景 2：开单锁定/撤回闸门/回收重试/对账 ==');
  await scenarioFlow();
  if (process.exitCode) console.error('\n存在失败断言');
  else console.log('\n全部断言通过');
  process.exit(process.exitCode ?? 0);
}

void main();
