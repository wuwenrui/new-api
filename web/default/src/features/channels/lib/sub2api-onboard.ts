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
import type {
  Cost,
  Model,
  ModelCost,
  Provider,
  ProviderMap,
} from '@opencode-ai/models'

import type {
  ModelsDevCostTier,
  ModelsDevTokenCost,
  NewAPIProbeModel,
  NewAPIProbeResult,
} from '../types'
import { RATIO_TO_USD_PER_MILLION } from './newapi-onboard-pricing'

export type Sub2APIProviderOption = {
  id: string
  name: string
  modelCount: number
}

type BuildSub2APIProbeInput = {
  providers: ProviderMap
  providerId: string
  baseUrl: string
  upstreamMultiplier: number
}

function isPricedTextModel(model: Model): model is Model & { cost: ModelCost } {
  return (
    model.modalities.output.includes('text') &&
    model.cost !== undefined &&
    Number.isFinite(model.cost.input) &&
    model.cost.input >= 0 &&
    Number.isFinite(model.cost.output) &&
    model.cost.output >= 0
  )
}

export function listSub2APIProviders(
  providers: ProviderMap
): Sub2APIProviderOption[] {
  return Object.values(providers)
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      modelCount: Object.values(provider.models).filter(isPricedTextModel)
        .length,
    }))
    .filter((provider) => provider.modelCount > 0)
    .sort((a, b) => a.name.localeCompare(b.name))
}

function tokenCost(cost: Cost): ModelsDevTokenCost {
  return {
    input: cost.input,
    output: cost.output,
    ...(cost.cache_read === undefined ? {} : { cache_read: cost.cache_read }),
    ...(cost.cache_write === undefined
      ? {}
      : { cache_write: cost.cache_write }),
    ...(cost.input_audio === undefined
      ? {}
      : { input_audio: cost.input_audio }),
    ...(cost.output_audio === undefined
      ? {}
      : { output_audio: cost.output_audio }),
  }
}

function costTiers(cost: ModelCost): ModelsDevCostTier[] {
  return (cost.tiers ?? [])
    .map((tier) => ({
      ...tokenCost(tier),
      context_threshold: tier.tier.size,
    }))
    .sort((a, b) => a.context_threshold - b.context_threshold)
}

function toProbeModel(
  provider: Provider,
  model: Model & { cost: ModelCost },
  upstreamMultiplier: number
): NewAPIProbeModel {
  const input = model.cost.input
  const completionRatio = input > 0 ? model.cost.output / input : 0
  const endpointTypes = provider.id === 'anthropic' ? ['anthropic'] : ['openai']

  return {
    model_name: model.id,
    vendor_id: 1,
    quota_type: 0,
    model_ratio: input / RATIO_TO_USD_PER_MILLION,
    model_price: 0,
    completion_ratio: completionRatio,
    cache_ratio: input > 0 ? (model.cost.cache_read ?? 0) / input : 0,
    create_cache_ratio: input > 0 ? (model.cost.cache_write ?? 0) / input : 0,
    image_ratio: 0,
    audio_ratio: input > 0 ? (model.cost.input_audio ?? 0) / input : 0,
    audio_completion_ratio:
      input > 0 ? (model.cost.output_audio ?? 0) / input : 0,
    enable_groups: [provider.id],
    supported_endpoint_types: endpointTypes,
    models_dev_pricing: {
      base: tokenCost(model.cost),
      tiers: costTiers(model.cost),
      upstream_multiplier: upstreamMultiplier,
    },
  }
}

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The upstream site address must use HTTP or HTTPS')
  }
  return url.toString().replace(/\/$/, '')
}

export function buildSub2APIProbeResult(
  input: BuildSub2APIProbeInput
): NewAPIProbeResult {
  if (
    !Number.isFinite(input.upstreamMultiplier) ||
    input.upstreamMultiplier <= 0
  ) {
    throw new Error('The upstream multiplier must be greater than 0')
  }
  const provider = input.providers[input.providerId]
  if (!provider) {
    throw new Error('Please select a model provider')
  }
  const models = Object.values(provider.models)
    .filter(isPricedTextModel)
    .map((model) => toProbeModel(provider, model, input.upstreamMultiplier))
    .sort((a, b) => a.model_name.localeCompare(b.model_name))
  if (models.length === 0) {
    throw new Error('This provider has no token-priced text models')
  }

  return {
    base_url: normalizeBaseUrl(input.baseUrl),
    models,
    group_ratio: { [provider.id]: input.upstreamMultiplier },
    usable_group: {
      [provider.id]: `${provider.name} · x${input.upstreamMultiplier}`,
    },
    vendors: [{ id: 1, name: provider.name, icon: '' }],
    rate_info: {
      quota_display_type: 'CNY',
      usd_exchange_rate: 1,
      price: 1,
    },
  }
}
