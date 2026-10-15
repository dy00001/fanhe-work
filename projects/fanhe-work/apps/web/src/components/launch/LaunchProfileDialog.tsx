import {
  LAUNCH_PROFILE_LIMITS,
  LAUNCH_SOFTWARES,
  isAbsoluteExecutablePath,
  isLaunchSoftware,
  type LaunchProfile,
  type LaunchSoftware,
} from '@fanhe/shared'
import { useState, type FormEvent, type ReactNode } from 'react'

import { ApiError } from '../../lib/api'
import { LAUNCH_ICONS, LAUNCH_ICON_CHOICES, LAUNCH_SOFTWARE_LABELS } from '../../lib/launch-icons'
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
        className="sm:max-w-lg"
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

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  /**
   * 选软件时，若路径框还空，带出该软件的预填路径（§2.5 复用）。
   *
   * 只在「路径为空」时补：编辑既有配置时路径已非空，不该被覆盖；用户手填了一半也不
   * 该因为换一下软件而被清掉。预填是「给个起点」，不是「替用户决定」，随时可改。
   */
  function selectSoftware(id: LaunchSoftware): void {
    setSoftware(id)
    if (executablePath.trim() === '') {
      const suggested = suggestedPaths?.[id]
      if (suggested !== undefined) setExecutablePath(suggested)
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

    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) return null

    return { software, name: trimmedName, executablePath: trimmedPath, args, icon }
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
          onChange={(event) => setExecutablePath(event.target.value)}
        />
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
