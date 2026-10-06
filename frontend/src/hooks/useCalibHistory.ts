/**
 * useCalibHistory：按仪器聚合历次标定、算灵敏度变化量与待标定天数。
 * 被标定记录台（/calibrations）与更换提醒页（/replacements）消费。
 */
import { useCallback, useMemo } from 'react';
import { useSelector } from 'react-redux';
import { selectArrays, selectStations } from '@/stores/arraySlice';
import { selectInstruments } from '@/stores/instrumentSlice';
import { selectCalibrations } from '@/stores/calibrationSlice';
import { selectActiveInstalls } from '@/stores/opsSlice';
import { calibrateDueText, sensitivityDelta, type SensitivityDelta } from '@/types/calibration';
import { CALIBRATION_CYCLE_DAYS, daysUntilDue } from '@/types/instrument';
import type { Calibration, ResponseVerdict } from '@/types/calibration';
import type { Instrument } from '@/types/instrument';

/** 单台仪器的标定历史聚合 */
export interface InstrumentCalibHistory {
  instrument: Instrument;
  stationCode: string;
  arrayId: string;
  arrayName: string;
  /** 历次标定（按日期降序） */
  calibrations: Calibration[];
  /** 最近一次标定 */
  latest: Calibration | null;
  /** 最近一次灵敏度相对上一次的变化 */
  delta: SensitivityDelta;
  /** 标定次数 */
  count: number;
  /** 距下次标定天数（负数为已超期） */
  dueInDays: number;
  /** 是否超期未标定 */
  overdue: boolean;
  /** 是否处于待标定状态 */
  pending: boolean;
  /** 是否仍装在台站安装位上（拆下来的旧机不进超期名单） */
  installed: boolean;
  /** 历次结论中最差的一次 */
  worstVerdict: ResponseVerdict;
  /** 灵敏度序列（由旧到新），供趋势展示 */
  trend: Array<{ date: string; sensitivity: number; selfNoise: number }>;
}

export interface UseCalibHistoryResult {
  histories: InstrumentCalibHistory[];
  historyOf: (instrumentId: string) => InstrumentCalibHistory | null;
  overdueHistories: InstrumentCalibHistory[];
  /** 灵敏度趋势：返回指定仪器的序列 */
  trendOf: (instrumentId: string) => Array<{ date: string; sensitivity: number; selfNoise: number }>;
}

const VERDICT_ORDER: Record<ResponseVerdict, number> = { 合格: 0, 待判定: 1, 不合格: 2 };

/**
 * 组合式 Hook：基于 Redux 中的台阵 / 台站 / 仪器 / 标定数据派生标定历史与超期提醒。
 */
export function useCalibHistory(): UseCalibHistoryResult {
  const arrays = useSelector(selectArrays);
  const stations = useSelector(selectStations);
  const instruments = useSelector(selectInstruments);
  const calibrations = useSelector(selectCalibrations);
  const activeInstalls = useSelector(selectActiveInstalls);

  /** 仍在安装位上的序列号集合（含旧数据迁移出来的安装登记） */
  const installedSerials = useMemo(() => {
    const set = new Set<string>();
    activeInstalls.forEach((row) => {
      const serial = row.serialNo.trim();
      if (serial) set.add(serial);
    });
    return set;
  }, [activeInstalls]);

  const histories = useMemo<InstrumentCalibHistory[]>(() => {
    return instruments
      .map((instrument) => {
        const station = stations.find((item) => item.id === instrument.stationId);
        const array = station ? arrays.find((item) => item.id === station.arrayId) : undefined;
        const rows = calibrations
          .filter((calibration) => calibration.instrumentId === instrument.id)
          .sort((a, b) => b.date.localeCompare(a.date));
        const latest = rows.length > 0 ? rows[0] : null;
        const previous = rows.length > 1 ? rows[1] : null;
        const delta = sensitivityDelta(latest?.sensitivity ?? 0, previous ? previous.sensitivity : null);
        const dueInDays = daysUntilDue(latest ? latest.date : null, instrument.installDate);
        const worstVerdict = rows.reduce<ResponseVerdict>((worst, row) => {
          return VERDICT_ORDER[row.responseVerdict] > VERDICT_ORDER[worst] ? row.responseVerdict : worst;
        }, '合格');
        // 已停用且不在安装位的是拆下旧机，不进超期名单；安装表有记录时以安装表为准
        const inSlot = installedSerials.has(instrument.serialNo.trim());
        const installed = instrument.state === '已停用' ? inSlot : true;
        const overdue = installed && dueInDays < 0;
        return {
          instrument,
          stationCode: station?.code ?? '未知台站',
          arrayId: array?.id ?? station?.arrayId ?? '',
          arrayName: array?.name ?? '未知台阵',
          calibrations: rows,
          latest,
          delta,
          count: rows.length,
          dueInDays,
          overdue,
          pending: installed && (instrument.state === '待标定' || dueInDays < 0),
          installed,
          worstVerdict,
          trend: [...rows]
            .reverse()
            .map((row) => ({ date: row.date, sensitivity: row.sensitivity, selfNoise: row.selfNoise })),
        };
      })
      .sort((a, b) => a.dueInDays - b.dueInDays);
  }, [arrays, calibrations, installedSerials, instruments, stations]);

  const historyOf = useCallback(
    (instrumentId: string): InstrumentCalibHistory | null =>
      histories.find((history) => history.instrument.id === instrumentId) ?? null,
    [histories]
  );

  const overdueHistories = useMemo(
    () => histories.filter((history) => history.overdue || history.pending),
    [histories]
  );

  const trendOf = useCallback(
    (instrumentId: string): Array<{ date: string; sensitivity: number; selfNoise: number }> =>
      histories.find((history) => history.instrument.id === instrumentId)?.trend ?? [],
    [histories]
  );

  return { histories, historyOf, overdueHistories, trendOf };
}

/** 标定周期说明文案，供页面提示 */
export const CALIBRATION_CYCLE_TEXT = `标定周期 ${CALIBRATION_CYCLE_DAYS} 天（约 1 年），超期仪器在更换提醒页高亮`;

/** 待标定天数文案 */
export function dueText(history: InstrumentCalibHistory): string {
  return calibrateDueText(history.dueInDays);
}
