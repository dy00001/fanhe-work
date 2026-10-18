import {
  LAUNCH_CREDENTIAL_LIMITS,
  LAUNCH_PROFILE_LIMITS,
  LAUNCH_SOFTWARES,
  isAbsoluteExecutablePath,
  isLaunchSoftware,
  supportsAccountLogin,
  type LaunchProfile,
  type LaunchSoftware,
} from '@fanhe/shared'
import { KeyRound, LoaderCircle, Radar } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'

import { ApiError } from '../../lib/api'
import { decideCredentialAction, type CredentialFormInput } from '../../lib/launch-credentials'
import { detectLaunchPath } from '../../lib/launch'
import { LAUNCH_ICONS, LAUNCH_ICON_CHOICES, LAUNCH_SOFTWARE_LABELS } from '../../lib/launch-icons'
import { useProfileCredential } from '../../lib/use-launch-credential'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'

/**
 * 表单的值。与共享包的创建/修改请求分开定义，是因为这里有一样东西是请求结构里没有的：
 * 参数在界面上是一个多行文本，需要一次解析才能变成数组。校验与解析都发生在这个文件里，
 * 提交出去的已经是规范化的值。
 */
export type LaunchFormValues = {
  software: string
  name: string
  executablePath: string
  args: string[]
  icon: string | null
  /**
   * 账号密码意图（P1）。**只在账号密码登录的软件上出现**，且只在用户真的动过时才有值 ——
   * 没动过就不传，主进程据此保持原凭据不动（见 `decideCredentialAction`）。
   */
  login?: CredentialFormInput | undefined
}

type LaunchProfileDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 传 null 表示新增，传一条配置表示编辑。两种模式共用同一个表单。 */
  profile: LaunchProfile | null
  /**
   * 打开后把光标落在路径字段上并选中原值。
   *
   * 用于「重新指定路径」这个入口：那条路径已经失效了，用户要做的事就是把整段换掉，
   * 而对话框里第一个可聚焦的元素是软件选择按钮 —— 不指定的话他会先落在那里，
   * 还得自己找到路径字段。
   */
  focusPath?: boolean | undefined
  /**
   * 每个软件「最近有效路径」的反查表（§2.5 持久化与复用）。新增配置、且路径框为空时，
   * 选到某个软件会自动把它的预填路径带出来，不必重复检测。只读访客也会收到这张表，
   * 但只读时不显示新增入口，故不影响权限边界。
   */
  suggestedPaths?: Readonly<Record<string, string>> | undefined
  /**
   * 提交。由外层负责真正发请求 —— 新增与编辑走的是不同的接口，而失败后要不要刷新
   * 列表也只有外层知道。这里只把校验通过的值交出去，并等它一个结果。
   *
   * 抛出时按失败处理：异常消息会显示在表单里，对话框保持打开，用户可以直接改。
   */
  onSubmit: (values: LaunchFormValues) => Promise<void>
}

type FieldProps = {
  label: string
  htmlFor: string
  error?: string | undefined
  hint?: string | undefined
  children: ReactNode
}

/** 标签 + 控件 + 提示 + 错误的固定结构。四段排布在四个字段上重复，抽出来只为统一间距。 */
function Field({ label, htmlFor, error, hint, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {/* 提示与错误互斥：出错时再说「一行一个参数」只是噪音。 */}
      {error !== undefined ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint !== undefined ? (
        <p className="text-xs text-muted-foreground-weak">{hint}</p>
      ) : null}
    </div>
  )
}

/**
 * 把多行文本解析成参数数组。
 *
 * **一行一个参数，不做分词。** 共享包里参数按数组存（理由见 `launch.ts` 的注释：
 * Windows 与 POSIX 的分词规则不同，自己实现必然在某个边界上不一致），界面这一侧
 * 必须有一种同样不依赖分词的输入方式。按行拆正好满足：一个参数里带空格也不需要
 * 引号，因为换行符就是分隔符。
 *
 * 去空行、两端去空白。首尾空白在启动参数里几乎没有意义，而粘贴时很容易带进来 ——
 * 留着它换来的只是「路径莫名其妙找不到」。
 */
function parseArgs(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * 新增与编辑启动配置。
 *
 * 这一层只负责对话框的外壳（标题、说明、开关）。表单主体在 `LaunchProfileForm`，
 * 两者分开是因为表单必须**随对话框一起挂载**：Radix 在退场动画结束后会卸载内容，
 * 于是每次打开都是一次全新挂载，各字段的初值直接由 props 算出来即可。把表单状态
 * 留在这一层的话，它会跨多次打开存活，就需要一个「打开时重置」的 effect —— 那种
 * effect 在首帧之后再触发一轮渲染，而且很容易漏掉某个字段，漏掉的那一个会带着
 * 上一次的值被提交出去。
 */
export function LaunchProfileDialog({
  open,
  onOpenChange,
  profile,
  focusPath,
  suggestedPaths,
  onSubmit,
}: LaunchProfileDialogProps) {
  const editing = profile !== null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain sm:max-w-lg"
        /**
         * 把初始焦点改到路径字段上。
         *
         * 走 `onOpenAutoFocus` 而不是在表单里挂一个 effect 去 focus：Radix 的默认行为
         * 是聚焦第一个可聚焦元素（这里是软件选择按钮），而它的执行时机与子组件 effect
         * 的先后取决于内部实现 —— 谁最后跑谁说了算。这里 `preventDefault()` 把默认
         * 行为关掉再自己聚焦，结果与顺序无关。
         */
        onOpenAutoFocus={(event) => {
          if (focusPath !== true) return
          event.preventDefault()
          // 按 id 取而不是用 `event.currentTarget`：Radix 给这个回调传的是原生 Event，
          // 它的 currentTarget 类型是 EventTarget，没有 querySelector。同时开着的
          // 对话框只有一个，id 在页面里是唯一的。
          const input = document.getElementById('launch-path')
          if (!(input instanceof HTMLInputElement)) return
          input.focus()
          // 一并选中原值：用户点的是「重新指定路径」，要做的事就是把整段换掉。
          input.select()
        }}
      >
        <DialogHeader>
          <DialogTitle>{editing ? '编辑启动配置' : '新增启动配置'}</DialogTitle>
          <DialogDescription>
            配置只保存在本机，启动时按这里的路径与参数创建进程。
          </DialogDescription>
        </DialogHeader>
        <LaunchProfileForm
          profile={profile}
          onSubmit={onSubmit}
          onCancel={() => onOpenChange(false)}
          suggestedPaths={suggestedPaths}
        />
      </DialogContent>
    </Dialog>
  )
}

type LaunchProfileFormProps = {
  profile: LaunchProfile | null
  onSubmit: (values: LaunchFormValues) => Promise<void>
  onCancel: () => void
  /** 见 `LaunchProfileDialogProps.suggestedPaths`：选软件时为空路径框预填。 */
  suggestedPaths?: Readonly<Record<string, string>> | undefined
}

/**
 * 表单主体。
 *
 * **校验规则全部来自共享包。** `isAbsoluteExecutablePath`、长度上限、软件清单都是
 * 服务端强制的那一份，界面只是把同样的判断提前做一次，好让用户当场看到问题而不是
 * 提交后收一个 400。各写一份的结果是两边迟早不一致 —— 而那种不一致的表现是
 * 「表单说可以，保存失败」。
 *
 * **不查文件是否存在。** 存在性检查要等真正启动的那一刻（见共享包该函数的注释）：
 * 配置创建时文件在、三个月后可能已被卸载，把结论固化下来只会给出一个过期的判断。
 */
function LaunchProfileForm({
  profile,
  onSubmit,
  onCancel,
  suggestedPaths,
}: LaunchProfileFormProps) {
  // 类型收窄成 `LaunchSoftware` 而不是 `string`：软件只能从清单里选，而收窄之后
  // 下面两处图标与名称的查找表都是直接索引，不必再各写一次判空与回落。
  const [software, setSoftware] = useState<LaunchSoftware>(
    profile !== null && isLaunchSoftware(profile.software) ? profile.software : LAUNCH_SOFTWARES[0],
  )
  const [name, setName] = useState(profile?.name ?? '')
  const [executablePath, setExecutablePath] = useState(profile?.executablePath ?? '')
  const [argsText, setArgsText] = useState(profile === null ? '' : profile.args.join('\n'))
  const [icon, setIcon] = useState<string | null>(profile?.icon ?? null)

  /**
   * 账号密码（P1）。
   *
   * **密码框恒为空，不含已保存的密码** —— 那条密码从不过 IPC 回传（见
   * `lib/launch-credentials.ts` 文件头）。于是「用户改没改密码」不能靠框里有没有内容推断，
   * 意图在提交时由 `decideCredentialAction` 按三个显式信号定：没动（keep）、填了（save）、
   * 勾了清除（delete）。
   */
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [clearCredential, setClearCredential] = useState(false)

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  /**
   * 这条配置在本机存着的凭据（P1）。编辑时才查得到东西；新增模式没有 id，`snapshot` 恒空。
   *
   * `encryptionAvailable` 在这里被当作「账号密码输入区能不能用」的开关：浏览器态、旧版
   * 外壳、以及本机系统加密不可用时它都是 false，三种情况下输入区一律禁用并说明原因，
   * 而不是显示一个能填却永远存不上的表单。
   */
  const credential = useProfileCredential(profile?.id ?? null)
  const credentialUsable = credential.encryptionAvailable

  /** 一键检测（§2.5）的界面状态：是否在跑、命中几个、一句结果说明。 */
  const [detecting, setDetecting] = useState(false)
  const [detectCandidates, setDetectCandidates] = useState<readonly string[]>([])
  const [detectHint, setDetectHint] = useState<{
    kind: 'error' | 'info' | 'ok'
    text: string
  } | null>(null)

  /**
   * 路径框里的值是不是「自动填的」（预填或检测结果），用户没手输过。
   *
   * 用它区分「这串路径属于当前软件」还是「用户自己写的」。切换软件时只替换前者：否则
   * 会出现「选着 QQ、框里却留着微信的路径」这种张冠李戴（真机实测的截图正是如此），
   * 用户会以为检测把微信路径当成了 QQ 的。用户手输过的路径一律不动。
   */
  const [pathAuto, setPathAuto] = useState(false)

  /**
   * 选软件。路径框若是「自动填的」或还空着，就换成新软件的预填路径（没有则清空）；
   * 用户手输过的路径保持不动。
   */
  function selectSoftware(id: LaunchSoftware): void {
    setSoftware(id)
    // 换软件意味着上一次检测的命中属于别的软件，一并清掉，别让候选列表张冠李戴。
    setDetectCandidates([])
    setDetectHint(null)
    if (pathAuto || executablePath.trim() === '') {
      const suggested = suggestedPaths?.[id]
      setExecutablePath(suggested ?? '')
      setPathAuto(suggested !== undefined)
    }
  }

  /**
   * 一键检测（§2.5）：扫本机常见安装位置，命中即回填路径。
   *
   * 把当前框里的值当 `extraPath` 传下去：桌面端会把「已填且确实存在」的那条排在候选
   * 最前，于是「我填了一半，帮我看看还有没有别的」这个体验成立。命中多个时把清单留
   * 在下面供切换，首选直接填入。
   *
   * 失败只在这一块给一句说明，不动表单其它字段；代理不可用（浏览器态、或本机代理没
   * 加载出来）要说清「检测需要桌面外壳」，而不是假装「没找到」。
   */
  async function handleDetect(): Promise<void> {
    setDetecting(true)
    setDetectHint(null)
    setDetectCandidates([])
    try {
      const result = await detectLaunchPath(software, executablePath.trim())
      setDetectCandidates(result.candidates)
      if (result.preferred !== null) {
        setExecutablePath(result.preferred)
        // 检测结果也归为「自动填的」：它属于当前软件，换软件时该被替换。
        setPathAuto(true)
        setDetectHint({
          kind: 'ok',
          text:
            result.candidates.length > 1
              ? `已填首选，另命中 ${result.candidates.length - 1} 个可切换`
              : '已检测到路径并填入',
        })
        return
      }
      if (!result.agentAvailable) {
        setDetectHint({
          kind: 'error',
          text: result.detail ?? '本机代理不可用，一键检测需要桌面外壳环境',
        })
        return
      }
      setDetectHint({ kind: 'info', text: '常见安装位置未找到该软件，请手动填写路径' })
    } catch (error) {
      setDetectHint({
        kind: 'error',
        text: error instanceof ApiError ? error.message : '检测失败，请稍后重试',
      })
    } finally {
      setDetecting(false)
    }
  }

  function validate(): LaunchFormValues | null {
    const errors: Record<string, string> = {}
    const trimmedName = name.trim()
    const trimmedPath = executablePath.trim()
    const args = parseArgs(argsText)

    if (trimmedName === '') {
      errors.name = '显示名不能为空'
    } else if (trimmedName.length > LAUNCH_PROFILE_LIMITS.NAME_MAX) {
      errors.name = `显示名不能超过 ${LAUNCH_PROFILE_LIMITS.NAME_MAX} 个字符`
    }

    if (trimmedPath === '') {
      errors.executablePath = '请填写可执行文件路径'
    } else if (trimmedPath.length > LAUNCH_PROFILE_LIMITS.EXECUTABLE_PATH_MAX) {
      errors.executablePath = `路径不能超过 ${LAUNCH_PROFILE_LIMITS.EXECUTABLE_PATH_MAX} 个字符`
    } else if (!isAbsoluteExecutablePath(trimmedPath)) {
      // 相对路径在界面上必须当场拒绝：它只会在点击启动时以「找不到文件」的形式暴露，
      // 那时已经看不出是当初填错了。
      errors.executablePath = '必须是绝对路径，例如 C:\\Program Files\\... 或 \\\\服务器\\共享'
    }

    if (args.length > LAUNCH_PROFILE_LIMITS.ARGS_MAX_COUNT) {
      errors.args = `最多 ${LAUNCH_PROFILE_LIMITS.ARGS_MAX_COUNT} 个参数，当前 ${args.length} 个`
    } else if (args.some((arg) => arg.length > LAUNCH_PROFILE_LIMITS.ARG_MAX)) {
      errors.args = `单个参数不能超过 ${LAUNCH_PROFILE_LIMITS.ARG_MAX} 个字符`
    }

    // 账号密码意图在这里解释一次（P1）：半填、清除与填写并存、超长都在这一步拒掉，用户
    // 当场看到问题，而不是提交后收到一句全局提示。**只有账号密码登录的软件才校验。**
    let login: CredentialFormInput | undefined
    if (supportsAccountLogin(software)) {
      const decision = decideCredentialAction({ account, password, clear: clearCredential })
      if (decision.action === 'reject') {
        // 挂在 account 上而不是另起一个字段：账号是这两个框里的第一个，理由也主要是
        // 「要改账号就得连密码一起重填」。
        errors.account = decision.message
      } else if (decision.action !== 'keep') {
        login = { account, password, clear: clearCredential }
      }
    }

    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) return null

    return { software, name: trimmedName, executablePath: trimmedPath, args, icon, login }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (submitting) return

    const values = validate()
    if (values === null) return

    setSubmitting(true)
    setFormError(null)
    try {
      await onSubmit(values)
      onCancel()
    } catch (error) {
      // 只显示可展示的文案。`ApiError` 的 message 由服务端给出（例如「已有同名的
      // 启动配置」），对使用者有意义；其余异常一律给一句概括，不把原文摊出来。
      setFormError(error instanceof ApiError ? error.message : '保存失败，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  // 「跟随软件」这一项用当前选中软件的默认图标，好让人看出不选图标会得到什么。
  const FollowSoftwareIcon = LAUNCH_ICONS[software]

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
      <Field label="软件" htmlFor="launch-software">
        <div id="launch-software" className="flex flex-wrap gap-2">
          {LAUNCH_SOFTWARES.map((id) => (
            <Button
              key={id}
              type="button"
              size="sm"
              variant={software === id ? 'default' : 'outline'}
              aria-pressed={software === id}
              onClick={() => selectSoftware(id)}
            >
              {LAUNCH_SOFTWARE_LABELS[id]}
            </Button>
          ))}
        </div>
      </Field>

      <Field
        label="显示名"
        htmlFor="launch-name"
        error={fieldErrors.name}
        hint="同一软件配多条时靠它区分，例如「微信 · 工作号」"
      >
        <Input
          id="launch-name"
          value={name}
          maxLength={LAUNCH_PROFILE_LIMITS.NAME_MAX}
          placeholder="微信 · 工作号"
          aria-invalid={fieldErrors.name !== undefined}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>

      <Field
        label="可执行文件路径"
        htmlFor="launch-path"
        error={fieldErrors.executablePath}
        hint="必须是本机绝对路径，可以带盘符或网络共享"
      >
        <Input
          id="launch-path"
          value={executablePath}
          maxLength={LAUNCH_PROFILE_LIMITS.EXECUTABLE_PATH_MAX}
          placeholder="C:\\Program Files\\Tencent\\WeChat\\WeChat.exe"
          spellCheck={false}
          aria-invalid={fieldErrors.executablePath !== undefined}
          onChange={(event) => {
            setExecutablePath(event.target.value)
            // 用户一旦手输，就不再是「自动填的」，切软件时不该被替换。
            setPathAuto(false)
          }}
        />

        {/* 一键检测（§2.5）。桌面态扫常见安装位置并回填；浏览器态没有本机文件系统，
            由 detectLaunchPath 回落到 agentAvailable=false，这里据实说明，不假装没找到。 */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label="一键检测可执行文件路径"
            disabled={detecting}
            onClick={() => void handleDetect()}
          >
            {detecting ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Radar className="size-3.5" />
            )}
            {detecting ? '检测中…' : '一键检测'}
          </Button>
          {detectHint !== null && (
            <span
              className={[
                'text-xs',
                detectHint.kind === 'error' ? 'text-destructive' : 'text-muted-foreground',
              ].join(' ')}
            >
              {detectHint.text}
            </span>
          )}
        </div>

        {/* 命中多个时给一个切换器：点哪条填哪条。首选已在请求返回时自动填入。 */}
        {detectCandidates.length > 1 && (
          <div className="flex flex-col gap-1.5">
            {detectCandidates.map((candidate) => (
              <button
                key={candidate}
                type="button"
                onClick={() => {
                  setExecutablePath(candidate)
                  setPathAuto(true)
                }}
                title={candidate}
                className="truncate rounded-md border border-border px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {candidate}
              </button>
            ))}
          </div>
        )}
      </Field>

      <Field
        label="启动参数（可选）"
        htmlFor="launch-args"
        error={fieldErrors.args}
        hint="一行一个参数。参数里有空格也无需引号。"
      >
        <Textarea
          id="launch-args"
          value={argsText}
          rows={3}
          placeholder={'--profile\n工作号'}
          spellCheck={false}
          aria-invalid={fieldErrors.args !== undefined}
          onChange={(event) => setArgsText(event.target.value)}
        />
      </Field>

      {/* 账号密码（P1）。只对账号密码登录的软件出现 —— 微信是扫码登录，没有可代填的框。 */}
      {supportsAccountLogin(software) && (
        <fieldset className="flex flex-col gap-4 rounded-lg border border-border p-3">
          <legend className="flex items-center gap-1.5 px-1 text-sm font-medium text-foreground">
            <KeyRound className="size-3.5" />
            登录账号（可选）
          </legend>

          {/*
            本机已存凭据的一行摘要。三个状态三种说法：还没填、已存（给掩码账号）、解不开
            （换机或换 Windows 用户后 DPAPI 必然解不开，此时要引导重新填）。混成一个
            「没有密码」会让用户在换机后反复重填、反复失败，而他无法从界面看出问题不在
            自己身上。
          */}
          {credential.loading ? (
            <p className="text-xs text-muted-foreground">正在检查本机加密存储…</p>
          ) : credential.snapshot?.state === 'saved' ? (
            <p className="text-xs text-emerald-700">
              ✓ 密码已加密保存在本机，账号{' '}
              <span className="font-medium">{credential.snapshot.accountMasked}</span>
              。留空表示保持已保存内容。
            </p>
          ) : credential.snapshot?.state === 'undecryptable' ? (
            <p className="text-xs text-destructive">
              本机保存的密码解不开（换电脑或换 Windows 用户后属正常）。请重新填写账号与密码。
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {credentialUsable
                ? '当前尚未保存账号密码。填写账号和密码并保存配置后，将加密保存在本机。'
                : '账号密码尚未保存。请在梵禾 Work 桌面版中使用本机加密存储。'}
            </p>
          )}

          {/*
            降级说明。浏览器态没有主进程、本机系统加密不可用时同理：**不禁用就显示**，
            因为那会让用户填完之后才发现存不上；而把字段藏起来又看不出这个功能存在。
          */}
          {!credentialUsable && (
            <p className="text-xs text-muted-foreground-weak">
              自动登录需要桌面外壳环境，浏览器里无法保存账号密码。
            </p>
          )}

          <Field
            label="账号"
            htmlFor="launch-account"
            error={fieldErrors.account}
            hint="保存在本机，用于启动后自动填写登录框"
          >
            <Input
              id="launch-account"
              value={account}
              maxLength={LAUNCH_CREDENTIAL_LIMITS.ACCOUNT_MAX}
              placeholder={credentialUsable ? 'QQ 号 / 旺旺名' : '需要桌面外壳'}
              autoComplete="off"
              spellCheck={false}
              disabled={!credentialUsable}
              aria-invalid={fieldErrors.account !== undefined}
              onChange={(event) => setAccount(event.target.value)}
            />
          </Field>

          <Field
            label="密码"
            htmlFor="launch-password"
            error={fieldErrors.password}
            hint={
              profile !== null
                ? '已保存的密码不会被回传；只想改账号时，请把密码一并重填一遍'
                : '保存在本机，用于启动后自动填写登录框'
            }
          >
            <Input
              id="launch-password"
              type="password"
              value={password}
              maxLength={LAUNCH_CREDENTIAL_LIMITS.PASSWORD_MAX}
              placeholder={
                credentialUsable ? (profile !== null ? '不修改则留空' : '登录密码') : '需要桌面外壳'
              }
              autoComplete="new-password"
              spellCheck={false}
              disabled={!credentialUsable}
              aria-invalid={fieldErrors.password !== undefined}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>

          {/*
            清除。只在真的有东西可清时出现：一条都没存过时勾它没有意义，而一个永远
            可勾的复选框会让人以为「存过但界面没显示」。它是三种显式意图里的第三种
            （不改 / 覆盖 / 清除）。
          */}
          {credentialUsable &&
            (credential.snapshot?.state === 'saved' ||
              credential.snapshot?.state === 'undecryptable') && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={clearCredential}
                  onChange={(event) => setClearCredential(event.target.checked)}
                />
                清除本机保存的密码
              </label>
            )}
        </fieldset>
      )}

      <Field label="图标（可选）" htmlFor="launch-icon" hint="不选则跟随软件">
        <div id="launch-icon" className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="icon-sm"
            variant={icon === null ? 'default' : 'outline'}
            aria-label="跟随软件"
            aria-pressed={icon === null}
            onClick={() => setIcon(null)}
          >
            <FollowSoftwareIcon />
          </Button>
          {LAUNCH_ICON_CHOICES.map((choice) => {
            const ChoiceIcon = LAUNCH_ICONS[choice.id]
            return (
              <Button
                key={choice.id}
                type="button"
                size="icon-sm"
                variant={icon === choice.id ? 'default' : 'outline'}
                aria-label={choice.label}
                aria-pressed={icon === choice.id}
                onClick={() => setIcon(choice.id)}
              >
                <ChoiceIcon />
              </Button>
            )
          })}
        </div>
      </Field>

      {formError !== null && (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" disabled={submitting} onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? '保存中…' : '保存'}
        </Button>
      </DialogFooter>
    </form>
  )
}
