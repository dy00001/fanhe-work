# -*- coding: utf-8 -*-
"""T2-07 文档同步：一次性完成 HANDOFF-2026-10-10.md 的几处改动。

用脚本而不是逐处手工编辑，是因为任务表与文件清单里有大量对齐空格，
逐处手写容易匹配不上。行尾风格按原文件保持。

本文件由 .tmp 归档而来（原版把 HANDOFF 的路径写死在 E: 盘），改成向上查找 .ws-root
推导出的工作区根。

**这是一次性脚本，已经执行完毕。** 它按「旧串必须恰好匹配 1 处」逐条替换；重复执行
时旧串已不存在，脚本会打印匹配为 0 并 exit 1，**不会写文件**，但也就没有第二次用途了。
它留下的价值是记录当初到底改了哪几处。
"""
import io
import os
import sys


def find_workspace_root(start):
    """向上查找 .ws-root。受版本控制的文件不写盘符，脚本要跟着介质换机器。"""
    d = start
    while True:
        if os.path.exists(os.path.join(d, '.ws-root')):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            raise SystemExit('未找到 .ws-root，请把脚本放回工作空间内运行')
        d = parent


_ROOT = find_workspace_root(os.path.dirname(os.path.abspath(__file__)))
PATH = os.path.join(_ROOT, 'projects', 'fanhe-work', 'docs', 'HANDOFF-2026-10-10.md')

raw = io.open(PATH, 'rb').read()
crlf = b'\r\n' in raw
s = raw.decode('utf-8').replace('\r\n', '\n')

fails = []


def rep(old, new, label):
    global s
    n = s.count(old)
    if n != 1:
        fails.append('%s（匹配 %d 处）' % (label, n))
        return
    s = s.replace(old, new, 1)


rep('——T2-01 至 T2-06 完成', '——T2-01 至 T2-07 完成', '阶段二小节标题')

rep(
    '**阶段二只剩一项**：T2-07 主题令牌（P2）。验收清单 5 项已全部勾选。T2-07 完成后阶段二收口，可进入阶段三。',
    '**阶段二至此收口**：T2-01 至 T2-07 全部完成，验收清单 6 项全部勾选（本期补了一项「亮暗主题可切换，切换后无对比度异常」）。下一阶段是阶段三（个人工作台三板块）。',
    '阶段二收口句',
)

rep(
    '判断与首帧断言的实现见 `DEVELOPMENT-PLAN.md` 9.26。',
    '判断与首帧断言的实现见 `DEVELOPMENT-PLAN.md` 9.26。\n\n'
    '**T2-07 的交付物**：亮暗两套设计令牌 —— `index.css` 的 `.dark` 块覆盖 `:root` 的全部颜色原始值（组件侧一行未改），`index.html` 的主题初值内联脚本，`lib/theme.ts`（解析与生效，含系统配色变化监听），`lib/preferences.ts` 的主题读写，以及顶栏的三档切换菜单。判断见 `DEVELOPMENT-PLAN.md` 9.27。',
    'T2-07 交付物段',
)

rep('目前存侧栏折叠状态', '目前存侧栏折叠状态与主题偏好', '偏好模块描述')

rep('36 项断言，见 9.18 至 9.26', '42 项断言，见 9.18 至 9.27', '端到端项数')

rep('### 5.1 下一步是 T2-07 主题令牌', '### 5.1 下一步是阶段三（个人工作台三板块）', '5.1 标题')

rep(
    '阶段二前六项已完成，按编号顺序下一项是 **T2-07 主题令牌**（P2）：在 `apps/web/src/index.css` 加一个 `.dark` 块覆盖 `:root` 的同名原始值，做出亮暗两套令牌。T2-01 的两层结构就是为这一步准备的，组件侧一行都不用动 —— 这是当时把原始值与 `@theme inline` 映射拆开的唯一理由。',
    '阶段二已收口，按顺序下一阶段是 **阶段三**，任务表见 `DEVELOPMENT-PLAN.md` 第七章。开工前有两条可复用的现成结构：**本机界面偏好一律走 `lib/preferences.ts`**（侧栏折叠与主题都在里面，键前缀 `fanhe-work.ui.`），不要在组件里直接碰 localStorage；**要求首帧就正确的状态不能等 React** —— 折叠走 `useState` 惰性初始化，主题走 `index.html` 的内联脚本，这两类闪烁在事后断言里都看不出来，见 9.26 与 9.27。',
    '5.1 第一段',
)

rep(
    '**这也是阶段二的最后一项。** 完成后阶段二收口，可进入阶段三（个人工作台三板块）。',
    '**阶段三的界面部分会大量用到阶段二这层结构**：设计令牌只有 `index.css` 一处来源（`:root` 与 `.dark` 两套，新增颜色要两边都写），组件从 `src/components/ui/` 取，状态页用 `components/EmptyState.tsx`，模块页面的呈现方式由路由按 `planned` 分派。新增模块只改共享包 `navigation.ts` 一处，路由表与侧栏会自动跟上。',
    '5.1 第二段',
)

rep(
    '两处可以直接复用的现成结构：`lib/preferences.ts` 已经承担本机界面偏好的读写，主题偏好按同族键名（`fanhe-work.ui.theme`）加一对函数即可；`AppShell` 的折叠状态演示了「偏好读取必须走 `useState` 惰性初始化」这条要求，主题同理 —— 放进 `useEffect` 会让每次刷新先闪一帧亮色（或暗色），而事后断言看不出来。\n\n',
    '',
    '5.1 第三段（并入前两段后删除）',
)

rep(
    "**一处需要提前想清楚的设计。** 若做「跟随系统」这一档，**不能把它持久化成 `'light'` / `'dark'`**，否则用户改了系统设置而界面不动。那一档要存成第三个值，并在读取时监听 `prefers-color-scheme` 的变化。",
    '**一处需要提前想清楚的设计（阶段三会遇到）。** 阶段三引入的界面以数据驱动的列表为主，它们的空态、加载态与错误态会反复出现。`EmptyState` 目前只覆盖「空」，**加载态与错误态还没有统一实现** —— 落地第一个列表页时就该把这两态一并收敛，否则会先散在几个页面里，之后再收比一开始就统一贵得多。',
    '5.1 第四段',
)

rep(
    'T2-01 至 T2-06 已完成，验收清单 5 项**已全部勾选**，只剩 T2-07 主题令牌这一项任务未做。',
    'T2-01 至 T2-07 已全部完成，**阶段二收口**，验收清单 6 项全部勾选（本期补了一项「亮暗主题可切换，切换后无对比度异常」）。',
    '5.3 首句',
)

rep(
    '改用 CDP 注入逐帧采样器看首帧，见 9.26。',
    '改用 CDP 注入逐帧采样器看首帧，见 9.26。T2-07 把这条经验用到了另一件事上，同时暴露出一个只属于它的坑：主题采样器是无条件逐帧记录的，几帧就攒满了，而那时重载后的「初始化状态 + 静默续期」往返还没走完，紧接着点按钮会报「找不到元素」—— **等待条件要等的是「依赖就绪」，不是「某个数字够了」**，见 9.27。',
    '5.3 教训句',
)

# 行级插入：阶段二任务表、前端文件清单、index.html 行
lines = s.split('\n')
out = []
done_table = False
done_lib = False
done_html = False
for line in lines:
    if line.startswith('| T2-06 | 折叠偏好记忆'):
        out.append(line)
        out.append(
            '| T2-07 | 主题令牌 | `src/index.css`（`@custom-variant dark` 与 `.dark` 块）、`index.html`（主题初值内联脚本）、`src/lib/theme.ts`、`src/lib/preferences.ts`（主题读写）、`src/components/TopBar.tsx`（三档菜单） | 端到端 6 项 |'
        )
        done_table = True
        continue
    if line.startswith('| `src/lib/preferences.ts`'):
        out.append(line)
        out.append(
            '| `src/lib/theme.ts` | **主题的解析与生效**：`resolveTheme` 把偏好解析成亮暗，`applyTheme` 落到 `<html>` 的类名上，`useTheme` 组合两者并监听系统配色变化。初值不在模块里，见 `index.html` 与 `DEVELOPMENT-PLAN.md` 9.27 | 是 |'
        )
        done_lib = True
        continue
    if line.startswith('| `index.html`'):
        out.append(
            '| `index.html` | 入口 HTML。**含主题初值的内联脚本** —— 它在样式生效前定下配色，与 `lib/preferences.ts` 的判断刻意重复，改键名时两处要一起改 | 是 |'
        )
        done_html = True
        continue
    out.append(line)

if not (done_table and done_lib and done_html):
    fails.append('行级插入：table=%s lib=%s html=%s' % (done_table, done_lib, done_html))

s = '\n'.join(out)

if fails:
    print('失败：')
    for item in fails:
        print('  - ' + item)
    sys.exit(1)

if crlf:
    s = s.replace('\n', '\r\n')
io.open(PATH, 'wb').write(s.encode('utf-8'))
print('HANDOFF 已更新（行尾 %s）' % ('CRLF' if crlf else 'LF'))
