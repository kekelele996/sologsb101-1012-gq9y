/**
 * 序列号对账页：装备库 ⇄ 台站运维两本账按序列号核对。
 * - 出了库没装上台站（有效出库但台站无在装）
 * - 装了又没出库（台站在装但无有效出库单）
 * - 旧数据无出库单号、升级按台站码+安装日期补不出的单列
 * - 已拆卸旧机回收跟踪（只重试台站侧）
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  App as AntdApp,
} from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExportOutlined,
  ImportOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons';
import StatBadge from '@/components/common/StatBadge';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { selectSpareParts, selectOutboundOrders } from '@/stores/warehouseSlice';
import {
  selectInstalls,
  selectRemovals,
  resolveLegacyOutboundNo,
  recycleTone,
  retryRecycle,
} from '@/stores/opsSlice';
import { reconcileBySerial } from '@/utils/reconcile';

export default function ReconcileBoard() {
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();
  const parts = useAppSelector(selectSpareParts);
  const orders = useAppSelector(selectOutboundOrders);
  const installs = useAppSelector(selectInstalls);
  const removals = useAppSelector(selectRemovals);

  const result = useMemo(
    () => reconcileBySerial(parts, orders, installs, removals),
    [parts, orders, installs, removals]
  );

  const [fixTarget, setFixTarget] = useState<{ installId: string; serialNo: string } | null>(null);
  const [fixNo, setFixNo] = useState('');

  const healthy =
    result.outNotInstalled.length === 0 &&
    result.installedNotOut.length === 0 &&
    result.legacyMissingOrder.length === 0;

  const submitFix = async () => {
    if (!fixTarget) return;
    const res = await dispatch(
      resolveLegacyOutboundNo({ installId: fixTarget.installId, outboundNo: fixNo.trim() })
    );
    if (res.meta.requestStatus === 'fulfilled') {
      message.success('已补录单号，该记录移出待补清单');
      setFixTarget(null);
      setFixNo('');
    } else message.error((res.payload as string) ?? '补录失败');
  };

  const candidateOrders = useMemo(
    () => orders.map((o) => o.outboundNo).filter(Boolean),
    [orders]
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />
      <div>
        <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
          序列号对账 · 装备库 ⇄ 台站运维
        </Typography.Title>
        <p className="gb-hint">
          两本账各记各的，只按序列号核对。撤回退库单与作废单不计入异常；旧机回收问题只看台站侧。
        </p>
      </div>

      <div className="gb-stats-row">
        <StatBadge label="对得上" value={result.matched.length} suffix="台" tone="success" />
        <StatBadge
          label="出库未装机"
          value={result.outNotInstalled.length}
          suffix="台"
          tone={result.outNotInstalled.length > 0 ? 'warning' : 'success'}
        />
        <StatBadge
          label="装机未出库"
          value={result.installedNotOut.length}
          suffix="台"
          tone={result.installedNotOut.length > 0 ? 'danger' : 'success'}
        />
        <StatBadge
          label="旧数据补不出单号"
          value={result.legacyMissingOrder.length}
          suffix="条"
          tone={result.legacyMissingOrder.length > 0 ? 'warning' : 'success'}
        />
        <StatBadge
          label="回收未闭环"
          value={result.removedPendingRecycle.length}
          suffix="台"
          tone={result.removedPendingRecycle.length > 0 ? 'danger' : 'success'}
        />
      </div>

      {healthy ? (
        <Alert type="success" showIcon icon={<CheckCircleOutlined />} message="两账一致：所有在装设备均有有效出库单，无历史欠单。" />
      ) : (
        <Alert
          type="warning"
          showIcon
          icon={<QuestionCircleOutlined />}
          message="存在账实不一致，请逐类核对处理"
          description={`出库未装机 ${result.outNotInstalled.length} 台、装机未出库 ${result.installedNotOut.length} 台、历史欠单 ${result.legacyMissingOrder.length} 条。`}
        />
      )}

      <Tabs
        defaultActiveKey={result.outNotInstalled.length > 0 ? 'out' : 'matched'}
        items={[
          {
            key: 'matched',
            label: `对得上（${result.matched.length}）`,
            children: (
              <Card className="gb-panel" size="small">
                <Table
                  rowKey="serialNo"
                  size="small"
                  className="gb-table-compact"
                  dataSource={result.matched}
                  pagination={false}
                  columns={[
                    { title: '序列号', dataIndex: 'serialNo', className: 'gb-mono', width: 190 },
                    { title: '出库单号', dataIndex: 'outboundNo', className: 'gb-mono', width: 165 },
                    { title: '台站码', dataIndex: 'stationCode', width: 90, className: 'gb-mono' },
                    { title: '安装位', dataIndex: 'slotCode', width: 140, className: 'gb-mono' },
                    { title: '安装日期', dataIndex: 'installDate', width: 110, className: 'gb-mono' },
                    { title: '', render: () => <Tag icon={<CheckCircleOutlined />} color="green">两账一致</Tag> },
                  ]}
                />
              </Card>
            ),
          },
          {
            key: 'out',
            label: `出库未装机（${result.outNotInstalled.length}）`,
            children: (
              <Card className="gb-panel" size="small" title={<span><ExportOutlined /> 装备库有有效出库、台站无在装记录</span>}>
                <Table
                  rowKey="serialNo"
                  size="small"
                  className="gb-table-compact"
                  dataSource={result.outNotInstalled}
                  pagination={false}
                  rowClassName={() => 'gb-row-warning'}
                  columns={[
                    { title: '序列号', dataIndex: 'serialNo', className: 'gb-mono', width: 190 },
                    { title: '出库单号', dataIndex: 'outboundNo', className: 'gb-mono', width: 165 },
                    { title: '目标台站', dataIndex: 'stationCode', width: 90, className: 'gb-mono' },
                    { title: '型号', dataIndex: 'model', width: 140 },
                    { title: '出库日期', dataIndex: 'outboundDate', width: 110, className: 'gb-mono' },
                    { title: '单据状态', dataIndex: 'outboundState', width: 100, render: (s: string) => <Tag color="blue">{s}</Tag> },
                    { title: '原因', dataIndex: 'reason' },
                  ]}
                />
              </Card>
            ),
          },
          {
            key: 'in',
            label: `装机未出库（${result.installedNotOut.length}）`,
            children: (
              <Card className="gb-panel" size="small" title={<span><ImportOutlined /> 台站在装、装备库无有效出库单</span>}>
                <Table
                  rowKey="serialNo"
                  size="small"
                  className="gb-table-compact"
                  dataSource={result.installedNotOut}
                  pagination={false}
                  rowClassName={() => 'gb-row-danger'}
                  columns={[
                    { title: '序列号', dataIndex: 'serialNo', className: 'gb-mono', width: 190 },
                    { title: '台站码', dataIndex: 'stationCode', width: 90, className: 'gb-mono' },
                    { title: '安装位', dataIndex: 'slotCode', width: 140, className: 'gb-mono' },
                    { title: '安装日期', dataIndex: 'installDate', width: 110, className: 'gb-mono' },
                    { title: '已填单号', dataIndex: 'outboundNo', width: 160, className: 'gb-mono', render: (v: string) => v || <Tag color="red">空</Tag> },
                    { title: '原因', dataIndex: 'reason' },
                  ]}
                />
              </Card>
            ),
          },
          {
            key: 'legacy',
            label: `旧数据补不出单号（${result.legacyMissingOrder.length}）`,
            children: (
              <Card className="gb-panel" size="small" title="旧数据无出库单号，升级按台站码 + 安装日期未能唯一匹配">
                <Table
                  rowKey="installId"
                  size="small"
                  className="gb-table-compact"
                  dataSource={result.legacyMissingOrder}
                  pagination={false}
                  columns={[
                    { title: '序列号', dataIndex: 'serialNo', className: 'gb-mono', width: 190 },
                    { title: '台站码', dataIndex: 'stationCode', width: 90, className: 'gb-mono' },
                    { title: '安装位', dataIndex: 'slotCode', width: 140, className: 'gb-mono' },
                    { title: '安装日期', dataIndex: 'installDate', width: 110, className: 'gb-mono' },
                    { title: '说明', dataIndex: 'reason' },
                    {
                      title: '人工补录',
                      width: 120,
                      render: (_: unknown, row) => (
                        <Button
                          size="small"
                          type="primary"
                          onClick={() => {
                            setFixTarget({ installId: row.installId, serialNo: row.serialNo });
                            setFixNo('');
                          }}
                        >
                          补单号
                        </Button>
                      ),
                    },
                  ]}
                />
              </Card>
            ),
          },
          {
            key: 'recycle',
            label: `旧机回收（${result.removedPendingRecycle.length}）`,
            children: (
              <Card className="gb-panel" size="small" title="已拆卸旧机回收跟踪（只重试台站侧，出库单不回退）">
                <Table
                  rowKey="removalId"
                  size="small"
                  className="gb-table-compact"
                  dataSource={result.removedPendingRecycle}
                  pagination={false}
                  columns={[
                    { title: '旧机序列号', dataIndex: 'serialNo', className: 'gb-mono', width: 190 },
                    { title: '台站码', dataIndex: 'stationCode', width: 90, className: 'gb-mono' },
                    { title: '安装位', dataIndex: 'slotCode', width: 140, className: 'gb-mono' },
                    { title: '拆卸日期', dataIndex: 'removeDate', width: 110, className: 'gb-mono' },
                    { title: '回收', dataIndex: 'recycle', width: 100, render: (s: string) => <Tag color={recycleTone(s as never)}>{s}</Tag> },
                    { title: '已重试', dataIndex: 'retryCount', width: 80, className: 'gb-mono', render: (n: number) => `${n} 次` },
                    { title: '失败原因', dataIndex: 'lastError', ellipsis: true, render: (v: string) => v || <span className="gb-hint">—</span> },
                    {
                      title: '台站侧重试',
                      width: 180,
                      render: (_: unknown, row) => (
                        <Space size={6}>
                          <Button size="small" type="primary" onClick={() =>
                            void dispatch(retryRecycle({ removalId: row.removalId, result: '回收成功' }))
                              .then(() => message.success('回收成功（出库单不动）'))
                          }>
                            <CheckCircleOutlined /> 成功
                          </Button>
                          <Button size="small" danger onClick={() =>
                            void dispatch(retryRecycle({ removalId: row.removalId, result: '回收失败', error: '再次交库失败' }))
                              .then(() => message.info('已记录一次失败重试'))
                          }>
                            <CloseCircleOutlined /> 记失败
                          </Button>
                        </Space>
                      ),
                    },
                  ]}
                />
              </Card>
            ),
          },
        ]}
      />

      <Modal
        open={fixTarget !== null}
        title={`补录历史出库单号 · ${fixTarget?.serialNo ?? ''}`}
        onCancel={() => setFixTarget(null)}
        onOk={() => void submitFix()}
        okText="补录"
        destroyOnClose
      >
        <Form layout="vertical">
          <Form.Item label="出库单号" required>
            <Input
              className="gb-mono"
              list="gb-outbound-candidates"
              value={fixNo}
              onChange={(e) => setFixNo(e.target.value)}
              placeholder="如 CK-20210418-101"
            />
            <datalist id="gb-outbound-candidates">
              {candidateOrders.map((no) => (
                <option key={no} value={no} />
              ))}
            </datalist>
          </Form.Item>
          <p className="gb-hint">补录需填写一张真实存在的出库单号；补录后该记录标记为「升级回填」并移出待补清单。</p>
        </Form>
      </Modal>
    </div>
  );
}
