/**
 * 用户自定义头像的存储。
 *
 * ## 存在哪、为什么
 *
 * 与 `preferences.ts` 同一层：**落在本机 localStorage，不进数据库**。
 *
 * 这一条是权衡后的选择，不是省事。头像有两种存法，代价差别很大：
 *
 * - **存服务端**（`users` 表加一列 / 加一张附件表 + 上传接口）：好处是换机、换浏览器
 *   都跟着走。代价是这条链路要穿过 Prisma 迁移、容器内的库、上传的体积与类型校验、
 *   鉴权与越权（谁能不能改别人的头像）—— 而它承载的信息量只有一个 256×256 的图。
 * - **存本机**（本模块）：零迁移、零接口、零越权面，改完立刻生效。
 *
 * 本项目已经有一条同样的先例：主题与侧栏折叠状态都只存本机，理由写在
 * `preferences.ts` 文件头。头像与它们是同一类东西 —— 它影响的是「这台机器上我看到
 * 的自己长什么样」，而不是任何一条业务数据。所以这里沿用同一条约定。
 *
 * ## 已知边界（写清楚，避免以后当成 bug 查）
 *
 * 存储按 **origin** 分区，而 origin 含端口，所以：
 *   - 桌面外壳（`127.0.0.1:<端口>`）与浏览器（`work.fanhe.dpdns.org`）**各存一份**，
 *     互不可见。同一个账号在两边可以有不同的头像。
 *   - 换机器、清缓存、换浏览器都会回到默认（首字头像）。
 *   - 换账号时按 `userId` 分开存，所以同一台机器上两个账号各有各的头像。
 *
 * 哪天要把头像变成账号级数据，改的是**这一个文件**：把 `readAvatar` / `writeAvatar`
 * 换成调接口即可，调用方（TopBar、裁剪对话框）一行都不用动。
 *
 * ## 为什么要显式传 `storage`
 *
 * 与 `paths.ts` 的 `webDistRoot` 同一条理由：默认参数里读 `window` 会让这个模块在
 * 纯 Node 单测里直接抛。改成显式参数之后，「存储读不出来时回落」「写不进去时报什么」
 * 这些真实分支都能被断言到，而它们恰恰是最容易在隐私模式 / 配额满时才暴露的那几条。
 */

/** 只用到三个方法的存储接口。`window.localStorage` 结构上满足它。 */
export type AvatarStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/**
 * 键前缀。带版本号是为了将来能整体作废：头像格式若从方形改成圆形、或者要迁到服务端，
 * 升一位版本号就能让旧值自然失效，不必写迁移。
 */
const AVATAR_KEY_PREFIX = 'fanhe-work.avatar.v1.'

/**
 * 数据 URL 的长度上限（字符）。
 *
 * 导出尺寸是 256×256，照片类的 PNG 大约 100~200 KB，base64 之后约 140~270 K 字符，
 * 离这个上限还有很大余量。设上限是为了兜住两种失控：① 将来有人把导出尺寸调大；
 * ② localStorage 总配额约 5 MB，写爆之后**是同一 origin 下所有键一起坏**（主题、
 * 侧栏折叠、会话都读不出来），代价远大于少存一张头像。所以宁可拒写。
 */
export const AVATAR_MAX_CHARS = 1_500_000

/** 允许的 data URL 前缀。只认这几种：都是浏览器原生能渲染、且我们自己也产得出来的。 */
const AVATAR_PREFIXES = [
  'data:image/png;base64,',
  'data:image/jpeg;base64,',
  'data:image/webp;base64,',
]

/** 某个用户的头像存储键。 */
export function avatarStorageKey(userId: string): string {
  return `${AVATAR_KEY_PREFIX}${userId}`
}

/**
 * 判断一个字符串是不是可以当头像用的 data URL。
 *
 * **刻意不做 base64 解码校验。** 图坏掉的表现是 `AvatarImage` 触发 `onError` 而回落
 * 到首字头像（见 `TopBar`），那是一个已经存在、且正确的降级路径；在这里做一次完整
 * 解码只是把一个已经有了的兜底又写了一遍，还多花一次 O(n) 的解码。
 *
 * 只挡两种：**不是图片 data URL**（手改出来的 `javascript:`、贴错的一串路径）与
 * **超出长度上限**。
 */
export function isAcceptableAvatar(value: string): boolean {
  if (value.length === 0 || value.length > AVATAR_MAX_CHARS) return false
  return AVATAR_PREFIXES.some((prefix) => value.startsWith(prefix))
}

/** 当前 origin 的 localStorage；取不到（隐私模式、非浏览器环境）返回 null。 */
export function defaultAvatarStorage(): AvatarStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/**
 * 读某个用户的头像。没有、读不出来、或者值不合法时一律返回 null。
 *
 * 「不合法也当没有」而不是把原值抛给调用方：调用方能做的唯一事情就是回落首字头像，
 * 而把一串看不懂的字符串继续往下传，最终会变成一个坏掉的 `<img>`。
 */
export function readAvatar(
  userId: string,
  storage: AvatarStorage | null = defaultAvatarStorage(),
): string | null {
  if (storage === null) return null
  try {
    const raw = storage.getItem(avatarStorageKey(userId))
    return raw !== null && isAcceptableAvatar(raw) ? raw : null
  } catch {
    return null
  }
}

/**
 * 写入结果。
 *
 * 返回判别联合而不是布尔：三种失败要说成三句不同的话 —— 「太大」用户可以自己换一张
 * 小图解决，「格式不对」说明导出那一步坏了，「存储不可用」是环境问题。说成同一句会
 * 让人白试。
 */
export type AvatarWriteResult =
  { ok: true } | { ok: false; reason: 'invalid' | 'too_large' | 'unavailable' }

/**
 * 写入某个用户的头像。
 *
 * **先校验再写**，而不是写完再看大小：`setItem` 在超配额时会抛，而抛的那一刻可能
 * 已经把同 origin 下别的键挤坏了。自己先挡一道，坏就坏在这一次操作上。
 */
export function writeAvatar(
  userId: string,
  dataUrl: string,
  storage: AvatarStorage | null = defaultAvatarStorage(),
): AvatarWriteResult {
  if (!AVATAR_PREFIXES.some((prefix) => dataUrl.startsWith(prefix))) {
    return { ok: false, reason: 'invalid' }
  }
  if (dataUrl.length > AVATAR_MAX_CHARS) return { ok: false, reason: 'too_large' }
  if (storage === null) return { ok: false, reason: 'unavailable' }
  try {
    storage.setItem(avatarStorageKey(userId), dataUrl)
    return { ok: true }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}

/**
 * 清掉某个用户的头像，回到首字头像。
 *
 * 删一个不存在的键不是错误（`removeItem` 对缺失键是空操作），所以这里不区分
 * 「删掉了」与「本来就没有」—— 调用方要做的事一样。
 */
export function clearAvatar(
  userId: string,
  storage: AvatarStorage | null = defaultAvatarStorage(),
): void {
  if (storage === null) return
  try {
    storage.removeItem(avatarStorageKey(userId))
  } catch {
    // 见上：清不掉时界面仍会按「已清掉」渲染，下次启动可能又出现。可接受。
  }
}
