/**
 * 自定义头像的读写状态。
 *
 * 存储细节全在 `avatar.ts`，这里只做三件事：**读头像、写回、换账号时跟着变**。
 * 单开一个文件而不是写进 `TopBar.tsx`，理由与 `preferences.ts` 顶部那段一致：一个
 * 文件同时导出组件与非组件时，react-refresh 无法确定该保留哪一部分的状态。
 *
 * ## 为什么用 `useSyncExternalStore` 而不是 `useState + useEffect`
 *
 * 头像来自本机 `localStorage`，是 React 之外的可变源。`useSyncExternalStore` 正是为这类
 * 外部源准备的读取原语：
 *
 * - `getSnapshot` 每次重读存储，返回 `string | null`—— 原始值比较（`Object.is` 按值），
 *   不会触发无限重渲染；
 * - 订阅是空操作：写操作之后宿主**必然**重渲染（保存成功 → 对话框关闭 → `TopBar` 重渲染；
 *   移除 → 同上），届时 `getSnapshot` 自然读到新值，所以不需要真的发事件。
 *
 * 这样既绕开了 `react-hooks/set-state-in-effect`（不在 effect 里 setState），也绕开了
 * `react-hooks/refs`（不渲染期访问 ref）。换账号时 `userId` 变了，`getSnapshot` 闭包拿到
 * 新 `userId`，一次重渲染就重读到了新账号的头像。
 */
import { useCallback, useSyncExternalStore } from 'react'

import { clearAvatar, readAvatar, writeAvatar, type AvatarWriteResult } from './avatar'

export type UseAvatarResult = {
  /** 当前头像 data URL；null 表示用首字头像。 */
  avatar: string | null
  /** 保存头像。失败时返回原因，由对话框说成对应的一句话。 */
  save: (dataUrl: string) => AvatarWriteResult
  /** 清掉自定义头像，回到首字。 */
  remove: () => void
}

/** 空订阅：头像只在本文件里被写，每次写后宿主都会因对话框开关而重渲染并自动重读。 */
const EMPTY_SUBSCRIBE = () => () => {}

export function useAvatar(userId: string): UseAvatarResult {
  const getSnapshot = useCallback(() => readAvatar(userId), [userId])

  const avatar = useSyncExternalStore(EMPTY_SUBSCRIBE, getSnapshot)

  // 先写存储、再返回结果：调用方（对话框）按 `ok` 决定「关闭并提示成功」还是「保持打开并
  // 报错」。这里不持有任何本地镜像——界面始终由 `getSnapshot` 从存储读出来，存储写不进去
  // （满了）就表现为「看着没换成」，不会谎报成功。
  const save = useCallback(
    (dataUrl: string): AvatarWriteResult => writeAvatar(userId, dataUrl),
    [userId],
  )

  const remove = useCallback(() => clearAvatar(userId), [userId])

  return { avatar, save, remove }
}
