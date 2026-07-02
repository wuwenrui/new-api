/*
Copyright (C) 2023-2026 QuantumNous

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
import { Maximize2, Minimize2, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { upstreamCostInUSD, upstreamCostOutUSD } from '../../lib/newapi-onboard-pricing'
import type { NewAPIProbeModel } from '../../types'
import type { NewAPIOnboardController } from '../../hooks/use-newapi-onboard'

type Props = { ctl: NewAPIOnboardController }

export function NewAPIOnboardSelectStep({ ctl }: Props) {
  const { t } = useTranslation()

  const renderSaleInput = (
    m: NewAPIProbeModel,
    field: 'in' | 'out',
    usd: number,
    overridden: boolean
  ) => (
    <Input
      type='number'
      step='0.001'
      min='0'
      className={cn(
        'border-primary/40 bg-primary/5 h-7 w-24 text-right font-mono text-xs font-semibold',
        overridden && 'border-amber-500 bg-amber-100/70 dark:bg-amber-950'
      )}
      value={ctl.saleDisplayValue(usd)}
      onChange={(e) =>
        ctl.setSaleOverrideField(m.model_name, field, e.target.value)
      }
    />
  )

  const renderModelRow = (m: NewAPIProbeModel, group: string) => {
    const isSel = ctl.selectedModels.has(m.model_name)
    const gr = ctl.groupRatio[group] ?? 1
    const costIn = upstreamCostInUSD(m, gr)
    const costOut = upstreamCostOutUSD(m, gr)
    const sIn = ctl.saleInUSD(m)
    const sOut = ctl.saleOutUSD(m)
    const override = ctl.saleOverrides[m.model_name]
    const margin = ctl.marginPercent(
      sIn,
      upstreamCostInUSD(m, ctl.baseGroupRatioFor(m))
    )
    return (
      <TableRow
        key={`${group}:${m.model_name}`}
        className={cn('cursor-pointer', isSel && 'bg-primary/5')}
        onClick={() => ctl.toggleModel(m.model_name)}
      >
        <TableCell onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={isSel}
            onCheckedChange={() => ctl.toggleModel(m.model_name)}
          />
        </TableCell>
        <TableCell className='font-mono text-xs'>
          {m.model_name}
          {(m.supported_endpoint_types ?? []).includes('anthropic') && (
            <Badge variant='outline' className='ml-2'>
              anthropic
            </Badge>
          )}
          {m.quota_type === 1 && (
            <Badge variant='secondary' className='ml-2'>
              {t('per-call')}
            </Badge>
          )}
        </TableCell>
        <TableCell className='text-muted-foreground text-right text-xs'>
          {m.quota_type === 1
            ? `$${m.model_price}`
            : `${m.model_ratio} / ${m.completion_ratio || '-'}`}
        </TableCell>
        <TableCell className='text-right font-medium'>
          {ctl.fmtCost(costIn)}
        </TableCell>
        <TableCell className='text-right font-medium'>
          {costOut === null ? '-' : ctl.fmtCost(costOut)}
        </TableCell>
        <TableCell
          className='bg-primary/[0.03] text-right'
          onClick={(e) => e.stopPropagation()}
        >
          {renderSaleInput(m, 'in', sIn, override?.in !== undefined)}
        </TableCell>
        <TableCell
          className='bg-primary/[0.03] text-right'
          onClick={(e) => e.stopPropagation()}
        >
          {sOut === null ? (
            <span className='text-muted-foreground'>-</span>
          ) : (
            renderSaleInput(m, 'out', sOut, override?.out !== undefined)
          )}
        </TableCell>
        <TableCell className='text-right'>
          {margin !== null && (
            <span
              className={cn(
                'text-xs',
                margin >= 0
                  ? 'text-green-600 dark:text-green-500'
                  : 'text-red-600 dark:text-red-500'
              )}
            >
              {margin >= 0 ? '+' : ''}
              {margin.toFixed(0)}%
            </span>
          )}
        </TableCell>
      </TableRow>
    )
  }

  const renderGroupSection = (
    group: string,
    vendorModels: NewAPIProbeModel[]
  ) => {
    const models = ctl.modelsOfGroup(group, vendorModels)
    if (models.length === 0) return null
    return (
      <div key={group} className='overflow-hidden rounded-md border'>
        <div className='bg-muted/60 flex flex-wrap items-center gap-2 px-3 py-1.5'>
          <span className='text-sm font-semibold'>{group}</span>
          <Badge variant='secondary'>x{ctl.groupRatio[group] ?? 1}</Badge>
          {group === ctl.billingGroup && <Badge>{t('Billing group')}</Badge>}
          <span className='text-muted-foreground max-w-72 truncate text-xs'>
            {ctl.usableGroup[group] || ''}
          </span>
          <span className='text-muted-foreground ml-auto text-xs'>
            {t('{{count}} models', { count: models.length })}
          </span>
          <Button
            variant='outline'
            size='sm'
            className='h-6 px-2 text-xs'
            onClick={() => ctl.selectAllInGroup(group, vendorModels)}
          >
            {t('Select all in group')}
          </Button>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className='w-10' />
              <TableHead>{t('Model')}</TableHead>
              <TableHead className='text-right'>
                {t('Upstream ratios')}
              </TableHead>
              <TableHead className='text-right'>
                {t('Cost input /1M')}
              </TableHead>
              <TableHead className='text-right'>
                {t('Cost output /1M')}
              </TableHead>
              <TableHead className='bg-primary/[0.03] text-right'>
                {t('Sale input /1M')}
              </TableHead>
              <TableHead className='bg-primary/[0.03] text-right'>
                {t('Sale output /1M')}
              </TableHead>
              <TableHead className='text-right'>{t('Margin')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>{models.map((m) => renderModelRow(m, group))}</TableBody>
        </Table>
      </div>
    )
  }

  const renderVendorSection = (vendor: {
    name: string
    models: NewAPIProbeModel[]
  }) => {
    const visibleGroups = ctl.upstreamGroups.filter(
      (g) =>
        !ctl.hiddenGroups.has(g) &&
        ctl.modelsOfGroup(g, vendor.models).length > 0
    )
    if (visibleGroups.length === 0) return null
    const selectedCount = vendor.models.filter((m) =>
      ctl.selectedModels.has(m.model_name)
    ).length
    return (
      <div key={vendor.name || 'other'} className='space-y-2'>
        <div className='flex items-center gap-2 border-b pb-1'>
          <span className='text-base font-bold'>
            {vendor.name || t('Other vendors')}
          </span>
          <span className='text-muted-foreground text-xs'>
            {t('{{count}} models', { count: vendor.models.length })}
          </span>
          {selectedCount > 0 && (
            <Badge variant='secondary'>
              {t('{{count}} selected', { count: selectedCount })}
            </Badge>
          )}
        </div>
        {visibleGroups.map((g) => renderGroupSection(g, vendor.models))}
      </div>
    )
  }

  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-3'>
        <div className='flex items-center gap-2'>
          <Label className='shrink-0'>{t('Billing group')}</Label>
          <Select
            value={ctl.billingGroup}
            onValueChange={(v) => {
              if (v) {
                ctl.setBillingGroup(v)
                ctl.setSaleOverrides({})
              }
            }}
          >
            <SelectTrigger className='w-60'>
              <SelectValue>{ctl.billingGroup}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {ctl.upstreamGroups.map((g) => (
                <SelectItem key={g} value={g}>
                  <span className='flex items-center gap-2'>
                    <span>{g}</span>
                    <Badge variant='secondary'>
                      x{ctl.groupRatio[g] ?? 1}
                    </Badge>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Tooltip>
            <TooltipTrigger
              render={
                <span className='text-muted-foreground cursor-help text-xs underline decoration-dotted'>
                  ?
                </span>
              }
            />
            <TooltipContent className='max-w-72'>
              {t(
                'The relay token must belong to this group. Models picked outside it are still billed by this group upstream, so their real cost may differ.'
              )}
            </TooltipContent>
          </Tooltip>
        </div>
        <div className='flex items-center gap-2'>
          <Label htmlFor='newapi-markup' className='shrink-0'>
            {t('Global markup')}
          </Label>
          <Input
            id='newapi-markup'
            className='h-8 w-20'
            value={ctl.markupInput}
            onChange={(e) => {
              ctl.setMarkupInput(e.target.value)
              ctl.setSaleOverrides({})
            }}
          />
        </div>
        <div className='relative min-w-44 flex-1'>
          <Search className='text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2' />
          <Input
            placeholder={t('Search models...')}
            value={ctl.searchKeyword}
            onChange={(e) => ctl.setSearchKeyword(e.target.value)}
            className='h-8 pl-9'
          />
        </div>
        <Button
          variant='outline'
          size='sm'
          className='h-8'
          onClick={() => ctl.setMaximized(!ctl.maximized)}
        >
          {ctl.maximized ? (
            <Minimize2 className='h-4 w-4' />
          ) : (
            <Maximize2 className='h-4 w-4' />
          )}
        </Button>
      </div>

      <div className='bg-muted/50 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border px-3 py-1.5 text-xs'>
        <span className='flex items-center gap-1'>
          {t('Currency')}
          <span className='ml-1 inline-flex overflow-hidden rounded-md border'>
            {(['USD', 'CNY'] as const).map((c) => (
              <button
                key={c}
                type='button'
                onClick={() => ctl.setCurrency(c)}
                className={cn(
                  'px-2 py-0.5',
                  ctl.currency === c
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-transparent'
                )}
              >
                {c === 'USD' ? '$' : '¥'}
              </button>
            ))}
          </span>
        </span>
        <span className='text-muted-foreground'>
          {t('Upstream rate: 1$ = ¥{{rate}} (display: {{type}})', {
            rate: ctl.upstreamRate,
            type: ctl.probeResult?.rate_info?.quota_display_type || 'USD',
          })}
        </span>
        <span className='text-muted-foreground'>
          {t('Our rate: 1$ = ¥{{rate}}', { rate: ctl.ourRate })}
        </span>
        <span className='text-muted-foreground'>
          {t('Our group ratio: x{{ratio}} (already included in sale price)', {
            ratio: ctl.siteGroupRatio,
          })}
        </span>
      </div>

      <div className='flex flex-wrap gap-1.5'>
        {ctl.upstreamGroups.map((g) => {
          const visible = !ctl.hiddenGroups.has(g)
          return (
            <button
              key={g}
              type='button'
              onClick={() => ctl.toggleHiddenGroup(g)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs transition-colors',
                visible
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : 'text-muted-foreground bg-transparent'
              )}
            >
              {visible ? '✓ ' : ''}
              {g} <span className='opacity-70'>x{ctl.groupRatio[g] ?? 1}</span>
            </button>
          )
        })}
      </div>

      <div
        className={cn(
          'space-y-4 overflow-y-auto pr-1',
          ctl.maximized ? 'max-h-[62vh]' : 'max-h-96'
        )}
      >
        {ctl.vendorSections.map((v) => renderVendorSection(v))}
      </div>

      <div className='bg-muted/50 flex flex-wrap items-center gap-4 rounded-lg border p-3 text-sm'>
        <span>
          {t('{{n}} model(s) selected', { n: ctl.selectedModels.size })}
        </span>
        <span className='text-muted-foreground text-xs'>
          {t(
            'Sale price is the FINAL end-user price (our group ratio included); edited prices are highlighted'
          )}
        </span>
      </div>
    </div>
  )
}
