/**
 * 装备库页（账本一）：备件库存 + 出库单。
 * 开单即锁序列号；待领用可由库管作废；已领用只能由班组在「台站运维」撤回退库。
 */
import { useMemo, useState } from 'react';
import {
  App as AntdApp,
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
  Tag,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  LockOutlined,
  PlusOutlined,
  RollbackOutlined,
  StopOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import StatBadge from '@/components/common/StatBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import {
  confirmReceive,
  createOutboundOrder,
  createSparePart,
  outboundStateTone,
  removeSparePart,
  selectOutboundOrders,
  selectSpareParts,
  spareStateTone,
  voidOutboundOrder,
} from '@/stores/warehouseSlice';
import { SPARE_PART_TYPES, type SparePart, type SparePartType } from '@/types/spare';

interface PartFormValues {
  type: SparePartType;
  model: string;
  serialNo: string;
  inboundDate: dayjs.Dayjs;
  location: string;
  remark: string;
}

interface OrderFormValues {
  serialNo: string;
  stationCode: string;
  purpose: string;
  keeper: string;
  outboundDate: dayjs.Dayjs;
  remark: string;
}

export default function WarehouseBoard() {
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();
  const parts = useAppSelector(selectSpareParts);
  const orders = useAppSelector(selectOutboundOrders);

  const [partOpen, setPartOpen] = useState(false);
  const [orderOpen, setOrderOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [partForm] = Form.useForm<PartFormValues>();
  const [orderForm] = Form.useForm<OrderFormValues>();

  const stats = useMemo(() => {
    const inStock = parts.filter((p) => p.state === '在库' || p.state === '已退库').length;
    const locked = parts.filter((p) => p.state === '已锁定').length;
    const out = parts.filter((p) => p.state === '已出库').length;
    const installed = parts.filter((p) => p.state === '已装机').length;
    const pending = orders.filter((o) => o.state === '待领用').length;
    const withdrawn = orders.filter((o) => o.state === '已撤回').length;
    const voided = orders.filter((o) => o.state === '已作废').length;
    return { inStock, locked, out, installed, pending, withdrawn, voided };
  }, [parts, orders]);

  const availableParts = useMemo(
    () => parts.filter((p) => p.state === '在库' || p.state === '已退库'),
    [parts]
  );

  const openPart = () => {
    partForm.setFieldsValue({
      type: '宽频带',
      model: '',
      serialNo: '',
      inboundDate: dayjs(),
      location: '',
      remark: '',
    });
    setPartOpen(true);
  };

  const openOrder = (serialNo?: string) => {
    orderForm.setFieldsValue({
      serialNo: serialNo ?? availableParts[0]?.serialNo ?? '',
      stationCode: '',
      purpose: '',
      keeper: '赵敏',
      outboundDate: dayjs(),
      remark: '',
    });
    setOrderOpen(true);
  };

  const submitPart = async () => {
    const values = await partForm.validateFields();
    setSubmitting(true);
    try {
      const res = await dispatch(
        createSparePart({
          type: values.type,
          model: values.model.trim(),
          serialNo: values.serialNo.trim(),
          inboundDate: values.inboundDate.format('YYYY-MM-DD'),
          location: values.location.trim(),
          remark: values.remark?.trim() ?? '',
        })
      );
      if (res.meta.requestStatus === 'fulfilled') message.success('备件已入库');
      else message.error((res.payload as string) ?? '入库失败');
      if (res.meta.requestStatus === 'fulfilled') setPartOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const submitOrder = async () => {
    const values = await orderForm.validateFields();
    setSubmitting(true);
    try {
      const res = await dispatch(
        createOutboundOrder({
          serialNo: values.serialNo,
          stationCode: values.stationCode.trim().toUpperCase(),
          purpose: values.purpose.trim(),
          keeper: values.keeper.trim(),
          outboundDate: values.outboundDate.format('YYYY-MM-DD'),
          remark: values.remark?.trim() ?? '',
        })
      );
      if (res.meta.requestStatus === 'fulfilled') message.success('出库单已开，序列号已锁定');
      else message.error((res.payload as string) ?? '开单失败');
      if (res.meta.requestStatus === 'fulfilled') setOrderOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const guard = async (
    thunk: Promise<{ meta: { requestStatus: 'fulfilled' | 'rejected' }; payload?: unknown }>,
    ok: string
  ) => {
    const res = await thunk;
    if (res.meta.requestStatus === 'fulfilled') message.success(ok);
    else message.error((res.payload as string) ?? '操作失败');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            装备库 · 备件库存与出库单
          </Typography.Title>
          <p className="gb-hint">
            库只管库存与单据：出库单开好即锁定序列号；待领用可作废，已领用须由班组在「台站运维」撤回退库。
          </p>
        </div>
        <Space>
          <Button icon={<PlusOutlined />} onClick={openPart}>
            备件入库
          </Button>
          <Button type="primary" icon={<LockOutlined />} onClick={() => openOrder()} disabled={availableParts.length === 0}>
            开出库单
          </Button>
        </Space>
      </div>

      <div className="gb-stats-row">
        <StatBadge label="在库可用" value={stats.inStock} suffix="件" tone="success" />
        <StatBadge label="锁定待领" value={stats.locked} suffix="件" tone="warning" />
        <StatBadge label="已出库待装" value={stats.out} suffix="件" tone="info" />
        <StatBadge label="已装机" value={stats.installed} suffix="件" tone="primary" />
        <StatBadge label="撤回退库单" value={stats.withdrawn} suffix="张" tone="info" />
        <StatBadge label="作废单" value={stats.voided} suffix="张" tone="success" />
      </div>

      <Card className="gb-panel" size="small" title={`备件库存（${parts.length} 件，序列号即实物身份）`}>
        {parts.length === 0 ? (
          <EmptyPanel title="备件库为空" description="先把备件按序列号入库，一台件一条库存记录。" actionText="备件入库" onAction={openPart} compact />
        ) : (
          <Table
            rowKey="id"
            size="small"
            className="gb-table-compact"
            dataSource={parts}
            pagination={{ pageSize: 8, showSizeChanger: false }}
            columns={[
              { title: '序列号', dataIndex: 'serialNo', className: 'gb-mono', width: 190 },
              { title: '型号', dataIndex: 'model', width: 150 },
              { title: '类型', dataIndex: 'type', width: 90, render: (v: SparePartType) => <Tag>{v}</Tag> },
              { title: '库位', dataIndex: 'location', width: 90, className: 'gb-mono' },
              { title: '入库日期', dataIndex: 'inboundDate', width: 110, className: 'gb-mono' },
              {
                title: '库存状态',
                dataIndex: 'state',
                width: 100,
                render: (state: SparePart['state']) => <Tag color={spareStateTone(state)}>{state}</Tag>,
              },
              {
                title: '占用出库单',
                dataIndex: 'outboundNo',
                width: 160,
                className: 'gb-mono',
                render: (no: string) => no || <span className="gb-hint">—</span>,
              },
              {
                title: '操作',
                width: 150,
                render: (_: unknown, row: SparePart) => (
                  <Space size={6}>
                    <Button size="small" type="primary" disabled={row.state !== '在库' && row.state !== '已退库'} onClick={() => openOrder(row.serialNo)}>
                      开单
                    </Button>
                    <Popconfirm
                      title="删除备件"
                      description="仅在库备件可删除，确认？"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() =>
                        void guard(dispatch(removeSparePart(row.id)) as never, '备件已删除')
                      }
                    >
                      <Button size="small" danger icon={<DeleteOutlined />} disabled={row.state !== '在库' && row.state !== '已退库'} />
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Card className="gb-panel" size="small" title={`出库单（${orders.length} 张，原单全程保留不物理删除）`}>
        {orders.length === 0 ? (
          <EmptyPanel title="还没有出库单" description="选择在库备件开出库单，序列号开单即锁。" actionText="开出库单" onAction={() => openOrder()} compact />
        ) : (
          <Table
            rowKey="id"
            size="small"
            className="gb-table-compact"
            dataSource={[...orders].sort((a, b) => b.outboundDate.localeCompare(a.outboundDate))}
            pagination={false}
            columns={[
              { title: '出库单号', dataIndex: 'outboundNo', className: 'gb-mono', width: 165 },
              { title: '序列号', dataIndex: 'serialNo', className: 'gb-mono', width: 175 },
              { title: '领用台站', dataIndex: 'stationCode', width: 90, className: 'gb-mono' },
              { title: '用途', dataIndex: 'purpose', ellipsis: true },
              { title: '出库日期', dataIndex: 'outboundDate', width: 105, className: 'gb-mono' },
              { title: '领用人', dataIndex: 'receiver', width: 80, render: (v: string) => v || <span className="gb-hint">待领</span> },
              {
                title: '状态',
                dataIndex: 'state',
                width: 95,
                render: (state: SparePart['state'] & string) => <Tag color={outboundStateTone(state as never)}>{state}</Tag>,
              },
              {
                title: '操作',
                width: 230,
                render: (_: unknown, row) => (
                  <Space size={6} wrap>
                    {row.state === '待领用' ? (
                      <>
                        <Button size="small" type="primary" onClick={() =>
                          void guard(dispatch(confirmReceive({ id: row.id, receiver: row.receiver || '周渝' })) as never, '领用已确认，备件出库')
                        }>
                          确认领用
                        </Button>
                        <Popconfirm
                          title="作废出库单"
                          description="仅待领用单可作废，作废后序列号解锁回库。"
                          okText="作废"
                          cancelText="取消"
                          okButtonProps={{ danger: true }}
                          onConfirm={() =>
                            void guard(dispatch(voidOutboundOrder({ id: row.id, closeReason: '库管作废' })) as never, '单据已作废，序列号解锁')
                          }
                        >
                          <Button size="small" danger icon={<StopOutlined />}>作废</Button>
                        </Popconfirm>
                      </>
                    ) : null}
                    {row.state === '已领用' ? (
                      <Tag color="gold" icon={<RollbackOutlined />}>
                        等班组在「台站运维」撤回退库
                      </Tag>
                    ) : null}
                    {row.state === '已撤回' ? (
                      <span className="gb-hint">退库人：{row.returnOperator}</span>
                    ) : null}
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Card>

      <p className="gb-hint">
        撤回领用走「先撤台站侧、再解锁库侧」：已领用单不允许库管直接作废，请到「台站运维」页由班组撤回，系统退库并解锁序列号，原单保留为「已撤回」。
      </p>

      <Modal open={partOpen} title="备件入库" onCancel={() => setPartOpen(false)} onOk={() => void submitPart()} confirmLoading={submitting} okText="入库" destroyOnClose>
        <Form form={partForm} layout="vertical" preserve={false}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="type" label="类型" rules={[{ required: true }]}>
                <Select options={SPARE_PART_TYPES.map((t) => ({ label: t, value: t }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="model" label="型号" rules={[{ required: true, message: '请填型号' }]}>
                <Input maxLength={40} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="serialNo" label="序列号（全库唯一）" rules={[{ required: true, message: '请填序列号' }]}>
            <Input maxLength={60} placeholder="如：CMG-3E-20261006-51" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="inboundDate" label="入库日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="location" label="库位">
                <Input maxLength={20} placeholder="如 A-13" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注">
            <Input maxLength={100} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal open={orderOpen} title="开出库单（开单即锁序列号）" onCancel={() => setOrderOpen(false)} onOk={() => void submitOrder()} confirmLoading={submitting} okText="开单锁定" destroyOnClose>
        <Form form={orderForm} layout="vertical" preserve={false}>
          <Form.Item name="serialNo" label="出库备件（在库）" rules={[{ required: true, message: '请选择备件' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={availableParts.map((p) => ({ label: `${p.serialNo}（${p.model} · ${p.location || '无库位'}）`, value: p.serialNo }))}
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="stationCode" label="领用台站码" rules={[{ required: true, message: '请填台站码' }]}>
                <Input maxLength={12} placeholder="如 LTX02" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="outboundDate" label="出库日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="purpose" label="用途" rules={[{ required: true, message: '请填用途' }]}>
            <Input maxLength={80} placeholder="如 雷击损坏更换" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="keeper" label="开单库管" rules={[{ required: true }]}>
                <Input maxLength={20} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注">
            <Input maxLength={100} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
