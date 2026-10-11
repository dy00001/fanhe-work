/// <reference types="vite/client" />

/**
 * 构建期注入的常量，取值见 `vite.config.ts` 的 `define`。
 *
 * 在这里声明而不是在 `lib/version.ts` 里就地声明：它们是**全局**标识符（`define`
 * 做的是源码文本替换，不是模块导入），声明放在模块里会让人以为要从那个模块导入。
 *
 * 类型都是 `string` 而不是字面量联合：取值来自构建过程，编译器不可能知道具体是什么。
 * 运行时缺值（例如直接把 `src/lib` 拿给 Node 跑测试）由 `lib/version.ts` 兜底，
 * 不在这里声明成可选 —— 声明成可选会让每个使用点都要写一次判空。
 */
declare const __APP_VERSION__: string
declare const __BUILD_TIME__: string
declare const __COMMIT_SHA__: string
