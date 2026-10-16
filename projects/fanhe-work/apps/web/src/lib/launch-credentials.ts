/**
 * 启动配置的「账号密码」：本机凭据的前端数据层（P1）。
 *
 * ## 它是什么
 *
 * QQ 与千牛支持账号密码登录，而它们的「记住密码 + 自动登录」只能记一个账号 —— 多账号时
 * 第二个起不来。于是启动配置需要一个「这条配置该填哪个账号密码」的地方。
 *
 * ## 密码不在这个包里
 *
 * **本模块从不持有、也不请求明文密码。** 桌面态的三条通道（`credential:status` /
 * `credential:save` / `credential:delete`）里没有「读回明文」那一条，这是刻意的：密码只在
 * 主进程内、且只在 P2 自动填表那一刻被解密。渲染进程能拿到的只有掩码账号
 * （`accountMasked`），编辑态的密码框因此**恒为空**，而「用户改没改密码」这件事必须靠
 * 显式信号判断，不能靠「密码框为空」推断 —— 理由见 `decideCredentialAction` 的注释。
 *
 * ## 宿主分流
 *
 * 与 `launch-detect.ts` / `launch.ts` 同一套：桌面态走 IPC，浏览器态降级。浏览器里没有
 * 主进程、没有 `safeStorage`，此时 `encryptionAvailable` 恒为 false，界面据此把账号密码
 * 输入区禁用并说明「自动登录需要桌面外壳」，**不假装保存成功**，也不把密码写进
 * localStorage 充数（那会把安全等级拉回 `lib/credential.ts` 的水平，而它自己的注释已经
 * 在说该换掉）。
 *
 * ## 与 `lib/credential.ts` 的分工
 *
 * 那边管**登录页**的「记住账号密码」（渲染进程 WebCrypto + IndexedDB 密钥）；这边管
 * **启动配置**的账号密码（主进程 DPAPI）。两套并存是阶段性的：前者等着被迁到 `safeStorage`
 * （它文件头已自陈），与本次改造无关。
 */

import { LAUNCH_CREDENTIAL_LIMITS, supportsAccountLogin, type LaunchSoftware } from '@fanhe/shared'

// 带 `.ts` 后缀是刻意的：本模块有单测，而 web 的单测是
// `node --experimental-strip-types --test`，只按字面解析 import 说明符 —— 写成
// `'./host'` 会让整个测试文件报模块缺失（与 `launch-detect.ts` 同一条约定）。
import { currentHost } from './host.ts'

/**
 * 一条配置的凭据状态。
 *
 * 与 `apps/desktop/src/preload.ts` 的 `CredentialStatusItem` 同源同形，两份定义刻意一致
 * 而不是互相 import —— web 不依赖 desktop（壳反过来依赖 web 的构建产物），没有可以共享
 * 的类型来源；少一个字段会在编译期报错，那正是我们要的失败方向。
 */
export type CredentialSnapshot = {
  /** 关联的配置 id。批量查询时用它把结果配回去，不依赖数组下标。 */
  profileId: string
  /** 还没填 / 已保存 / 解不开。三态必须分开，见下。 */
  state: 'none' | 'saved' | 'undecryptable'
  /** 掩码后的账号（如 `138****8888`）；没有凭据或解不开时为 null。 */
  accountMasked: string | null
  /** 明文外壳里的提示（配置显示名），解不开时告诉用户原本存的是哪一条。 */
  label: string
}

/** 查凭据状态的返回。空数组入参时 `items` 也是空数组。 */
export type CredentialStatusReply = {
  items: CredentialSnapshot[]
  /** 本机系统加密是否可用。false 时保存必然失败，界面据此禁用输入区。 */
  encryptionAvailable: boolean
}

/** 保存请求。`label` 只是明文外壳里的提示，非机密。 */
export type CredentialSaveInput = {
  profileId: string
  account: string
  password: string
  label?: string | undefined
}

/** 写操作的结果。`reason` 是机器可读码，`detail` 是可展示文案。 */
export type CredentialWriteReply = { ok: true } | { ok: false; reason: string; detail: string }

/**
 * 表单交上来的账号密码意图。**三段未经解释的原始输入**，解释在 `decideCredentialAction`。
 *
 * 刻意不带 profileId：同一种意图在「新增」（配置还没 id）与「编辑」下都要表达，而 id 在
 * 调用方手上。
 */
export type CredentialFormInput = {
  account: string
  password: string
  /** 用户勾了「清除已保存密码」。 */
  clear: boolean
}

/**
 * 一次账号密码意图的解释结果。
 *
 * 四种动作对应文档里那张表：不动、覆盖、删除、以及**拒绝**。第四种是这份解释的核心 ——
 * 见下面 `decideCredentialAction` 的注释。
 */
export type CredentialDecision =
  | { action: 'keep' }
  | { action: 'save'; account: string; password: string }
  | { action: 'delete' }
  | { action: 'reject'; message: string }

/**
 * 把表单输入解释成一个动作。
 *
 * ## 为什么必须有「拒绝」这一种结果
 *
 * 密码永不出主进程，所以编辑时**拿不回已保存的密码**。此时若按「密码框为空 = 不修改」
 * 推断，用户改了账号却没重填密码就会 silently 拿到「新账号 + 旧密码」—— 那是个静默的
 * 错误登录，比明确报错糟得多。因此半填状态必须拒绝，并把理由说清楚（要改账号请把密码
 * 一并重填）。
 *
 * ## 三条规则
 *
 * 1. `clear` 与任何填写**互斥**：既勾了清除又填了新密码，意图是矛盾的，拒绝而不是挑一个
 *    执行 —— 挑一个执行的行为不可预期。
 * 2. 账号与密码**要么都填、要么都不填**。都空 = 不动。
 * 3. 长度超限当场拒。真正的门在主进程的 `normalizeCredentialInput`（那条通道对渲染进程
 *    里的任何脚本开放，不能只信界面），这里只是让用户早一步看到。
 *
 * 账号两端空白会被去掉，密码原样保留 —— 密码的首尾空白可能是它本身的一部分。
 */
export function decideCredentialAction(input: CredentialFormInput): CredentialDecision {
  const account = input.account.trim()
  const password = input.password
  const cleared = input.clear

  if (cleared && (account !== '' || password !== '')) {
    return {
      action: 'reject',
      message: '「清除已保存密码」与填写新的账号密码只能选一个，请先取消勾选再填写。',
    }
  }
  if (cleared) return { action: 'delete' }

  if (account === '' && password === '') return { action: 'keep' }

  if (account === '' || password === '') {
    return {
      action: 'reject',
      message:
        '账号与密码需要一起填写。已保存的密码不会被回传，所以修改账号时请把密码一并重填一遍。',
    }
  }

  if (account.length > LAUNCH_CREDENTIAL_LIMITS.ACCOUNT_MAX) {
    return {
      action: 'reject',
      message: `账号不能超过 ${LAUNCH_CREDENTIAL_LIMITS.ACCOUNT_MAX} 个字符`,
    }
  }
  if (password.length > LAUNCH_CREDENTIAL_LIMITS.PASSWORD_MAX) {
    return {
      action: 'reject',
      message: `密码不能超过 ${LAUNCH_CREDENTIAL_LIMITS.PASSWORD_MAX} 个字符`,
    }
  }

  return { action: 'save', account, password }
}

/**
 * 这个软件的配置要不要显示账号密码字段。
 *
 * 直接转手共享包的 `supportsAccountLogin`，**不在这里另列一份清单**：桌面外壳的
 * `shouldClickLogin` 用的是同一份，两份清单各自漂移的后果是「外壳会替微信敲 Enter，而
 * 界面上根本不显示账号密码框」。微信是扫码登录，没有可代填的框。
 */
export function profileSupportsAccountLogin(software: string): software is LaunchSoftware {
  return supportsAccountLogin(software)
}

/**
 * 查一组配置的凭据状态。
 *
 * 宿主分流与 `detectLaunchPath` 一致。浏览器态（或桥上没有这个方法 —— 旧版外壳）回落成
 * 「加密不可用」，界面据此禁用输入区；**不回落成「都没有密码」**，那会让用户在浏览器里
 * 看到一个能填却永远存不上的表单。
 */
export function fetchCredentialStatus(
  profileIds: readonly string[],
): Promise<CredentialStatusReply> {
  if (currentHost() === 'desktop' && window.fanheDesktop?.getCredentialStatus) {
    // 桥上的签名是可变的 `string[]`，而这里收只读数组 —— 拷贝一份再过桥。
    // 反方向收敛（把桥的签名改成只读）要动 preload 的类型定义，那边还被桌面态
    // 别处的调用共享，不值得为一个调用点放宽契约。
    return window.fanheDesktop.getCredentialStatus([
      ...profileIds,
    ]) as Promise<CredentialStatusReply>
  }
  return Promise.resolve({ items: [], encryptionAvailable: false })
}

/** 保存一条凭据。同 `profileId` 重复保存是覆盖。 */
export function saveProfileCredential(input: CredentialSaveInput): Promise<CredentialWriteReply> {
  if (currentHost() === 'desktop' && window.fanheDesktop?.saveCredential) {
    return window.fanheDesktop.saveCredential(input)
  }
  return Promise.resolve({
    ok: false,
    reason: 'unsupported_host',
    detail: '保存账号密码需要桌面外壳环境。',
  })
}

/** 删掉一条凭据。软删除幂等：本来就没有也返回 ok。 */
export function deleteProfileCredential(profileId: string): Promise<CredentialWriteReply> {
  if (currentHost() === 'desktop' && window.fanheDesktop?.deleteCredential) {
    return window.fanheDesktop.deleteCredential(profileId)
  }
  return Promise.resolve({
    ok: false,
    reason: 'unsupported_host',
    detail: '删除账号密码需要桌面外壳环境。',
  })
}

/** 一次凭据写入的结果。`keep` 表示压根没动作，不是失败。 */
export type CredentialApplyOutcome =
  | { action: 'keep' }
  | { action: 'saved' }
  | { action: 'deleted' }
  | { action: 'rejected'; message: string }
  | { action: 'failed'; detail: string }

/**
 * 把表单意图落到本机凭据库。
 *
 * **先解释、再执行。** 解释放在这里而不是调用方，是因为两处提交（首页区块与管理面板）都要
 * 走同一条规则；分成两份的结果是某一路径忘了处理「清除」，表现是「删了配置但密码还留在
 * 本机」。
 *
 * 失败不抛错，而是变成结果里的一项：调用方此时**已经保存了配置**，正确的做法是提示
 * 「配置已保存，但密码没能保存到本机（原因）」，回滚配置会连带丢掉用户刚填的路径与参数，
 * 代价远大于收益。
 */
export async function applyCredentialIntent(
  profileId: string,
  input: CredentialFormInput,
  label?: string | undefined,
): Promise<CredentialApplyOutcome> {
  const decision = decideCredentialAction(input)

  if (decision.action === 'reject') return { action: 'rejected', message: decision.message }
  if (decision.action === 'keep') return { action: 'keep' }

  if (decision.action === 'delete') {
    const result = await deleteProfileCredential(profileId)
    return result.ok ? { action: 'deleted' } : { action: 'failed', detail: result.detail }
  }

  const result = await saveProfileCredential({
    profileId,
    account: decision.account,
    password: decision.password,
    label,
  })
  return result.ok ? { action: 'saved' } : { action: 'failed', detail: result.detail }
}

/**
 * 把一次凭据写入的结果翻成一句能接在配置保存提示后面的话。
 *
 * `keep` 返回空串而不是「未修改」：那句对用户没有信息量，而提示条上多一个空段会让人以
 * 为漏了什么。
 */
export function describeCredentialOutcome(outcome: CredentialApplyOutcome): string {
  switch (outcome.action) {
    case 'saved':
      return '账号密码已保存到本机'
    case 'deleted':
      return '已清除本机保存的密码'
    case 'failed':
      return `配置已保存，但密码没能保存到本机：${outcome.detail}`
    case 'rejected':
      return outcome.message
    default:
      return ''
  }
}
