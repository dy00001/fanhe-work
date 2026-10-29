import { ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { CaseAlbumItem } from '../../lib/case-library-display'

/**
 * 放大查看。
 *
 * **交互按用户描述定的：点图片或点空白处都回到网格。** 上一版是「左边一张大图 + 底部
 * 缩略条 + 左右翻页」，看图时要先选中再放大，来回两步；现在网格本身就是浏览界面，
 * 放大只承担「看清细节」这一件事，看完随手一点就退回去，不需要精确点到某个按钮。
 *
 * 覆盖在弹窗内容层之上而不是另开一个 `Dialog`：另开一个根要处理两套滚动锁、两套
 * 焦点管理，还会出现「关掉放大层时整个图集也跟着关」的层级问题。这里只是内容层里的
 * 一个绝对定位块，Dom 上仍是同一个弹窗。
 *
 * **Esc 必须被这里截住。** Radix 在内容层上听 Escape 来关闭弹窗，而用户此刻的意图是
 * 「退出放大」。因此在 window 的捕获阶段拦下来并 `stopPropagation` —— 捕获阶段在
 * document 的冒泡监听之前跑，事件走不到 Radix 那里。用 React 的 `onKeyDown` 做不到
 * 这一点：那需要焦点正好在放大层里面，而刚点开时焦点还在被点的缩略图上。
 */
export function CaseLightbox({
  items,
  index,
  onClose,
  onStep,
}: {
  items: readonly CaseAlbumItem[]
  index: number
  onClose: () => void
  onStep: (delta: 1 | -1) => void
}) {
  const many = items.length > 1

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (!many) return
      if (event.key === 'ArrowLeft') {
        event.stopPropagation()
        onStep(-1)
      }
      if (event.key === 'ArrowRight') {
        event.stopPropagation()
        onStep(1)
      }
    }
    // 捕获阶段：见上面那段注释，晚一步就抢不过 Radix 的关闭逻辑。
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
    }
  }, [many, onClose, onStep])

  const current = items[index]
  if (current === undefined) return null

  return (
    <div
      // 整层可点：图片与空白处都触发 `onClose`，因为图片没有自己的点击处理。
      onClick={onClose}
      className="absolute inset-0 z-20 flex flex-col bg-[color-mix(in_srgb,var(--foreground)_82%,transparent)] p-4 backdrop-blur-sm"
    >
      <div className="flex items-center justify-between px-2 pb-2 text-xs text-background/80">
        <span>{many ? `${index + 1} / ${items.length}` : '共 1 张'}</span>
        <span className="hidden sm:inline">点击图片或空白处返回 · ← → 翻看</span>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onClose()
          }}
          aria-label="返回图集"
          className="grid size-8 place-items-center rounded-full text-background/80 hover:bg-background/15 hover:text-background"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="grid min-h-0 flex-1 place-items-center">
        {/* `key` 按图片 id 换：加载态记在子组件里，不 key 的话切到下一张时上一张的
            「已加载」会留在状态里，新图没到也显示成加载完成。 */}
        <LightboxImage key={current.id} src={current.src} alt={current.alt} />
      </div>

      {many && (
        <>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onStep(-1)
            }}
            aria-label="上一张"
            className="absolute top-1/2 left-4 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-background/20 text-background hover:bg-background/35"
          >
            <ChevronLeft className="size-5" />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onStep(1)
            }}
            aria-label="下一张"
            className="absolute top-1/2 right-4 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-background/20 text-background hover:bg-background/35"
          >
            <ChevronRight className="size-5" />
          </button>
        </>
      )}
    </div>
  )
}

/**
 * 原图。**按需加载**：只有用户点开这一张，才发出这一次请求。
 *
 * 三种状态都要有画面，缺一个就会出现「点了没反应」：
 *   - 加载中：转圈 + 一句「正在加载原图」。原图走网络，跨隧道时要几百毫秒。
 *   - 失败：一句话 + 重试按钮。这条路径一定会被遇到（地铁里、隧道掉线），
 *     而它现在的表现是空白一片 —— 用户会以为图坏了，实际只是没下下来。
 *   - 成功：图片本身。
 *
 * 点击图片仍然冒泡到外层关闭放大层（加载中与失败时也一样）：这是用户说的「再次点击
 * 图片缩小返回」，不能因为状态不同就换一套交互。
 */
function LightboxImage({ src, alt }: { src: string; alt: string }) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed'>('loading')
  /** 重试计数。它进 `key` 强制浏览器重新发起一次请求，绕开失败的缓存条目。 */
  const [attempt, setAttempt] = useState(0)

  return (
    // 相对容器：占位层叠在图片上，而不是与图片各占一行。图片一进来就撑开尺寸，
    // 因此转圈的位置就是图片最终出现的位置，不会在加载完成瞬间跳一下。
    <div className="relative grid h-[min(60vh,640px)] w-full place-items-center">
      <img
        key={attempt}
        src={src}
        alt={alt}
        decoding="async"
        onLoad={() => setPhase('ready')}
        onError={() => setPhase('failed')}
        className={[
          'max-h-full w-auto max-w-full rounded-lg object-contain shadow-2xl transition-opacity',
          // 加载完成前不显示半张图：铺在深色背景上比转圈更迷惑。
          phase === 'ready' ? 'opacity-100' : 'opacity-0',
        ].join(' ')}
      />

      {phase !== 'ready' && (
        <div
          // 这一层要吃掉点击 —— 否则点「重试」会先把放大层关掉（外层整块是关闭区）。
          onClick={(event) => {
            event.stopPropagation()
          }}
          className="absolute inset-0 grid place-items-center"
        >
          {phase === 'loading' ? (
            <div className="flex flex-col items-center gap-2 text-xs text-background/70">
              <Loader2 className="size-5 animate-spin" />
              正在加载原图
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 text-sm text-background/85">
              <span>原图加载失败，可能是网络不通</span>
              <button
                type="button"
                onClick={() => {
                  setPhase('loading')
                  setAttempt((value) => value + 1)
                }}
                className="rounded-md border border-background/40 px-3 py-1.5 text-xs hover:bg-background/15"
              >
                重试
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
