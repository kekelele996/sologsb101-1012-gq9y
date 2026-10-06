/**
 * 序列号对账（/reconcile）：装备库出库单 × 台站安装位按序列号核对。
 * 三类差异各自单列：出了库没装上台站、装了又没出库、旧数据补号失败；
 * 补号异常支持人工补单号解除。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  Modal,
  Row,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  DisconnectOutlined,
  ExportOutlined,
  ImportOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import StatBadge from '@/components/common/StatBadge';
import EmptyPanel from '@/components/common/EmptyPanel';
import { useReconcile } from '@/hooks/useReconcile';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { resolveMigrationIssue } from '@/stores/opsSlice';
import { selectStations } from '@/stores/arraySlice';
import type { MigrationIssue } from '@/types/migration';
import type { InstallRecord } from '@/types/install';
import type { OutboundOrder } from '@/types/outbound';

function useStationMeta() {
  const stations = useAppSelector(selectStations);
  return useMemo(() => {
    const map = new Map<string, string>();
    stations.forEach((station) => map.set(station.code, station.arrayId));
    return map;
  }, [stations]);
}

export default function ReconcilePage() {
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();
  const report = useReconcile();
  const stationArrayId = useStationMeta();
  const arrays = useAppSelector((state) => state.array.arrays);

  const [issueTarget, setIssueTarget] = useState<MigrationIssue | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<{ outboundNo: string; note: string }>();

  const arrayNameOf = (stationCode: string): string => {
    const arrayId = stationArrayId.get(stationCode);
    return arrays.find((array) => array.id === arrayId)?.name ?? '—';
  };

  const openResolve = (issue: MigrationIssue) => {
    setIssueTarget(issue);
    form.setFieldsValue({ outboundNo: '', note: '' });
  };

  const submitResolve = async () => {
    if (!issueTarget) return;
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      await dispatch(
        resolveMigrationIssue({ issueId: issueTarget.id, outboundNo: values.outboundNo.trim(), note: values.note })
      ).unwrap();
      message.success('已补录出库单号，异常解除');
      setIssueTarget(null);
    } catch (error) {
      message.error(typeof error === 'string' ? error : '补录失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="gb-brand-bar" />

      <div>
        <Typography.Title level={4} style={{ margin: '0 0 4px', color: '#1e3a5f' }}>
          序列号对账 · 装备库 × 台站班组
        </Typography.Title>
        <p className="gb-hint">
          以序列号为唯一键核对两侧台账：装备库已领用出库的、台站安装位上在用的，逐台比对。
          差异不可就地抹平，必须回到各自页面按流程处理，本页只做单列与指引。
        </p>
      </div>

      <div className="gb-stats-row">
        <StatBadge label="序列号对得上" value={report.matchedCount} suffix="台" tone="success"
          tip="出库单已领用且台站安装位在用" />
        <StatBadge label="出了库没装上" value={report.shippedNotInstalled.length} suffix="台"
          tone={report.shippedNotInstalled.length > 0 ? 'danger' : 'success'} />
        <StatBadge label="装了没出库" value={report.installedNotShipped.length} suffix="台"
          tone={report.installedNotShipped.length > 0 ? 'warning' : 'success'} />
        <StatBadge label="旧数据补号失败" value={report.legacyFillIssues.length} suffix="条"
          tone={report.legacyFillIssues.length > 0 ? 'danger' : 'success'} />
      </div>

      {report.discrepancyCount === 0 ? (
        <Alert
          type="success"
          showIcon
          icon={<CheckCircleOutlined />}
          message="两边序列号全部对得上"
          description="装备库已出库的序列号都装在台站安装位上，台站在位的序列号也都有未退库的出库单。"
        />
      ) : (
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          message={`共 ${report.discrepancyCount} 处差异待处理`}
          description="差异分三类列在下方；撤回领用与旧机回收失败属于流程中间态，装备库单据与台站登记各自保留，不强行对齐。"
        />
      )}

      <Row gutter={12}>
        <Col xs={24} xl={12}>
          <Card
            size="small"
            className="gb-panel"
            title={
              <Space>
                <ExportOutlined style={{ color: '#c0392b' }} />
                出了库没装上台站（{report.shippedNotInstalled.length}）
              </Space>
            }
          >
            {report.shippedNotInstalled.length === 0 ? (
              <EmptyPanel
                title="无此类差异"
                description="所有已领用出库的序列号都已登记安装位。"
                compact
              />
            ) : (
              <Table
                rowKey={(row) => row.order.id}
                size="small"
                className="gb-table-compact"
                dataSource={report.shippedNotInstalled}
                pagination={false}
                columns={[
                  {
                    title: '出库单',
                    width: 170,
                    render: (_: unknown, row) => (
                      <div>
                        <div className="gb-mono">{row.order.orderNo}</div>
                        <div className="gb-hint">{row.order.outboundDate}</div>
                      </div>
                    ),
                  },
                  { title: '序列号', dataIndex: ['order', 'serialNo'], className: 'gb-mono', width: 180 },
                  { title: '领用台站', dataIndex: ['order', 'stationCode'], width: 90, className: 'gb-mono' },
                  { title: '用途', dataIndex: ['order', 'purpose'], ellipsis: true },
                  {
                    title: '处理指引',
                    width: 180,
                    render: () => (
                      <span className="gb-hint">
                        班组到「台站运维」补登记安装位；若未实际使用，按撤回领用 + 装备库退库放回在库。
                      </span>
                    ),
                  },
                ]}
              />
            )}
          </Card>
        </Col>

        <Col xs={24} xl={12}>
          <Card
            size="small"
            className="gb-panel"
            title={
              <Space>
                <ImportOutlined style={{ color: '#d68910' }} />
                装了又没出库（{report.installedNotShipped.length}）
              </Space>
            }
          >
            {report.installedNotShipped.length === 0 ? (
              <EmptyPanel title="无此类差异" description="所有在位序列号都有已领用（未退库）的出库单。" compact />
            ) : (
              <Table
                rowKey={(row) => row.install.id}
                size="small"
                className="gb-table-compact"
                dataSource={report.installedNotShipped}
                pagination={false}
                columns={[
                  {
                    title: '安装位',
                    width: 140,
                    render: (_: unknown, row: { install: InstallRecord }) => (
                      <div>
                        <div className="gb-mono">{row.install.stationCode}</div>
                        <div className="gb-hint">{row.install.slot}</div>
                      </div>
                    ),
                  },
                  { title: '序列号', dataIndex: ['install', 'serialNo'], className: 'gb-mono', width: 180 },
                  {
                    title: '安装日期',
                    dataIndex: ['install', 'installDate'],
                    width: 110,
                    className: 'gb-mono',
                  },
                  {
                    title: '现状',
                    width: 130,
                    render: (_: unknown, row: { install: InstallRecord; openOrder: OutboundOrder | null }) =>
                      row.install.outboundNo ? (
                        <Tag>{`单号 ${row.install.outboundNo}`}</Tag>
                      ) : row.openOrder ? (
                        <Tag color="orange">单据已开立待领用</Tag>
                      ) : (
                        <Tag color="red">无出库单</Tag>
                      ),
                  },
                  {
                    title: '处理指引',
                    render: () => (
                      <span className="gb-hint">
                        到「装备库」补开出库单并确认领用；已开立未领用的单据直接在「台站运维」领用安装。
                      </span>
                    ),
                  },
                ]}
              />
            )}
          </Card>
        </Col>
      </Row>

      <Card
        size="small"
        className="gb-panel"
        title={
          <Space>
            <DisconnectOutlined style={{ color: '#c0392b' }} />
            旧数据补号失败（{report.legacyFillIssues.length}）
          </Space>
        }
      >
        {report.legacyFillIssues.length === 0 ? (
          <EmptyPanel title="无补号异常" description="历史安装数据均已按台站码 + 安装日期补出出库单号。" compact />
        ) : (
          <Table
            rowKey="id"
            size="small"
            className="gb-table-compact"
            dataSource={report.legacyFillIssues}
            pagination={false}
            columns={[
              { title: '序列号', dataIndex: 'serialNo', className: 'gb-mono', width: 200 },
              { title: '台站码', dataIndex: 'stationCode', width: 100, className: 'gb-mono' },
              {
                title: '安装日期',
                dataIndex: 'installDate',
                width: 120,
                className: 'gb-mono',
                render: (value: string) => value || <Tag color="red">缺失</Tag>,
              },
              { title: '缺失原因', dataIndex: 'reason', ellipsis: true },
              {
                title: '操作',
                width: 150,
                render: (_: unknown, row: MigrationIssue) => (
                  <Button size="small" type="primary" onClick={() => openResolve(row)}>
                    人工补单号
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Card
        size="small"
        className="gb-panel"
        title={
          <Space>
            <CheckCircleOutlined style={{ color: '#1e8449' }} />
            序列号对得上（{report.matched.length}）
          </Space>
        }
      >
        <Table
          rowKey={(row) => row.order.id}
          size="small"
          className="gb-table-compact"
          dataSource={report.matched}
          pagination={{ pageSize: 5, showSizeChanger: false }}
          columns={[
            { title: '出库单号', dataIndex: ['order', 'orderNo'], className: 'gb-mono', width: 180 },
            { title: '序列号', dataIndex: ['order', 'serialNo'], className: 'gb-mono', width: 190 },
            {
              title: '台站 / 台阵',
              width: 180,
              render: (_: unknown, row) => (
                <div>
                  <div className="gb-mono">{row.install.stationCode} / {row.install.slot}</div>
                  <div className="gb-hint">{arrayNameOf(row.install.stationCode)}</div>
                </div>
              ),
            },
            { title: '出库日期', dataIndex: ['order', 'outboundDate'], width: 110, className: 'gb-mono' },
            { title: '安装日期', dataIndex: ['install', 'installDate'], width: 110, className: 'gb-mono' },
            {
              title: '校验',
              width: 90,
              render: () => (
                <Tag color="green" style={{ marginInlineEnd: 0 }}>
                  <CheckCircleOutlined /> 一致
                </Tag>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        open={issueTarget !== null}
        title={`人工补出库单号 · ${issueTarget?.serialNo || '序列号缺失'}`}
        onCancel={() => setIssueTarget(null)}
        onOk={() => void submitResolve()}
        confirmLoading={submitting}
        okText="补录并解除异常"
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={issueTarget?.reason}
          description="补录的单号必须在装备库已存在，且序列号与异常记录一致；处理后安装登记回填单号，异常单列解除。"
        />
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="outboundNo" label="出库单号" rules={[{ required: true, message: '请输入已有出库单号' }]}>
            <Input placeholder="CK-YYYYMMDD-NNN" maxLength={40} />
          </Form.Item>
          <Form.Item name="note" label="处理说明">
            <Input.TextArea rows={2} maxLength={100} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
