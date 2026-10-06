/**
 * 台站运维班组（/operations）：安装位与拆卸登记。
 * - 待领用出库单可在此一站完成「领用 + 安装」；
 * - 撤回领用只动台站侧，解锁等装备库确认退库；
 * - 旧机回收失败在此重试，装备库单据不回退；
 * - 拆下来的序列号立即从安装位摘除，不再进超期名单。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  AutoComplete,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Form,
  Input,
  Modal,
  Radio,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  PlusOutlined,
  RedoOutlined,
  RollbackOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import StatBadge from '@/components/common/StatBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectArrays, selectStations } from '@/stores/arraySlice';
import { selectOutboundOrders } from '@/stores/warehouseSlice';
import {
  patchFilter,
  receiveAndInstall,
  registerInstall,
  removeFromSlot,
  resetFilter,
  retryRecovery,
  selectActiveInstalls,
  selectInstalls,
  selectOpsFilter,
  selectRecoveryFailed,
  selectWithdrawnPendingReturn,
  withdrawInstall,
} from '@/stores/opsSlice';
import { COMMON_MODELS, INSTRUMENT_TYPES, type InstrumentType } from '@/types/instrument';
import { INSTALL_STATES, type InstallRecord, type RecoveryResult } from '@/types/install';

interface DirectInstallValues {
  stationId: string;
  slot: string;
  type: InstrumentType;
  model: string;
  serialNo: string;
  outboundNo: string;
  installDate: dayjs.Dayjs;
  installer: string;
  remark: string;
}

const INSTALL_TAG_COLOR: Record<string, string> = {
  已安装: 'green',
  已拆卸: 'default',
  回收失败: 'red',
};

export default function StationOpsPage() {
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();

  const stations = useAppSelector(selectStations);
  const arrays = useAppSelector(selectArrays);
  const installs = useAppSelector(selectInstalls);
  const activeInstalls = useAppSelector(selectActiveInstalls);
  const withdrawn = useAppSelector(selectWithdrawnPendingReturn);
  const recoveryFailed = useAppSelector(selectRecoveryFailed);
  const orders = useAppSelector(selectOutboundOrders);
  const filter = useAppSelector(selectOpsFilter);

  const [installOpen, setInstallOpen] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [receiveOrderId, setReceiveOrderId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<InstallRecord | null>(null);
  const [retryTarget, setRetryTarget] = useState<InstallRecord | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [installForm] = Form.useForm<DirectInstallValues>();
  const [receiveForm] = Form.useForm();
  const [removeForm] = Form.useForm();
  const [retryForm] = Form.useForm();

  const stationName = useMemo(() => {
    const map = new Map<string, { code: string; arrayName: string }>();
    stations.forEach((station) => {
      const array = arrays.find((row) => row.id === station.arrayId);
      map.set(station.id, { code: station.code, arrayName: array?.name ?? '' });
    });
    return map;
  }, [arrays, stations]);

  const openOrders = useMemo(
    () =>
      orders
        .filter((order) => order.state === '已开立')
        .sort((a, b) => b.outboundDate.localeCompare(a.outboundDate)),
    [orders]
  );

  const filteredInstalls = useMemo(() => {
    const keyword = filter.keyword.trim();
    return installs
      .filter((row) => {
        if (keyword.length > 0) {
          const haystack = `${row.serialNo}${row.stationCode}${row.slot}${row.model}${row.outboundNo}`;
          if (!haystack.includes(keyword)) return false;
        }
        if (filter.states.length > 0 && !filter.states.includes(row.state)) return false;
        if (filter.onlyWithdrawn && !row.withdrawn) return false;
        return true;
      })
      .sort((a, b) => b.installDate.localeCompare(a.installDate));
  }, [filter, installs]);

  const openInstallModal = () => {
    installForm.setFieldsValue({
      stationId: stations[0]?.id,
      slot: '',
      type: '宽频带',
      model: '',
      serialNo: '',
      outboundNo: '',
      installDate: dayjs(),
      installer: '',
      remark: '',
    });
    setInstallOpen(true);
  };

  const submitInstall = async () => {
    const values = await installForm.validateFields();
    setSubmitting(true);
    try {
      await dispatch(
        registerInstall({
          stationId: values.stationId,
          slot: values.slot.trim(),
          type: values.type,
          model: values.model.trim(),
          serialNo: values.serialNo.trim(),
          outboundNo: values.outboundNo?.trim() ?? '',
          installDate: values.installDate.format('YYYY-MM-DD'),
          installer: values.installer.trim(),
          remark: values.remark?.trim() ?? '',
        })
      ).unwrap();
      message.success('安装登记已建立');
      setInstallOpen(false);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '登记失败');
    } finally {
      setSubmitting(false);
    }
  };

  const openReceive = (orderId: string) => {
    setReceiveOrderId(orderId);
    const order = orders.find((row) => row.id === orderId);
    const station = stations.find((row) => row.code === order?.stationCode);
    receiveForm.setFieldsValue({
      stationId: station?.id ?? stations[0]?.id,
      slot: '',
      installDate: dayjs(),
      installer: order?.receiver ?? '',
      remark: order?.purpose ?? '',
    });
    setReceiveOpen(true);
  };

  const submitReceive = async () => {
    if (!receiveOrderId) return;
    const values = await receiveForm.validateFields();
    setSubmitting(true);
    try {
      await dispatch(
        receiveAndInstall({
          orderId: receiveOrderId,
          stationId: values.stationId,
          slot: values.slot.trim(),
          installDate: values.installDate.format('YYYY-MM-DD'),
          installer: values.installer.trim(),
          remark: values.remark?.trim() ?? '',
        })
      ).unwrap();
      message.success('领用安装完成');
      setReceiveOpen(false);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '领用安装失败');
    } finally {
      setSubmitting(false);
      setReceiveOrderId(null);
    }
  };

  const openRemove = (record: InstallRecord) => {
    setRemoveTarget(record);
    removeForm.setFieldsValue({
      removeDate: dayjs(),
      reason: '',
      recoveryResult: '已回收',
      note: '',
    });
  };

  const submitRemove = async () => {
    if (!removeTarget) return;
    const values = await removeForm.validateFields();
    setSubmitting(true);
    try {
      await dispatch(
        removeFromSlot({
          id: removeTarget.id,
          removeDate: values.removeDate.format('YYYY-MM-DD'),
          reason: values.reason,
          recoveryResult: values.recoveryResult as RecoveryResult,
          note: values.note,
        })
      ).unwrap();
      message.success('拆卸登记完成');
      setRemoveTarget(null);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '拆卸失败');
    } finally {
      setSubmitting(false);
    }
  };

  const openRetry = (record: InstallRecord) => {
    setRetryTarget(record);
    retryForm.setFieldsValue({ result: '已回收', note: '' });
  };

  const submitRetry = async () => {
    if (!retryTarget) return;
    const values = await retryForm.validateFields();
    setSubmitting(true);
    try {
      await dispatch(
        retryRecovery({
          id: retryTarget.id,
          result: values.result as RecoveryResult,
          note: values.note ?? '',
        })
      ).unwrap();
      message.success(values.result === '回收失败' ? '已登记再次回收失败' : '回收重试成功');
      setRetryTarget(null);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '重试失败');
    } finally {
      setSubmitting(false);
    }
  };

  const doWithdraw = async (record: InstallRecord) => {
    try {
      await dispatch(withdrawInstall({ id: record.id, reason: '班组撤回领用' })).unwrap();
      message.success('已撤回领用（台站侧），请等装备库确认退库解锁序列号');
    } catch (error) {
      message.error(typeof error === 'string' ? error : '撤回失败');
    }
  };

  const commonColumns = [
    {
      title: '安装位',
      width: 130,
      render: (_: unknown, row: InstallRecord) => (
        <div>
          <div className="gb-mono">{row.stationCode}</div>
          <div className="gb-hint">{row.slot}</div>
        </div>
      ),
    },
    {
      title: '仪器',
      width: 210,
      render: (_: unknown, row: InstallRecord) => (
        <div>
          <div>
            {row.model} <Tag>{row.type}</Tag>
          </div>
          <div className="gb-hint gb-mono">{row.serialNo}</div>
        </div>
      ),
    },
    {
      title: '出库单号',
      dataIndex: 'outboundNo',
      width: 170,
      className: 'gb-mono',
      render: (value: string) =>
        value ? (
          value
        ) : (
          <Tag color="red">无单号·对账异常</Tag>
        ),
    },
    { title: '安装日期', dataIndex: 'installDate', width: 110, className: 'gb-mono' },
    {
      title: '状态',
      dataIndex: 'state',
      width: 100,
      render: (state: string, row: InstallRecord) => (
        <Space direction="vertical" size={2}>
          <Tag color={INSTALL_TAG_COLOR[state]}>{state}</Tag>
          {row.withdrawn ? <Tag color="orange">已撤回待退库</Tag> : null}
        </Space>
      ),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
            台站运维班组 · 安装位与拆卸登记
          </Typography.Title>
          <p className="gb-hint">
            班组只登记「哪个台站的哪个安装位装上/拆下了哪台序列号」，库存与序列号锁定归装备库；
            撤回领用先在本页操作，装备库退库后序列号才解锁。
          </p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openInstallModal}>
          登记安装
        </Button>
      </div>

      <div className="gb-stats-row">
        <StatBadge label="在位安装位" value={activeInstalls.length} suffix="处" tone="success" />
        <StatBadge label="待领用单据" value={openOrders.length} suffix="张" tone="warning" />
        <StatBadge label="已撤回待退库" value={withdrawn.length} suffix="条" tone="warning" />
        <StatBadge label="回收失败待重试" value={recoveryFailed.length} suffix="条" tone="danger" />
      </div>

      {openOrders.length > 0 ? (
        <Card
          size="small"
          className="gb-panel"
          title={
            <span>
              <ToolOutlined /> 待领用出库单（{openOrders.length}）— 装备库已开单锁号，班组领用并登记安装位
            </span>
          }
        >
          <Table
            rowKey="id"
            size="small"
            className="gb-table-compact"
            dataSource={openOrders}
            pagination={false}
            columns={[
              { title: '出库单号', dataIndex: 'orderNo', className: 'gb-mono', width: 180 },
              { title: '序列号', dataIndex: 'serialNo', className: 'gb-mono', width: 190 },
              { title: '型号', dataIndex: 'model', width: 140 },
              { title: '领用台站', dataIndex: 'stationCode', width: 100, className: 'gb-mono' },
              { title: '用途', dataIndex: 'purpose', ellipsis: true },
              {
                title: '操作',
                width: 130,
                render: (_: unknown, row) => (
                  <Button type="primary" size="small" onClick={() => openReceive(row.id)}>
                    领用并安装
                  </Button>
                ),
              },
            ]}
          />
        </Card>
      ) : null}

      {withdrawn.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`有 ${withdrawn.length} 条撤回领用记录等待装备库确认退库`}
          description={withdrawn
            .map((row) => `${row.stationCode} / ${row.slot} · ${row.serialNo}（${row.removeDate ?? ''}）`)
            .join('；')}
        />
      ) : null}

      <Card className="gb-panel" size="small" styles={{ body: { padding: 12 } }}>
        <Space style={{ marginBottom: 10 }} wrap>
          <Input.Search
            allowClear
            placeholder="搜序列号 / 台站码 / 安装位 / 单号"
            defaultValue={filter.keyword}
            style={{ width: 280 }}
            onSearch={(value) => void dispatch(patchFilter({ keyword: value }))}
            onChange={(event) => {
              if (!event.target.value) void dispatch(patchFilter({ keyword: '' }));
            }}
          />
          <Select
            mode="multiple"
            allowClear
            placeholder="按状态筛选"
            style={{ minWidth: 200 }}
            value={filter.states}
            options={INSTALL_STATES.map((state) => ({ label: state, value: state }))}
            onChange={(states) => void dispatch(patchFilter({ states }))}
          />
          <Checkbox
            checked={filter.onlyWithdrawn}
            onChange={(event) => void dispatch(patchFilter({ onlyWithdrawn: event.target.checked }))}
          >
            只看已撤回待退库
          </Checkbox>
          <Button onClick={() => void dispatch(resetFilter())}>重置</Button>
        </Space>

        <Table
          rowKey="id"
          size="small"
          className="gb-table-compact"
          dataSource={filteredInstalls}
          pagination={false}
          columns={[
            ...commonColumns,
            {
              title: '回收',
              width: 150,
              render: (_: unknown, row: InstallRecord) =>
                row.recoveryResult ? (
                  <div>
                    <Tag color={row.recoveryResult === '回收失败' ? 'red' : 'default'}>{row.recoveryResult}</Tag>
                    {row.retryCount > 0 ? <div className="gb-hint">重试 {row.retryCount} 次</div> : null}
                  </div>
                ) : (
                  <span className="gb-hint">—</span>
                ),
            },
            {
              title: '操作',
              width: 250,
              render: (_: unknown, row: InstallRecord) => (
                <Space size={4} wrap>
                  {row.state === '已安装' && !row.withdrawn ? (
                    <>
                      <Button size="small" icon={<ToolOutlined />} onClick={() => openRemove(row)}>
                        拆卸登记
                      </Button>
                      <Button size="small" icon={<RollbackOutlined />} onClick={() => void doWithdraw(row)}>
                        撤回领用
                      </Button>
                    </>
                  ) : null}
                  {row.state === '回收失败' || row.recoveryResult === '回收失败' ? (
                    <Button size="small" danger icon={<RedoOutlined />} onClick={() => openRetry(row)}>
                      重试回收
                    </Button>
                  ) : null}
                </Space>
              ),
            },
          ]}
          locale={{
            emptyText: (
              <EmptyPanel
                title={installs.length === 0 ? '还没有安装登记' : '没有符合条件的记录'}
                description="从上方「待领用出库单」领用安装，或点右上角「登记安装」补现场记录。"
                actionText="登记安装"
                onAction={openInstallModal}
                compact
              />
            ),
          }}
        />
      </Card>

      <Alert
        type="info"
        showIcon
        message="与装备库的边界"
        description="撤回领用只回退台站这侧（安装位拆下、标记待退库），不直接解锁库存；解锁由装备库在本页撤回之后点「确认退库」完成。旧机回收失败可反复重试，装备库出库单始终保留、不回退。"
      />

      {/* 直接登记安装（可不带单号 → 自动进对账异常） */}
      <Modal
        open={installOpen}
        title="登记安装位"
        onCancel={() => setInstallOpen(false)}
        onOk={() => void submitInstall()}
        confirmLoading={submitting}
        okText="保存登记"
        destroyOnClose
        width={640}
      >
        <Form form={installForm} layout="vertical" preserve={false}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="stationId" label="台站" rules={[{ required: true, message: '请选择台站' }]}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  options={stations.map((station) => {
                    const meta = stationName.get(station.id);
                    return { label: `${station.code}（${meta?.arrayName ?? ''}）`, value: station.id };
                  })}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="slot" label="安装位" rules={[{ required: true, message: '请填安装位' }]}>
                <Input placeholder="如：井下位 A" maxLength={30} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="type" label="类型" rules={[{ required: true }]}>
                <Select options={INSTRUMENT_TYPES.map((type) => ({ label: type, value: type }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="model" label="型号" rules={[{ required: true, message: '请填型号' }]}>
                <AutoCompleteModel />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="serialNo" label="序列号" rules={[{ required: true, message: '序列号不能为空' }]}>
                <Input maxLength={60} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item
                name="outboundNo"
                label="出库单号（可留空）"
                extra="留空表示先装后补，将列入「装了又没出库」"
              >
                <Input maxLength={40} placeholder="CK-YYYYMMDD-NNN" />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="installDate" label="安装日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="installer" label="安装人" rules={[{ required: true, message: '请填安装人' }]}>
                <Input maxLength={20} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={100} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 领用并安装 */}
      <Modal
        open={receiveOpen}
        title="领用并登记安装位"
        onCancel={() => {
          setReceiveOpen(false);
          setReceiveOrderId(null);
        }}
        onOk={() => void submitReceive()}
        confirmLoading={submitting}
        okText="确认领用安装"
        destroyOnClose
      >
        <Form form={receiveForm} layout="vertical" preserve={false}>
          <Form.Item name="stationId" label="台站" rules={[{ required: true, message: '请选择台站' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={stations.map((station) => {
                const meta = stationName.get(station.id);
                return { label: `${station.code}（${meta?.arrayName ?? ''}）`, value: station.id };
              })}
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="slot" label="安装位" rules={[{ required: true, message: '请填安装位' }]}>
                <Input maxLength={30} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="installDate" label="安装日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="installer" label="安装人" rules={[{ required: true, message: '请填安装人' }]}>
            <Input maxLength={20} />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={100} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 拆卸登记 */}
      <Modal
        open={removeTarget !== null}
        title={`拆卸登记 · ${removeTarget?.stationCode} / ${removeTarget?.slot}`}
        onCancel={() => setRemoveTarget(null)}
        onOk={() => void submitRemove()}
        confirmLoading={submitting}
        okText="保存拆卸"
        destroyOnClose
      >
        <Form form={removeForm} layout="vertical" preserve={false}>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="removeDate" label="拆卸日期" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="recoveryResult" label="旧机回收结果" rules={[{ required: true }]}>
                <Radio.Group>
                  <Radio value="已回收">
                    <CheckCircleOutlined /> 已回收
                  </Radio>
                  <Radio value="回收失败">回收失败</Radio>
                </Radio.Group>
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="reason" label="拆卸原因" rules={[{ required: true, message: '请填拆卸原因' }]}>
            <Input.TextArea rows={2} maxLength={100} placeholder="如：超期未标定 / 故障更换" />
          </Form.Item>
          <Form.Item name="note" label="回收备注（失败时填写卡点，后续在本页重试）">
            <Input.TextArea rows={2} maxLength={200} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 回收重试 */}
      <Modal
        open={retryTarget !== null}
        title={`旧机回收重试 · ${retryTarget?.serialNo}（已重试 ${retryTarget?.retryCount ?? 0} 次）`}
        onCancel={() => setRetryTarget(null)}
        onOk={() => void submitRetry()}
        confirmLoading={submitting}
        okText="提交重试结果"
        destroyOnClose
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="只重试台站这侧：装备库出库单保留不回退。"
        />
        <Form form={retryForm} layout="vertical" preserve={false}>
          <Form.Item name="result" label="本次结果" rules={[{ required: true }]}>
            <Radio.Group>
              <Radio value="已回收">回收成功</Radio>
              <Radio value="回收失败">仍然失败</Radio>
            </Radio.Group>
          </Form.Item>
          <Form.Item name="note" label="本次说明" rules={[{ required: true, message: '请填写本次重试说明' }]}>
            <Input.TextArea rows={3} maxLength={200} placeholder="如：第 3 次：已联系井下作业队，底座锈死待切割" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

/** 型号联想（与仪器登记页同口径） */
function AutoCompleteModel() {
  const form = Form.useFormInstance<DirectInstallValues>();
  const type = Form.useWatch('type', form) as InstrumentType;
  return (
    <AutoComplete
      options={(COMMON_MODELS[type] ?? []).map((model) => ({ label: model, value: model }))}
      filterOption={(input, option) => (option?.value ?? '').toLowerCase().includes(input.toLowerCase())}
      placeholder="选择或输入型号"
    />
  );
}
