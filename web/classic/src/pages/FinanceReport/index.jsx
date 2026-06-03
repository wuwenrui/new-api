/*
Copyright (C) 2025 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from '@douyinfe/semi-ui';
import { RefreshCw, TrendingUp, WalletCards } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getFinanceReport } from '../../helpers/api';
import {
  formatFinanceAmount,
  formatFinancePercent,
  getFinanceCurrencyConfig,
} from '../../helpers/financeReport';

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function toInputValue(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toTimestamp(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 0;
  return Math.floor(time / 1000);
}

const metricTone = {
  revenue: 'bg-emerald-50 text-emerald-700',
  cost: 'bg-sky-50 text-sky-700',
  profit: 'bg-amber-50 text-amber-700',
  cash: 'bg-slate-50 text-slate-700',
};

function MetricCard({ title, value, hint, tone }) {
  return (
    <Card className='!rounded-lg border-0 shadow-sm'>
      <div className='flex items-start justify-between gap-3'>
        <div>
          <div className='text-sm text-gray-500'>{title}</div>
          <div className='mt-2 text-2xl font-semibold tracking-normal'>
            {value}
          </div>
          {hint ? (
            <div className='mt-1 text-xs text-gray-400'>{hint}</div>
          ) : null}
        </div>
        <div className={`rounded-lg p-2 ${tone}`}>
          <TrendingUp size={18} />
        </div>
      </div>
    </Card>
  );
}

const FinanceReport = () => {
  const { t } = useTranslation();
  const currency = getFinanceCurrencyConfig();
  const today = useMemo(() => startOfToday(), []);
  const [startTime, setStartTime] = useState(toInputValue(today));
  const [endTime, setEndTime] = useState(toInputValue(addDays(today, 1)));
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);

  const loadReport = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getFinanceReport({
        start_timestamp: toTimestamp(startTime),
        end_timestamp: toTimestamp(endTime),
      });
      setReport(data);
    } finally {
      setLoading(false);
    }
  }, [startTime, endTime]);

  useEffect(() => {
    loadReport();
  }, [loadReport]);

  const summary = report?.summary || {};
  const modelColumns = [
    { title: t('模型'), dataIndex: 'model_name' },
    { title: t('请求数'), dataIndex: 'requests', width: 90 },
    {
      title: t('收入'),
      dataIndex: 'consumption_amount',
      render: (value) => formatFinanceAmount(value, currency),
    },
    {
      title: t('支出'),
      dataIndex: 'estimated_upstream_cost',
      render: (value) => formatFinanceAmount(value, currency),
    },
    {
      title: t('盈利'),
      dataIndex: 'gross_profit',
      render: (value) => (
        <span className={Number(value) < 0 ? 'text-red-500' : 'text-green-600'}>
          {formatFinanceAmount(value, currency)}
        </span>
      ),
    },
    {
      title: t('毛利率'),
      dataIndex: 'gross_margin',
      render: (value) => formatFinancePercent(value),
    },
  ];
  const userColumns = [
    { title: t('用户'), dataIndex: 'username' },
    { title: t('请求数'), dataIndex: 'requests', width: 90 },
    {
      title: t('收入'),
      dataIndex: 'consumption_amount',
      render: (value) => formatFinanceAmount(value, currency),
    },
    {
      title: t('盈利'),
      dataIndex: 'gross_profit',
      render: (value) => formatFinanceAmount(value, currency),
    },
    {
      title: t('毛利率'),
      dataIndex: 'gross_margin',
      render: (value) => formatFinancePercent(value),
    },
  ];

  return (
    <div className='mt-[60px] px-2 pb-8'>
      <div className='mb-4 flex flex-col gap-3 rounded-lg border bg-white p-4 shadow-sm dark:bg-zinc-900 md:flex-row md:items-center md:justify-between'>
        <div>
          <Typography.Title heading={3} className='!mb-1'>
            {t('财务报表')}
          </Typography.Title>
          <Typography.Text type='secondary'>
            {t('按消费日志估算支出，现金收入单独展示')}
          </Typography.Text>
        </div>
        <Space wrap>
          <input
            className='h-8 rounded-md border px-2 text-sm dark:bg-zinc-950'
            type='datetime-local'
            value={startTime}
            onChange={(event) => setStartTime(event.target.value)}
          />
          <input
            className='h-8 rounded-md border px-2 text-sm dark:bg-zinc-950'
            type='datetime-local'
            value={endTime}
            onChange={(event) => setEndTime(event.target.value)}
          />
          <Button icon={<RefreshCw size={14} />} onClick={loadReport}>
            {t('刷新')}
          </Button>
        </Space>
      </div>

      <Spin spinning={loading}>
        <div className='mb-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4'>
          <MetricCard
            title={t('消费收入')}
            value={formatFinanceAmount(summary.consumption_amount, currency)}
            hint={`${summary.requests || 0} ${t('次请求')}`}
            tone={metricTone.revenue}
          />
          <MetricCard
            title={t('估算支出')}
            value={formatFinanceAmount(
              summary.estimated_upstream_cost,
              currency,
            )}
            hint={t('按分组倍率剥离')}
            tone={metricTone.cost}
          />
          <MetricCard
            title={t('消费盈利')}
            value={formatFinanceAmount(summary.gross_profit, currency)}
            hint={formatFinancePercent(summary.gross_margin)}
            tone={metricTone.profit}
          />
          <MetricCard
            title={t('现金收入')}
            value={formatFinanceAmount(summary.cash_income_amount, currency)}
            hint={`${t('充值')} ${formatFinanceAmount(summary.cash_topup_amount, currency)} · ${t('订阅')} ${formatFinanceAmount(summary.cash_subscription_amount, currency)}`}
            tone={metricTone.cash}
          />
        </div>

        <div className='grid grid-cols-1 gap-4 xl:grid-cols-3'>
          <Card
            className='!rounded-lg xl:col-span-2'
            title={
              <Space>
                <WalletCards size={16} />
                {t('模型盈利排行')}
              </Space>
            }
            headerExtraContent={
              <Tag color='blue' shape='circle'>
                {report?.models?.length || 0} {t('个模型')}
              </Tag>
            }
          >
            <Table
              size='small'
              rowKey='model_name'
              columns={modelColumns}
              dataSource={report?.models || []}
              pagination={false}
            />
          </Card>
          <Card className='!rounded-lg' title={t('用户贡献排行')}>
            <Table
              size='small'
              rowKey='username'
              columns={userColumns}
              dataSource={report?.users || []}
              pagination={false}
            />
          </Card>
        </div>
      </Spin>
    </div>
  );
};

export default FinanceReport;
