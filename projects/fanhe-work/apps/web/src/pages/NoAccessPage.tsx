import { ShieldOff } from 'lucide-react'

import { useAuth } from '../auth/useAuth'
import { EmptyState } from '../components/StateView'
import { Button } from '../components/ui/button'

/**
 * 没有任何可访问模块时的兜底界面。
 *
 * 走得到这里的情形只有一种：当前账号不持有任何模块的权限，可见清单为空。当前
 * 四个内置角色都至少持有 personal 段权限，所以它暂时不可达 —— 但分支不能省。
 * 可见清单为空时若直接解引用第一项，运行期会在离原因很远的地方抛出，而那时
 * 已经很难看出问题出在权限配置上。
 *
 * **给出「退出登录」而不是只写一句话。** 这一页没有侧栏项、没有面包屑可点，是
 * 整个应用里唯一一个四面都没有出口的界面。文案里让用户「退出后重新登录」，那
 * 就把这件事做成按钮 —— 权限刚被调整过的人只需要重登一次，不该让他自己去顶栏
 * 的账号菜单里找。
 *
 * 呈现交给 `EmptyState`，与 404、500、占位页共用同一套排版。
 */
export function NoAccessPage() {
  const { logout } = useAuth()

  return (
    <EmptyState
      icon={ShieldOff}
      title="没有可访问的模块"
      description="当前账号没有任何模块的权限，请联系管理员分配角色。若刚刚被调整过权限，退出后重新登录即可生效。"
      action={
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void logout()
          }}
        >
          退出登录
        </Button>
      }
    />
  )
}
