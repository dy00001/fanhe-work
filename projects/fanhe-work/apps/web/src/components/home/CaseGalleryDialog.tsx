import { Image as ImageIcon } from 'lucide-react'

import { CASE_CATEGORIES } from '../../lib/case-catalog'
import { DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

/**
 * 「全部品类」窗口（原型编号 9）。
 *
 * 只画窗口内容，不画根与触发器。入口按钮在区块头部，而 Radix 的 `DialogTrigger` 必须
 * 与 `Dialog` 处在同一个上下文里才能完成两件事：打开时把 `aria-expanded` /
 * `aria-controls` 挂到按钮上，关闭时把焦点还给它——后者手写不出来，Radix 是在关闭
 * 动画结束后自己调的。把根与触发器留在 {@link CaseGallery} 里、这里只导出内容，是让
 * 这两件事各归其位的最短路径。
 *
 * **为什么弹窗里只摆 9 张品类卡，不再像之前那样再撒 27 个案例位。** 这一阶段没有案例
 * 库（见 `docs/NEXT-TASKS-2026-10-12.md` 的 U-01），把 27 张占位卡排出来用户看到的也
 * 只是「封面待补 + 案例编号」三遍——9 个品类本身没有真实信息可看。弹窗的本意是给出
 * 「主页先看到 4 张、其它还有 5 张」的全景；9 张品类卡摆出来已经达成这件事，再叠加 27
 * 张假数据反而把本意冲淡。
 *
 * **弹窗与主页走同一份数据、同一款卡片样式。** 主页横滑条与这里都从 `CASE_CATEGORIES`
 * 读品类，封面位的比例、圆角、边框、配色、占位图标与文字逐一对齐主页——从首页点开弹窗
 * 看到的卡片，与首页自己滚动露出的卡片，看起来是同一组素材，而不是「主页一个样式、弹
 * 窗另一个样式」的双轨制。`category.name` 直接复用，不需要在数据层再加一层标题。
 */
export function CaseGalleryDialogContent() {
  return (
    <DialogContent
      className={[
        // 默认 `sm:max-w-lg` 太窄放不下三列卡。这里沿用之前那个 `min(1120px,92vw)`
        // ——宽度本身就是对着九张卡反推出来的，没理由改。
        'max-h-[88vh] gap-0 p-0 sm:max-w-[min(1120px,92vw)]',
        // 两段式：头部固定、网格在剩余空间里。整块一起滚动会让用户滚到第三行时看不到
        // 标题与关闭按钮，三行本来就装得下，不需要内部滚动。两段比三段少一层状态（之前
        // 的筛选行跟着内容一起滚，滚到第 7 个品类用户就切不了品类——同样的隐患）。
        'grid-rows-[auto_minmax(0,1fr)]',
      ].join(' ')}
    >
      <DialogHeader className="px-6 pt-6 pb-4">
        {/* `pr-8` 给右上角的关闭按钮让位。 */}
        <DialogTitle className="pr-8 text-left">全部品类</DialogTitle>
        <DialogDescription className="text-left">
          共 9 个品类。封面与内容尚未接入，先按品类占位。
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 overflow-y-auto px-6 pt-5 pb-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {CASE_CATEGORIES.map((category) => (
            <article key={category.id} className="flex min-w-0 flex-col">
              {/* 封面位与主页严格同款：aspect-ratio 400/234、border、bg 双层
                  color-mix、占位图标的 size 与圆角、占位文字的字号与色阶，逐项
                  照抄。这样弹窗里看到的「封面待补」与首页横滑里看到的是同一个位。 */}
              <div className="flex aspect-[400/234] w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl border border-border bg-[color-mix(in_srgb,var(--m-neutral)_4%,var(--card))]">
                <span className="grid size-10 place-items-center rounded-xl bg-[color-mix(in_srgb,var(--m-neutral)_var(--wash),var(--card))] text-m-neutral">
                  <ImageIcon className="size-5" />
                </span>
                <span className="text-sm text-muted-foreground-weak">封面待补</span>
              </div>
              {/* 标题行也是主页的同款：mt-2、h-6（防字号变动撑开网格）、居中、16/500/24。
                  grid 用 sm:grid-cols-3 时三行整齐，不存在一行只有一张卡的尾巴，所以高
                  度固定是合理的。 */}
              <div className="mt-2 h-6 text-center text-base leading-6 font-medium">
                {category.name}
              </div>
            </article>
          ))}
        </div>
      </div>
    </DialogContent>
  )
}
