import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { cn } from '../../lib/utils'

/**
 * Markdown 预览。
 *
 * **不引入 `rehype-raw`，这是本文件最重要的一条。** 正文按 Markdown 原文存
 * （见 `packages/shared/src/note.ts` 顶部），意味着渲染是读回自己写的内容 —— 但
 * 「自己写的」并不等于可信：纪要是可以被复制粘贴进来的，而一旦放行原始 HTML，
 * 一段 `<img onerror=…>` 就能在读到它的人那里执行。react-markdown 默认不解析
 * HTML，标签会以字面文本出现，这正是我们要的行为。**不要为了「支持 HTML」加
 * `rehype-raw`** ——要加的话，同时必须加 `rehype-sanitize`，而这两件事都不该由
 * 一个预览组件顺手决定。
 *
 * 外链一律补 `rel="noopener noreferrer"` 并开新窗口。`noopener` 针对的是
 * `window.opener` 改写：不加它，被打开的页面可以把这个标签页导航到别处。
 *
 * 样式逐元素写而不是引 `@tailwindcss/typography`：项目的排版规格出自方案 B，
 * 而 typography 插件带来的是一整套餐位与间距，覆盖它的成本高于直接写。逐元素
 * 写在十个标签以内是可控的，而且每一处用的都是既有令牌 —— 令牌一改，预览跟着改。
 *
 * 组件表放在模块级。它不依赖 props 或 state，每次渲染重建一个对象只是浪费，还会
 * 让 React 认为整棵子树变了。
 */
const COMPONENTS: Components = {
  h1: ({ children }) => <h1 className="mt-5 mb-2 text-xl font-medium">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-5 mb-2 text-lg font-medium">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-4 mb-2 text-base font-medium">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-4 mb-1.5 text-sm font-medium">{children}</h4>,
  p: ({ children }) => <p className="my-2 leading-7">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="leading-7">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-border pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-border-soft" />,
  // `pre` 是代码块的外层容器。内层的 `code` 会拿到同一套行内样式，因此在这里用
  // 任意变体把它压回透明，否则代码块会得到「灰底里再套一层灰底」的双重内边距。
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto rounded-md border border-border bg-secondary p-3 text-xs leading-6 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit">
      {children}
    </pre>
  ),
  // 行内代码。`remark-gfm` 下的任务列表勾选框不经过这里，见下面的 `input`。
  code: ({ children }) => (
    <code className="rounded-md bg-secondary px-1.5 py-0.5 font-mono text-xs">{children}</code>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-foreground underline underline-offset-2"
    >
      {children}
    </a>
  ),
  // GFM 任务列表。**渲染成禁用态**：这是一份预览，勾选框只表示原文里写的是 `[x]`
  // 还是 `[ ]`。可点的话用户会以为它能改，而改动无处可存 —— 真正的勾选在事件
  // 板块（T3-11），那里有写回的地方。
  input: ({ checked }) => (
    <input
      type="checkbox"
      checked={checked === true}
      disabled
      readOnly
      className="mr-1.5 size-3.5 align-middle"
    />
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border bg-secondary px-2 py-1 text-left font-medium">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
}

/**
 * 空的预览位。
 *
 * 单独给一句话而不是渲染成一个空容器：编辑区的右半边在刚新建、还没打字时是空的，
 * 一块没有任何内容的白底看起来像渲染失败。这句提示只在**原文为空**时出现，
 * 原文是几个空格时不会 —— 那样预览区会显得时有时无。
 */
export function MarkdownPreview({
  content,
  className,
}: {
  content: string
  className?: string | undefined
}) {
  if (content.trim() === '') {
    return (
      <p className={cn('text-sm text-muted-foreground-weak', className)}>
        预览会显示在这里。支持标题、列表、引用、代码块、表格与任务列表。
      </p>
    )
  }

  return (
    // `break-words` 兜住超长 URL：Markdown 允许一行里出现一个几千字符的链接，
    // 没有它，预览会把整块编辑区横向撑开。
    <div className={cn('text-sm break-words', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
