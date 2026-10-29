import type {
  CreateCustomerOrderRequest,
  CreateCustomerRequest,
  CustomerDetailDto,
  CustomerListResponse,
  SetCustomerStageRequest,
  UpdateCustomerRequest,
  UpdateCustomerStepRequest,
} from '@fanhe/shared'

import {
  createCustomerOrderRequest,
  createCustomerRequest,
  customerDetailRequest,
  customersRequest,
  setCustomerStageRequest,
  updateCustomerRequest,
  updateCustomerStepRequest,
  type CustomerListQuery,
} from './api'
import { withAccessToken } from './session'

/**
 * 客户平台的前端数据层。
 *
 * 三层分工与其余模块一致（`api.ts` 拼地址、`session.ts` 管令牌、本文件拆信封）。
 * 客户模块特有的只有一点：**列表响应整份返回，不拆信封。**
 *
 * 原因是列表带的东西比列表本身多：`summary`（地区与阶段分布）、`total`、
 * `financeReadable`（当前账号能不能看金额）。只返回 `items` 会逼着界面从
 * 「金额是不是 null」反推权限 —— 而 null 同时表示「没权限」与「还没录」，
 * 那是两种要用不同文案解释的状态。
 */

export function loadCustomers(query: CustomerListQuery = {}): Promise<CustomerListResponse> {
  return withAccessToken((token) => customersRequest(token, query))
}

export function loadCustomer(id: string): Promise<CustomerDetailDto> {
  return withAccessToken(async (token) => (await customerDetailRequest(token, id)).customer)
}

export function createCustomer(input: CreateCustomerRequest): Promise<CustomerDetailDto> {
  return withAccessToken(async (token) => (await createCustomerRequest(token, input)).customer)
}

export function updateCustomer(
  id: string,
  input: UpdateCustomerRequest,
): Promise<CustomerDetailDto> {
  return withAccessToken(async (token) => (await updateCustomerRequest(token, id, input)).customer)
}

/**
 * 新建订单。返回的是整条客户详情而不是订单本身 —— 建单会让客户级合同额汇总变化，
 * 界面要一并刷新那个数字。只回订单的话，顶部汇总会停在旧值上。
 */
export function createCustomerOrder(
  id: string,
  input: CreateCustomerOrderRequest,
): Promise<CustomerDetailDto> {
  return withAccessToken(
    async (token) => (await createCustomerOrderRequest(token, id, input)).customer,
  )
}

export function updateCustomerStep(
  id: string,
  orderId: string,
  idx: number,
  input: UpdateCustomerStepRequest,
): Promise<CustomerDetailDto> {
  return withAccessToken(
    async (token) => (await updateCustomerStepRequest(token, id, orderId, idx, input)).customer,
  )
}

export function setCustomerStage(
  id: string,
  input: SetCustomerStageRequest,
): Promise<CustomerDetailDto> {
  return withAccessToken(
    async (token) => (await setCustomerStageRequest(token, id, input)).customer,
  )
}
