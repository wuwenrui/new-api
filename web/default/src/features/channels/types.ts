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
import { z } from 'zod'

// ============================================================================
// Channel Schema & Types
// ============================================================================

export const channelInfoSchema = z.object({
  is_multi_key: z.boolean().default(false),
  multi_key_size: z.number().default(0),
  multi_key_status_list: z.record(z.string(), z.number()).optional(),
  multi_key_disabled_reason: z.record(z.string(), z.string()).optional(),
  multi_key_disabled_time: z.record(z.string(), z.number()).optional(),
  multi_key_polling_index: z.number().default(0),
  multi_key_mode: z.enum(['random', 'polling']).default('random'),
})

export type ChannelInfo = z.infer<typeof channelInfoSchema>

export const channelSchema = z.object({
  id: z.number(),
  type: z.number(),
  key: z.string(),
  openai_organization: z.string().nullish(),
  test_model: z.string().nullish(),
  status: z.number(), // 1: enabled, 0: manual disabled, 2: auto disabled
  name: z.string(),
  weight: z.number().nullish(),
  created_time: z.number(),
  test_time: z.number(),
  response_time: z.number(), // in milliseconds
  base_url: z.string().nullish(),
  other: z.string().default(''),
  balance: z.number().default(0), // in USD
  balance_updated_time: z.number(),
  models: z.string().default(''),
  group: z.string().default('default'),
  used_quota: z.number().default(0),
  model_mapping: z.string().nullish(),
  status_code_mapping: z.string().nullish(),
  priority: z.number().nullish(),
  auto_ban: z.number().nullish(),
  other_info: z.string().default(''),
  tag: z.string().nullish(),
  setting: z.string().nullish(),
  param_override: z.string().nullish(),
  header_override: z.string().nullish(),
  remark: z.string().default(''),
  max_input_tokens: z.number().default(0),
  channel_info: channelInfoSchema.default({
    is_multi_key: false,
    multi_key_size: 0,
    multi_key_polling_index: 0,
    multi_key_mode: 'random',
  }),
  settings: z.string().default('{}'), // other_settings JSON
})

export type Channel = z.infer<typeof channelSchema>

// ============================================================================
// Channel Settings Types
// ============================================================================

export interface ChannelSettings {
  force_format?: boolean
  thinking_to_content?: boolean
  proxy?: string
  pass_through_body_enabled?: boolean
  system_prompt?: string
  system_prompt_override?: boolean
  http_protocol?: 'auto' | 'http1' | string
  http2_connection_shards?: number
}

export interface ChannelModelPrice {
  input: number
  output: number
  cache_read: number
  cache_write: number
}

export interface ChannelOtherSettings {
  azure_responses_version?: string
  vertex_key_type?: 'json' | 'api_key'
  openrouter_enterprise?: boolean
  aws_key_type?: 'ak_sk' | 'api_key'
  allow_service_tier?: boolean
  disable_store?: boolean
  allow_safety_identifier?: boolean
  allow_include_obfuscation?: boolean
  allow_inference_geo?: boolean
  allow_speed?: boolean
  claude_beta_query?: boolean
  disable_task_polling_sleep?: boolean
  pac_upstream_group?: string
  upstream_model_update_check_enabled?: boolean
  upstream_model_update_auto_sync_enabled?: boolean
  upstream_model_update_auto_remove_enabled?: boolean
  upstream_model_update_ignored_models?: string[]
  upstream_model_update_last_check_time?: number
  upstream_model_update_last_detected_models?: string[]
  advanced_custom?: AdvancedCustomConfig
  model_prices?: Record<string, ChannelModelPrice>
}

export interface AdvancedCustomConfig {
  advanced_routes?: AdvancedCustomRoute[]
}

export interface AdvancedCustomRoute {
  incoming_path?: string
  upstream_path?: string
  converter?: AdvancedCustomConverter
  models?: string[]
  auth?: AdvancedCustomRouteAuth
}

export interface AdvancedCustomRouteAuth {
  type?: AdvancedCustomAuthType
  name?: string
  value?: string
}

export type AdvancedCustomConverter =
  | 'none'
  | 'anthropic_messages_to_openai_chat_completions'
  | 'openai_chat_completions_to_anthropic_messages'
  | 'openai_chat_completions_to_openai_responses'
  | 'openai_responses_to_openai_chat_completions'
  | 'openai_responses_to_gemini_generate_content'
  | 'gemini_generate_content_to_openai_chat_completions'
  | 'openai_chat_completions_to_gemini_generate_content'

export type AdvancedCustomAuthType = 'none' | 'header' | 'query'

// ============================================================================
// API Response Types
// ============================================================================

export interface GetChannelsResponse {
  success: boolean
  message?: string
  data?: {
    items: Channel[]
    total: number
    page: number
    page_size: number
    type_counts?: Record<string, number>
  }
}

export interface SearchChannelsResponse {
  success: boolean
  message?: string
  data?: {
    items: Channel[]
    total: number
    type_counts?: Record<string, number>
  }
}

export interface GetChannelResponse {
  success: boolean
  message?: string
  data?: Channel
}

export interface ChannelOpsResponse {
  success: boolean
  message?: string
  data?: {
    retry_times: number
  }
}

export interface ChannelTestResponse {
  success: boolean
  message?: string
  error_code?: string
  time?: number
  data?: {
    response_time?: number
    error?: string
  }
}

export interface ChannelBalanceResponse {
  success: boolean
  message?: string
  balance?: number
  currency?: string
}

export interface FetchModelsResponse {
  success: boolean
  message?: string
  data?: string[]
}

export interface CopyChannelResponse {
  success: boolean
  message?: string
  data?: {
    id: number
  }
}

// ============================================================================
// Multi-Key Management Types
// ============================================================================

export interface KeyStatus {
  index: number
  status: number // 1: enabled, 2: manual disabled, 3: auto disabled
  disabled_time?: number
  reason?: string
  key_preview?: string
}

export type MultiKeyConfirmAction = {
  type:
    | 'enable'
    | 'disable'
    | 'delete'
    | 'enable-all'
    | 'disable-all'
    | 'delete-disabled'
  keyIndex?: number
}

export interface MultiKeyStatusResponse {
  success: boolean
  message?: string
  data?: {
    keys: KeyStatus[]
    total: number
    page: number
    page_size: number
    total_pages: number
    enabled_count: number
    manual_disabled_count: number
    auto_disabled_count: number
  }
}

// ============================================================================
// API Request Parameters
// ============================================================================

export type ChannelSortBy =
  | 'id'
  | 'name'
  | 'priority'
  | 'balance'
  | 'response_time'
  | 'test_time'

export type ChannelSortOrder = 'asc' | 'desc'

export interface GetChannelsParams {
  p?: number
  page_size?: number
  status?: string // 'enabled', 'disabled', or empty for all
  type?: number
  group?: string
  id_sort?: boolean
  tag_mode?: boolean
  sort_by?: ChannelSortBy
  sort_order?: ChannelSortOrder
}

export interface SearchChannelsParams {
  keyword?: string
  group?: string
  model?: string
  status?: string
  type?: number
  id_sort?: boolean
  tag_mode?: boolean
  sort_by?: ChannelSortBy
  sort_order?: ChannelSortOrder
  p?: number
  page_size?: number
}

export interface ChannelTestParams {
  test_model?: string
}

export interface CopyChannelParams {
  suffix?: string
  reset_balance?: boolean
}

export interface MultiKeyManageParams {
  channel_id: number
  action:
    | 'get_key_status'
    | 'disable_key'
    | 'enable_key'
    | 'enable_all_keys'
    | 'disable_all_keys'
    | 'delete_key'
    | 'delete_disabled_keys'
  key_index?: number
  page?: number
  page_size?: number
  status?: number // 1=enabled, 2=manual_disabled, 3=auto_disabled
}

export interface BatchDeleteParams {
  ids: number[]
}

export interface BatchSetTagParams {
  ids: number[]
  tag: string | null
}

export interface TagOperationParams {
  tag: string
  new_tag?: string
  priority?: number
  weight?: number
  model_mapping?: string
  models?: string
  groups?: string
}

// ============================================================================
// Form Data Types
// ============================================================================

export interface ChannelFormData {
  name: string
  type: number
  base_url: string
  key: string
  openai_organization?: string
  models: string
  group: string
  model_mapping?: string
  priority?: number
  weight?: number
  test_model?: string
  auto_ban?: number
  status: number
  status_code_mapping?: string
  tag?: string
  remark?: string
  setting?: string
  param_override?: string
  header_override?: string
  settings?: string
  other?: string
  // Multi-key specific
  multi_key_mode?: 'single' | 'batch' | 'multi_to_single'
  multi_key_type?: 'random' | 'polling'
  batch_add_set_key_prefix_2_name?: boolean
}

// ============================================================================
// Add Channel Request (special structure)
// ============================================================================

export interface AddChannelRequest {
  mode: 'single' | 'batch' | 'multi_to_single'
  multi_key_mode?: 'random' | 'polling'
  batch_add_set_key_prefix_2_name?: boolean
  channel: Partial<Channel>
}

// ============================================================================
// NewAPI Upstream Probe (onboard wizard)
// ============================================================================

export interface ModelsDevTokenCost {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
  input_audio?: number
  output_audio?: number
}

export interface ModelsDevCostTier extends ModelsDevTokenCost {
  context_threshold: number
}

export interface ModelsDevPricing {
  base: ModelsDevTokenCost
  tiers: ModelsDevCostTier[]
  upstream_multiplier: number
}

export interface NewAPIProbeModel {
  model_name: string
  vendor_id: number
  quota_type: number
  model_ratio: number
  model_price: number
  completion_ratio: number
  cache_ratio: number
  create_cache_ratio: number
  image_ratio: number
  audio_ratio: number
  audio_completion_ratio: number
  enable_groups: string[] | null
  supported_endpoint_types: string[] | null
  models_dev_pricing?: ModelsDevPricing
}

export interface NewAPIProbeRateInfo {
  quota_display_type: string
  usd_exchange_rate: number
  price: number
}

export interface NewAPIProbeVendor {
  id: number
  name: string
  icon: string
}

export interface NewAPIProbeResult {
  base_url: string
  models: NewAPIProbeModel[]
  group_ratio: Record<string, number> | null
  usable_group: Record<string, string> | null
  vendors: NewAPIProbeVendor[] | null
  rate_info: NewAPIProbeRateInfo | null
}

export interface NewAPIProbeRequest {
  base_url: string
  access_token?: string
  user_id?: string
}

export interface NewAPIProbeResponse {
  success: boolean
  message?: string
  data?: NewAPIProbeResult
}

// ============================================================================
// Channel Business Report (channel business overview)
// ============================================================================

/** 渠道内单个模型的区间经营数据（金额单位 USD，价格为 $/1M tokens） */
export interface ChannelBusinessModelRow {
  model_name: string
  requests: number
  revenue: number
  estimated_upstream_cost: number
  gross_profit: number
  gross_margin: number
  local_input_price: number
  local_output_price: number
  local_price_known: boolean
  upstream_input_price: number
  upstream_output_price: number
  cost_known: boolean
  cost_unknown_reason?: string
  price_changed: boolean
}

/** 单个渠道的区间经营数据（金额单位 USD） */
export interface ChannelBusinessRow {
  channel_id: number
  channel_name: string
  status: number
  balance: number
  used_quota_usd: number
  base_url: string
  local_group: string
  upstream_group: string
  requests: number
  revenue: number
  estimated_upstream_cost: number
  gross_profit: number
  gross_margin: number
  cost_known: boolean
  cost_partial: boolean
  cost_unknown_reason?: string
  price_changed: boolean
  low_balance: boolean
  top_models: ChannelBusinessModelRow[]
}

export interface ChannelBusinessReport {
  generated_at: number
  days: number
  start_timestamp: number
  end_timestamp: number
  low_balance_threshold: number
  probe_errors: Record<string, string>
  rows: ChannelBusinessRow[]
}

export interface ChannelBusinessReportResponse {
  success: boolean
  message?: string
  data?: ChannelBusinessReport
}
