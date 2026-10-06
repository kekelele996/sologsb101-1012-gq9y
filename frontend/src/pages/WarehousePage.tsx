/**
 * 装备库（/warehouse）：备件库存 + 出库单。
 * 装备库只认序列号与单据：开单即锁序列号；撤回领用必须班组先撤、装备库确认退库后才解锁；
 * 出库单不做物理删除 / 不作废，回退一律走退库留痕。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  AutoComplete,
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
  InboxOutlined,
  LockOutlined,
  LogoutOutlined,
  PlusOutlined,
  RollbackOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import StatBadge from '@/components/common/StatBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import {
  addSpare,
  confirmReceive,
  createOutboundOrder,
  patchFilter,
  removeSpare,
  resetFilter,
  returnOrder,
  selectAvailableSpares,
  selectOutboundOrders,
  selectSpares,
  selectSpareStateCounts,
  selectWarehouseFilter,
  updateOrderInfo,
} from '@/stores/warehouseSlice';
import { COMMON_MODELS, INSTRUMENT_TYPES, type InstrumentType } from '@/types/instrument';
import { OUTBOUND_STATES, type OutboundOrder } from '@/types/outbound';
import type { SparePart } from '@/types/spare';

interface SpareFormValues {
  type: InstrumentType;
  model: string;
  serialNo: string;
  inboundDate: dayjs.Dayjs;
  remark: string;
}

interface OrderFormValues {
  spareId: string;
  stationCode: string;
  purpose: string;
  receiver: string;
  outboundDate: dayjs.Dayjs;
  remark: string;
}

const ORDER_TAG_COLOR: Record<string, string> = {
  已开立: 'orange',
  已领用: 'blue',
  已退库: 'default',
};

const SPARE_TAG_COLOR: Record<string, string> = {
  在库: 'green',
  锁定: 'orange',
  已出库: 'blue',
};

export default function WarehousePage() {
  const dispatch = useAppDispatch();
  const { message, modal } = AntdApp.useApp();

  const spares = useAppSelector(selectSpares);
  const orders = useAppSelector(selectOutboundOrders);
  const availableSpares = useAppSelector(selectAvailableSpares);
  const counts = useAppSelector(selectSpareStateCounts);
  const filter = useAppSelector(selectWarehouseFilter);

  const [tab, setTab] = useState<'spares' | 'orders'>('spares');
  const [spareOpen, setSpareOpen] = useState(false);
  const [orderOpen, setOrderOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [spareForm] = Form.useForm<SpareFormValues>();
  const [orderForm] = Form.useForm<OrderFormValues>();

  const filteredOrders = useMemo(() => {
    const keyword = filter.keyword.trim();
    return orders
      .filter((order) => {
        if (keyword.length > 0) {
          const haystack = `${order.orderNo}${order.serialNo}${order.stationCode}${order.model}${order.receiver}`;
          if (!haystack.includes(keyword)) return false;
        }
        if (filter.states.length > 0 && !filter.states.includes(order.state)) return false;
        return true;
      })
      .sort((a, b) => b.outboundDate.localeCompare(a.outboundDate));
  }, [filter, orders]);

  const openSpareModal = () => {
    spareForm.setFieldsValue({
      type: '宽频带',
      model: '',
      serialNo: '',
      inboundDate: dayjs(),
      remark: '',
    });
    setSpareOpen(true);
  };

  const submitSpare = async () => {
    const values = await spareForm.validateFields();
    setSubmitting(true);
    try {
      await dispatch(
        addSpare({
          type: values.type,
          model: values.model.trim(),
          serialNo: values.serialNo.trim(),
          inboundDate: values.inboundDate.format('YYYY-MM-DD'),
          remark: values.remark?.trim() ?? '',
        })
      ).unwrap();
      message.success('备件已入装备库');
      setSpareOpen(false);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '备件登记失败');
    } finally {
      setSubmitting(false);
    }
  };

  const openOrderModal = () => {
    if (availableSpares.length === 0) {
      message.warning('没有「在库」且未被占用的备件，先登记入库');
      return;
    }
    orderForm.setFieldsValue({
      spareId: availableSpares[0].id,
      stationCode: '',
      purpose: '',
      receiver: '',
      outboundDate: dayjs(),
      remark: '',
    });
    setOrderOpen(true);
  };

  const submitOrder = async () => {
    const values = await orderForm.validateFields();
    setSubmitting(true);
    try {
      await dispatch(
        createOutboundOrder({
          spareId: values.spareId,
          stationCode: values.stationCode.trim(),
          purpose: values.purpose.trim(),
          receiver: values.receiver.trim(),
          outboundDate: values.outboundDate.format('YYYY-MM-DD'),
          remark: values.remark?.trim() ?? '',
        })
      ).unwrap();
      message.success('出库单已开立，序列号已锁定');
      setOrderOpen(false);
      setTab('orders');
    } catch (error) {
      message.error(typeof error === 'string' ? error : '开单失败');
    } finally {
      setSubmitting(false);
    }
  };

  const doConfirmReceive = async (order: OutboundOrder) => {
    try {
      await dispatch(confirmReceive(order.id)).unwrap();
      message.success(`出库单 ${order.orderNo} 已确认领用（班组安装请到「台站运维」页登记）`);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '确认领用失败');
    }
  };

  const doReturn = (order: OutboundOrder) => {
    let reason = '';
    let date = dayjs().format('YYYY-MM-DD');
    modal.confirm({
      title: `确认退库并解锁序列号（${order.orderNo}）`,
      content: (
        <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
          <Typography.Paragraph type="warning" style={{ marginBottom: 0 }}>
            前提：班组已在台站侧撤回领用。确认后单据置「已退库」保留留痕，备件放回在库、序列号解锁。
          </Typography.Paragraph>
          <Input.TextArea
            rows={2}
            placeholder="退库原因（如：型号不匹配，班组撤回）"
            onChange={(event) => {
              reason = event.target.value;
            }}
          />
          <DatePicker
            defaultValue={dayjs()}
            onChange={(value) => {
              date = value ? value.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD');
            }}
          />
        </Space>
      ),
      okText: '确认退库解锁',
      cancelText: '取消',
      onOk: async () => {
        await dispatch(returnOrder({ id: order.id, reason, returnDate: date }))
          .unwrap()
          .then(() => message.success('已退库，序列号解锁放回在库'))
          .catch((error: unknown) => message.error(typeof error === 'string' ? error : '退库失败'));
      },
    });
  };

  const doEditPurpose = (order: OutboundOrder) => {
    let purpose = order.purpose;
    let receiver = order.receiver;
    modal.confirm({
      title: `修改单据信息（${order.orderNo}，序列号/状态不可改）`,
      content: (
        <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
          <Input defaultValue={purpose} placeholder="用途" onChange={(e) => (purpose = e.target.value)} />
          <Input defaultValue={receiver} placeholder="领用人" onChange={(e) => (receiver = e.target.value)} />
        </Space>
      ),
      onOk: async () => {
        await dispatch(updateOrderInfo({ id: order.id, patch: { purpose, receiver } }))
          .unwrap()
          .then(() => message.success('单据已更新'))
          .catch((error: unknown) => message.error(typeof error === 'string' ? error : '更新失败'));
      },
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div>
        <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
          装备库 · 备件库存与出库单
        </Typography.Title>
        <p className="gb-hint">
          装备库只管备件序列号与出库凭证：出库单开好即锁定序列号；班组撤回领用时须先由班组撤回、装备库确认退库后再解锁放回在库。
          出库单不做物理删除、不设作废，回退一律走「已退库」留痕；旧机回收失败不影响装备库单据。
        </p>
      </div>

      <div className="gb-stats-row">
        <StatBadge label="在库" value={counts.在库} suffix="件" tone="success" tip="可立即开单" />
        <StatBadge label="锁定（已开单待领用）" value={counts.锁定} suffix="件" tone="warning" />
        <StatBadge label="已出库" value={counts.已出库} suffix="件" tone="info" />
        <StatBadge label="出库单总数" value={orders.length} suffix="张" tone="primary" />
        <StatBadge
          label="待领用单据"
          value={orders.filter((row) => row.state === '已开立').length}
          suffix="张"
          tone="warning"
        />
        <StatBadge
          label="已退库留痕"
          value={orders.filter((row) => row.state === '已退库').length}
          suffix="张"
          tone="default"
        />
      </div>

      <Card className="gb-panel" styles={{ body: { padding: 12 } }}>
        <Tabs
          activeKey={tab}
          onChange={(key) => setTab(key as 'spares' | 'orders')}
          items={[
            {
              key: 'spares',
              label: (
                <span>
                  <InboxOutlined /> 备件库存（{spares.length}）
                </span>
              ),
              children: spares.length === 0 ? (
                <EmptyPanel
                  title="装备库还没有备件"
                  description="先把可换备件按序列号登记入库，之后才能开出库单。"
                  actionText="备件入库"
                  onAction={openSpareModal}
                />
              ) : (
                <Table
                  rowKey="id"
                  size="small"
                  className="gb-table-compact"
                  dataSource={[...spares].sort((a, b) => b.updatedAt - a.updatedAt)}
                  pagination={false}
                  title={() => (
                    <Space>
                      <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openSpareModal}>
                        备件入库
                      </Button>
                    </Space>
                  )}
                  columns={[
                    { title: '序列号', dataIndex: 'serialNo', className: 'gb-mono', width: 200 },
                    { title: '类型', dataIndex: 'type', width: 100 },
                    { title: '型号', dataIndex: 'model', width: 150 },
                    { title: '入库日期', dataIndex: 'inboundDate', width: 120, className: 'gb-mono' },
                    {
                      title: '库存状态',
                      dataIndex: 'state',
                      width: 110,
                      render: (state: string, row: SparePart) => (
                        <Space size={4}>
                          {state === '锁定' ? <LockOutlined style={{ color: '#d68910' }} /> : null}
                          <Tag color={SPARE_TAG_COLOR[state]} style={{ marginInlineEnd: 0 }}>
                            {state}
                            {state === '锁定' && row.outboundId ? '·已开单' : ''}
                          </Tag>
                        </Space>
                      ),
                    },
                    { title: '备注', dataIndex: 'remark', ellipsis: true },
                    {
                      title: '操作',
                      width: 110,
                      render: (_: unknown, row: SparePart) => (
                        <Popconfirm
                          title="删除备件"
                          description="仅未被单据占用的在库备件可删除，确认？"
                          okText="删除"
                          cancelText="取消"
                          okButtonProps={{ danger: true }}
                          disabled={row.state !== '在库' || !!row.outboundId}
                          onConfirm={() =>
                            void dispatch(removeSpare(row.id))
                              .unwrap()
                              .then(() => message.success('备件已删除'))
                              .catch((error: unknown) =>
                                message.error(typeof error === 'string' ? error : '删除失败')
                              )
                          }
                        >
                          <Button
                            size="small"
                            danger
                            disabled={row.state !== '在库' || !!row.outboundId}
                          >
                            删除
                          </Button>
                        </Popconfirm>
                      ),
                    },
                  ]}
                />
              ),
            },
            {
              key: 'orders',
              label: (
                <span>
                  <LogoutOutlined /> 出库单（{orders.length}）
                </span>
              ),
              children: (
                <>
                  <Space style={{ marginBottom: 10 }} wrap>
                    <Input.Search
                      allowClear
                      placeholder="搜单号 / 序列号 / 台站码 / 型号 / 领用人"
                      defaultValue={filter.keyword}
                      style={{ width: 300 }}
                      onSearch={(value) => void dispatch(patchFilter({ keyword: value }))}
                      onChange={(event) => {
                        if (!event.target.value) void dispatch(patchFilter({ keyword: '' }));
                      }}
                    />
                    <Select
                      mode="multiple"
                      allowClear
                      placeholder="按状态筛选"
                      style={{ minWidth: 220 }}
                      value={filter.states}
                      options={OUTBOUND_STATES.map((state) => ({ label: state, value: state }))}
                      onChange={(states) => void dispatch(patchFilter({ states }))}
                    />
                    <Button onClick={() => void dispatch(resetFilter())}>重置</Button>
                    <Button type="primary" icon={<PlusOutlined />} onClick={openOrderModal}>
                      开出库单（锁序列号）
                    </Button>
                  </Space>
                  {filteredOrders.length === 0 ? (
                    <EmptyPanel
                      title="没有符合条件的出库单"
                      description="选择一台在库备件开单，序列号在开单成功时即锁定，班组凭单领用。"
                      actionText="开出库单"
                      onAction={openOrderModal}
                      compact
                    />
                  ) : (
                    <Table
                      rowKey="id"
                      size="small"
                      className="gb-table-compact"
                      dataSource={filteredOrders}
                      pagination={false}
                      columns={[
                        { title: '出库单号', dataIndex: 'orderNo', className: 'gb-mono', width: 180 },
                        { title: '序列号', dataIndex: 'serialNo', className: 'gb-mono', width: 190 },
                        { title: '型号', dataIndex: 'model', width: 140 },
                        { title: '领用台站', dataIndex: 'stationCode', width: 90, className: 'gb-mono' },
                        { title: '开单日期', dataIndex: 'outboundDate', width: 110, className: 'gb-mono' },
                        { title: '领用人', dataIndex: 'receiver', width: 90 },
                        {
                          title: '状态',
                          dataIndex: 'state',
                          width: 100,
                          render: (state: string) => <Tag color={ORDER_TAG_COLOR[state]}>{state}</Tag>,
                        },
                        {
                          title: '退库信息',
                          width: 180,
                          render: (_: unknown, row: OutboundOrder) =>
                            row.state === '已退库' ? (
                              <div>
                                <div className="gb-mono gb-hint">{row.returnDate}</div>
                                <div className="gb-hint">{row.returnReason}</div>
                              </div>
                            ) : (
                              <span className="gb-hint">—</span>
                            ),
                        },
                        {
                          title: '操作',
                          width: 210,
                          render: (_: unknown, row: OutboundOrder) => (
                            <Space size={4} wrap>
                              {row.state === '已开立' ? (
                                <Button
                                  size="small"
                                  type="primary"
                                  onClick={() => void doConfirmReceive(row)}
                                >
                                  确认领用
                                </Button>
                              ) : null}
                              {row.state === '已领用' ? (
                                <Button size="small" icon={<RollbackOutlined />} onClick={() => doReturn(row)}>
                                  确认退库
                                </Button>
                              ) : null}
                              {row.state !== '已退库' ? (
                                <Button size="small" onClick={() => doEditPurpose(row)}>
                                  改信息
                                </Button>
                              ) : null}
                            </Space>
                          ),
                        },
                      ]}
                    />
                  )}
                </>
              ),
            },
          ]}
        />
      </Card>

      <Row gutter={10}>
        <Col xs={24} md={12}>
          <Alert
            type="info"
            showIcon
            message="撤回领用的解锁顺序（本系统口径）"
            description="① 台站班组先在「台站运维」页对在位记录点「撤回领用」（只动台站侧）；② 装备库在出库单上点「确认退库」，序列号才解锁放回在库。装备库不能越过班组的撤回动作直接退库。"
          />
        </Col>
        <Col xs={24} md={12}>
          <Alert
            type="warning"
            showIcon
            message="旧机回收失败"
            description="只在「台站运维」页重试回收，装备库出库单保留「已领用」不回退；两边差异由「序列号对账」页单列。"
          />
        </Col>
      </Row>

      <Modal
        open={spareOpen}
        title="备件入库"
        onCancel={() => setSpareOpen(false)}
        onOk={() => void submitSpare()}
        confirmLoading={submitting}
        okText="登记入库"
        destroyOnClose
      >
        <Form form={spareForm} layout="vertical" preserve={false}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="type" label="类型" rules={[{ required: true }]}>
                <Select options={INSTRUMENT_TYPES.map((type) => ({ label: type, value: type }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="model" label="型号" rules={[{ required: true, message: '请填写型号' }]}>
                <AutoCompleteModel />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="serialNo" label="序列号" rules={[{ required: true, message: '序列号不能为空' }]}>
            <Input maxLength={60} placeholder="如：CMG-3E-20250410-33" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="inboundDate" label="入库日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={100} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={orderOpen}
        title="开出库单（保存即锁定序列号）"
        onCancel={() => setOrderOpen(false)}
        onOk={() => void submitOrder()}
        confirmLoading={submitting}
        okText="开单并锁定"
        destroyOnClose
        width={620}
      >
        <Form form={orderForm} layout="vertical" preserve={false}>
          <Form.Item name="spareId" label="选择在库备件" rules={[{ required: true, message: '请选择备件' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={availableSpares.map((spare) => ({
                label: `${spare.serialNo}（${spare.type} / ${spare.model}）`,
                value: spare.id,
              }))}
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="stationCode" label="领用台站码" rules={[{ required: true, message: '请填台站码' }]}>
                <Input placeholder="如：LTX02" maxLength={20} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="receiver" label="领用人" rules={[{ required: true, message: '请填领用人' }]}>
                <Input maxLength={20} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="purpose" label="用途 / 关联工单" rules={[{ required: true, message: '请填写用途' }]}>
            <Input maxLength={100} placeholder="如：雷击损坏更换" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="outboundDate" label="开单日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={100} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

/** 型号按类型自动联想（与仪器登记页保持同一口径） */
function AutoCompleteModel() {
  const form = Form.useFormInstance<SpareFormValues>();
  const type = Form.useWatch('type', form) as InstrumentType;
  return (
    <AutoComplete
      options={(COMMON_MODELS[type] ?? []).map((model) => ({ label: model, value: model }))}
      placeholder="选择或输入型号"
      filterOption={(input, option) => (option?.value ?? '').toLowerCase().includes(input.toLowerCase())}
    />
  );
}
