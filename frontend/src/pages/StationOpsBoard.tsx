/**
 * 台站运维页（账本二）：安装位 + 安装登记 + 拆卸登记 + 旧机回收。
 * 安装必须扫序列号并与出库单锁定值核对；撤回领用先撤本侧再退库；
 * 旧机回收失败只重试本侧，装备库出库单不回退。
 */
import { useMemo, useState } from 'react';
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  PlusOutlined,
  RollbackOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import StatBadge from '@/components/common/StatBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import {
  selectActiveInstalls,
  selectInstalls,
  selectPendingRecycle,
  selectRemovals,
  registerInstall,
  registerRemoval,
  recycleTone,
  retryRecycle,
  withdrawReceiveFromStation,
} from '@/stores/opsSlice';
import { selectOutboundOrders } from '@/stores/warehouseSlice';
import { INSTALL_SLOT_TYPES, type InstallRecord, type InstallSlotType } from '@/types/ops';

interface InstallFormValues {
  outboundNo: string;
  serialNo: string;
  stationCode: string;
  slotCode: string;
  slotType: InstallSlotType;
  model: string;
  installDate: dayjs.Dayjs;
  operator: string;
  remark: string;
}

interface RemovalFormValues {
  removeDate: dayjs.Dayjs;
  reason: string;
  operator: string;
  remark: string;
}

export default function StationOpsBoard() {
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();
  const installs = useAppSelector(selectInstalls);
  const activeInstalls = useAppSelector(selectActiveInstalls);
  const removals = useAppSelector(selectRemovals);
  const pendingRecycle = useAppSelector(selectPendingRecycle);
  const orders = useAppSelector(selectOutboundOrders);

  const [installOpen, setInstallOpen] = useState(false);
  const [removalTarget, setRemovalTarget] = useState<InstallRecord | null>(null);
  const [activeTab, setActiveTab] = useState('installs');
  const [submitting, setSubmitting] = useState(false);
  const [installForm] = Form.useForm<InstallFormValues>();
  const [removalForm] = Form.useForm<RemovalFormValues>();

  /** 班组可撤回的单子：已领用、且该序列号在台站侧没有在装记录 */
  const withdrawableOrders = useMemo(() => {
    const activeSerials = new Set(activeInstalls.map((i) => i.serialNo));
    return orders.filter((o) => o.state === '已领用' && !activeSerials.has(o.serialNo));
  }, [orders, activeInstalls]);

  const receivableOrders = useMemo(
    () => orders.filter((o) => o.state === '待领用' || o.state === '已领用'),
    [orders]
  );

  const stats = useMemo(
    () => ({
      active: activeInstalls.length,
      removed: installs.length - activeInstalls.length,
      pendingRecycle: pendingRecycle.length,
      recycleFailed: removals.filter((r) => r.recycle === '回收失败').length,
      withdrawable: withdrawableOrders.length,
    }),
    [activeInstalls.length, installs.length, pendingRecycle.length, removals, withdrawableOrders.length]
  );

  const openInstall = () => {
    installForm.setFieldsValue({
      outboundNo: receivableOrders[0]?.outboundNo ?? '',
      serialNo: '',
      stationCode: '',
      slotCode: '',
      slotType: '宽频带',
      model: '',
      installDate: dayjs(),
      operator: '周渝',
      remark: '',
    });
    setInstallOpen(true);
  };

  /** 选中出库单时自动带出锁定序列号、台站、型号，序列号只读核对（防对不上） */
  const onPickOrder = (outboundNo: string) => {
    const order = orders.find((o) => o.outboundNo === outboundNo);
    if (order) {
      installForm.setFieldsValue({
        serialNo: order.serialNo,
        stationCode: order.stationCode,
        model: order.model,
      });
    }
  };

  const submitInstall = async () => {
    const values = await installForm.validateFields();
    setSubmitting(true);
    try {
      const res = await dispatch(
        registerInstall({
          outboundNo: values.outboundNo.trim(),
          serialNo: values.serialNo.trim(),
          stationCode: values.stationCode.trim().toUpperCase(),
          slotCode: values.slotCode.trim(),
          slotType: values.slotType,
          model: values.model.trim(),
          installDate: values.installDate.format('YYYY-MM-DD'),
          operator: values.operator.trim(),
          remark: values.remark?.trim() ?? '',
        })
      );
      if (res.meta.requestStatus === 'fulfilled') message.success('安装已登记，序列号与出库单一致');
      else message.error((res.payload as string) ?? '登记失败');
      if (res.meta.requestStatus === 'fulfilled') setInstallOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const openRemoval = (target: InstallRecord) => {
    setRemovalTarget(target);
    removalForm.setFieldsValue({ removeDate: dayjs(), reason: '', operator: target.operator || '周渝', remark: '' });
  };

  const submitRemoval = async () => {
    if (!removalTarget) return;
    const values = await removalForm.validateFields();
    setSubmitting(true);
    try {
      const res = await dispatch(
        registerRemoval({
          installId: removalTarget.id,
          removeDate: values.removeDate.format('YYYY-MM-DD'),
          reason: values.reason.trim(),
          operator: values.operator.trim(),
          remark: values.remark?.trim() ?? '',
        })
      );
      if (res.meta.requestStatus === 'fulfilled') message.success('拆卸已登记，已移出超期名单');
      else message.error((res.payload as string) ?? '登记失败');
      if (res.meta.requestStatus === 'fulfilled') setRemovalTarget(null);
    } finally {
      setSubmitting(false);
    }
  };

  const doWithdraw = async (orderId: string) => {
    const res = await dispatch(
      withdrawReceiveFromStation({
        orderId,
        returnOperator: '周渝',
        closeReason: '班组撤回领用，备件退回装备库',
      })
    );
    if (res.meta.requestStatus === 'fulfilled') message.success('已先撤领用、再退库解锁，原出库单保留');
    else message.error((res.payload as string) ?? '撤回失败');
  };

  const doRecycle = async (removalId: string, result: '回收成功' | '回收失败') => {
    const error = result === '回收失败' ? '交库失败：待台站侧重新安排回收' : '';
    const res = await dispatch(retryRecycle({ removalId, result, error }));
    if (res.meta.requestStatus === 'fulfilled') {
      message.success(result === '回收成功' ? '旧机已回收成功（仅台站侧更新，出库单不动）' : '已登记失败，可再次重试');
    } else message.error((res.payload as string) ?? '操作失败');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            台站运维 · 安装位与拆卸回收
          </Typography.Title>
          <p className="gb-hint">
            班组只管安装位、装机/拆卸与旧机回收；不写库存。安装按序列号与出库单核对，拆下即移出超期名单。
          </p>
        </div>
        <Space>
          <Button
            icon={<RollbackOutlined />}
            disabled={withdrawableOrders.length === 0}
            onClick={() => setActiveTab('withdraw')}
          >
            撤回领用（{withdrawableOrders.length}）
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openInstall}>
            登记安装
          </Button>
        </Space>
      </div>

      <div className="gb-stats-row">
        <StatBadge label="在装设备" value={stats.active} suffix="台" tone="primary" />
        <StatBadge label="已拆卸" value={stats.removed} suffix="台" tone="info" />
        <StatBadge label="待回收" value={stats.pendingRecycle} suffix="台" tone="warning" />
        <StatBadge label="回收失败" value={stats.recycleFailed} suffix="台" tone={stats.recycleFailed > 0 ? 'danger' : 'success'} />
        <StatBadge label="可撤回领用" value={stats.withdrawable} suffix="单" tone="warning" />
      </div>

      {stats.recycleFailed > 0 ? (
        <Alert
          type="error"
          showIcon
          icon={<CloseCircleOutlined />}
          message={`有 ${stats.recycleFailed} 台旧机回收失败，只在台站侧重试；装备库出库单保留不回退`}
        />
      ) : null}

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        defaultActiveKey="installs"
        items={[
          {
            key: 'installs',
            label: `安装位 / 安装登记（${installs.length}）`,
            children: installs.length === 0 ? (
              <EmptyPanel title="还没有安装登记" description="凭出库单扫码登记安装，序列号对不上会被拦截。" actionText="登记安装" onAction={openInstall} compact />
            ) : (
              <Table
                rowKey="id"
                size="small"
                className="gb-table-compact"
                dataSource={[...installs].sort((a, b) => b.installDate.localeCompare(a.installDate))}
                pagination={false}
                rowClassName={(row) => (row.state === '已拆除' ? 'gb-row-muted' : '')}
                columns={[
                  { title: '台站码', dataIndex: 'stationCode', width: 90, className: 'gb-mono' },
                  { title: '安装位', dataIndex: 'slotCode', width: 130, className: 'gb-mono' },
                  { title: '位类型', dataIndex: 'slotType', width: 90, render: (v: InstallSlotType) => <Tag>{v}</Tag> },
                  { title: '序列号', dataIndex: 'serialNo', className: 'gb-mono', width: 175 },
                  { title: '型号', dataIndex: 'model', width: 140 },
                  { title: '安装日期', dataIndex: 'installDate', width: 105, className: 'gb-mono' },
                  {
                    title: '出库单',
                    dataIndex: 'outboundNo',
                    width: 160,
                    className: 'gb-mono',
                    render: (no: string, row: InstallRecord) =>
                      no ? (
                        <span>
                          {no}
                          {row.outboundRef === 'backfilled' ? <Tag color="blue" style={{ marginInlineStart: 4 }}>升级回填</Tag> : null}
                        </span>
                      ) : (
                        <Tag color="red">无单号·待补</Tag>
                      ),
                  },
                  {
                    title: '状态',
                    dataIndex: 'state',
                    width: 80,
                    render: (state: InstallRecord['state']) => (
                      <Tag color={state === '已装机' ? 'green' : 'default'}>{state}</Tag>
                    ),
                  },
                  {
                    title: '操作',
                    width: 110,
                    render: (_: unknown, row: InstallRecord) =>
                      row.state === '已装机' ? (
                        <Button size="small" danger onClick={() => openRemoval(row)}>
                          登记拆卸
                        </Button>
                      ) : (
                        <span className="gb-hint">已拆</span>
                      ),
                  },
                ]}
              />
            ),
          },
          {
            key: 'removals',
            label: `拆卸与旧机回收（${removals.length}）`,
            children: removals.length === 0 ? (
              <EmptyPanel title="还没有拆卸记录" description="对在装设备登记拆卸后，旧机进入回收跟踪，可多次重试。" compact />
            ) : (
              <Table
                rowKey="id"
                size="small"
                className="gb-table-compact"
                dataSource={[...removals].sort((a, b) => b.removeDate.localeCompare(a.removeDate))}
                pagination={false}
                columns={[
                  { title: '台站码', dataIndex: 'stationCode', width: 90, className: 'gb-mono' },
                  { title: '安装位', dataIndex: 'slotCode', width: 130, className: 'gb-mono' },
                  { title: '旧机序列号', dataIndex: 'serialNo', className: 'gb-mono', width: 175 },
                  { title: '拆卸日期', dataIndex: 'removeDate', width: 105, className: 'gb-mono' },
                  { title: '原因', dataIndex: 'reason', ellipsis: true },
                  {
                    title: '回收结果',
                    dataIndex: 'recycle',
                    width: 110,
                    render: (recycle: InstallRecord['state'] & string) => (
                      <Tag color={recycleTone(recycle as never)}>{recycle}</Tag>
                    ),
                  },
                  {
                    title: '重试',
                    dataIndex: 'retryCount',
                    width: 70,
                    className: 'gb-mono',
                    render: (n: number) => `${n} 次`,
                  },
                  { title: '最近失败原因', dataIndex: 'lastError', ellipsis: true, render: (v: string) => v || <span className="gb-hint">—</span> },
                  {
                    title: '操作（仅台站侧）',
                    width: 190,
                    render: (_: unknown, row) =>
                      row.recycle === '回收成功' ? (
                        <Tag icon={<CheckCircleOutlined />} color="green">已闭环</Tag>
                      ) : (
                        <Space size={6}>
                          <Button size="small" type="primary" onClick={() => void doRecycle(row.id, '回收成功')}>
                            回收成功
                          </Button>
                          <Button size="small" danger icon={<CloseCircleOutlined />} onClick={() => void doRecycle(row.id, '回收失败')}>
                            记失败
                          </Button>
                        </Space>
                      ),
                  },
                ]}
              />
            ),
          },
          {
            key: 'withdraw',
            label: `撤回领用退库（${withdrawableOrders.length}）`,
            children: withdrawableOrders.length === 0 ? (
              <EmptyPanel title="没有可撤回的领用" description="只有「已领用但尚未装机」的出库单可由班组撤回，撤回后装备库退库解锁。" compact />
            ) : (
              <Table
                rowKey="id"
                size="small"
                className="gb-table-compact"
                dataSource={withdrawableOrders}
                pagination={false}
                columns={[
                  { title: '出库单号', dataIndex: 'outboundNo', className: 'gb-mono', width: 165 },
                  { title: '序列号', dataIndex: 'serialNo', className: 'gb-mono', width: 175 },
                  { title: '台站码', dataIndex: 'stationCode', width: 90, className: 'gb-mono' },
                  { title: '用途', dataIndex: 'purpose', ellipsis: true },
                  { title: '领用人', dataIndex: 'receiver', width: 80 },
                  {
                    title: '操作（先撤领用→退库解锁）',
                    width: 150,
                    render: (_: unknown, row) => (
                      <Popconfirm
                        title="撤回领用并退库"
                        description="先撤台站侧领用，再由装备库退库解锁，原出库单保留为「已撤回」。确认？"
                        okText="撤回退库"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => void doWithdraw(row.id)}
                      >
                        <Button size="small" danger icon={<RollbackOutlined />}>
                          撤回领用
                        </Button>
                      </Popconfirm>
                    ),
                  },
                ]}
              />
            ),
          },
        ]}
      />

      <Card className="gb-panel" size="small" title="规则说明">
        <ul className="gb-hint" style={{ margin: 0, paddingInlineStart: 18 }}>
          <li>安装登记必须引用有效出库单，实物序列号与单据锁定值不符时直接拦截，防止「换上去序列号对不上」。</li>
          <li>登记拆卸后该序列号立即移出超期名单，不再挂已拆下的那台；旧机回收只在本页重试。</li>
          <li>撤回领用先撤台站侧（确认未装机），同一事务内由装备库退库、解锁序列号，原单保留。</li>
        </ul>
      </Card>

      <Modal open={installOpen} title="登记安装（扫序列号与出库单核对）" onCancel={() => setInstallOpen(false)} onOk={() => void submitInstall()} confirmLoading={submitting} okText="登记安装" width={640} destroyOnClose>
        <Form form={installForm} layout="vertical" preserve={false}>
          <Form.Item name="outboundNo" label="出库单号" rules={[{ required: true, message: '请选择出库单' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="选择待领用/已领用的出库单"
              onChange={onPickOrder}
              options={receivableOrders.map((o) => ({
                label: `${o.outboundNo} · ${o.serialNo} → ${o.stationCode}（${o.state}）`,
                value: o.outboundNo,
              }))}
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="serialNo" label="实物序列号（须与锁定值一致）" rules={[{ required: true, message: '请填/核对序列号' }]}>
                <Input className="gb-mono" maxLength={60} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="model" label="型号" rules={[{ required: true }]}>
                <Input maxLength={40} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="stationCode" label="台站码" rules={[{ required: true }]}>
                <Input maxLength={12} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="slotCode" label="安装位编号" rules={[{ required: true, message: '请填安装位' }]}>
                <Input maxLength={20} placeholder="如 BB-主井" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="slotType" label="安装位类型" rules={[{ required: true }]}>
                <Select options={INSTALL_SLOT_TYPES.map((t) => ({ label: t, value: t }))} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="installDate" label="安装日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="operator" label="安装人" rules={[{ required: true }]}>
                <Input maxLength={20} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注">
            <Input maxLength={100} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal open={removalTarget !== null} title={`登记拆卸 · ${removalTarget?.stationCode} ${removalTarget?.slotCode}`} onCancel={() => setRemovalTarget(null)} onOk={() => void submitRemoval()} confirmLoading={submitting} okText="确认拆卸" destroyOnClose>
        <Alert style={{ marginBottom: 12 }} type="info" showIcon message={`拆下序列号 ${removalTarget?.serialNo}，拆卸后移出超期名单；旧机进入回收，出库单不回退。`} />
        <Form form={removalForm} layout="vertical" preserve={false}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="removeDate" label="拆卸日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="operator" label="操作人" rules={[{ required: true }]}>
                <Input maxLength={20} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="reason" label="拆卸原因" rules={[{ required: true, message: '请填拆卸原因' }]}>
            <Input maxLength={80} placeholder="如 雷击损坏 / 自噪超标 / 超期轮换" />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input maxLength={100} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
