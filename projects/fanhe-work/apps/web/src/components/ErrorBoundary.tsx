import { Component, type ErrorInfo, type ReactNode } from 'react'

import { ErrorPage } from '../pages/ErrorPage'

type ErrorBoundaryProps = { children: ReactNode }

type ErrorBoundaryState = { failed: boolean }

/**
 * 渲染期异常的最后一道拦截。
 *
 * **为什么必须有它。** React 在渲染期抛出的异常，若没有边界接住，会一路冒到根节点
 * 并把整棵组件树卸载，表现是整页白屏。而这类故障恰好躲过了前面所有关卡：类型检查
 * 看不出运行期的分支，生产构建照常通过，接口也照常返回 200。项目里那套浏览器级
 * 验证正是为这一层写的（见 `test/e2e-auth.mjs`），本组件把「白屏」换成一句能看懂的
 * 话和两个出口，让用户至少知道发生了什么、能往哪走。
 *
 * **只能是类组件。** React 至今没有提供等价的 Hook，`componentDidCatch` 与
 * `getDerivedStateFromError` 只在类上存在。这是本仓库里唯一的类组件，属语言层面的
 * 限制，不是风格选择。
 *
 * **它不替代服务端校验，也不捕获所有异常。** 事件处理器里的异常、异步回调里的异常
 * 与自身抛出的异常都不会走到这里，这几类由各自的调用点处理。
 *
 * 三个成员带 `override` 是因为仓库开了 `noImplicitOverride`。它挡的是「父类改了成员
 * 名、子类还写着旧名」这类静默失效：少了它，改错的覆写会变成一个谁也不会读的新方法，
 * 而类型检查一声不吭。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 原文只进控制台，不上界面。生产环境这里会换成上报通道，本期没有上报端点，
    // 先把堆栈留在开发者能拿到的地方。
    console.error('渲染期异常', error, info.componentStack)
  }

  /** 原地重试：清空失败标记让子树重新渲染。异常若可复现会再次被接住。 */
  private readonly retry = (): void => {
    this.setState({ failed: false })
  }

  override render(): ReactNode {
    if (this.state.failed) return <ErrorPage onRetry={this.retry} />
    return this.props.children
  }
}
