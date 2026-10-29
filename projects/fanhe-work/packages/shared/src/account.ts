/**
 * 账号标识的规则。
 *
 * 放在共享包里而不是各写一份，是因为它有三处使用方：服务端的登录查询、服务端的
 * 账号创建、前端的输入提示。三处各写一份的结果是「前端说可以，后端说不行」这类
 * 只在联调时暴露的不一致，而且每一处都要单独维护。
 *
 * 唯一约束仍然建在数据库列上。这里的规则负责把输入变成可比较的形式，库侧的约束
 * 是最后一道防线，两者不重复：规则可以变，约束一旦建成就很难改。
 */

/** 账号名长度下限。太短的标识在日志与界面上难以区分。 */
export const USERNAME_MIN_LENGTH = 3
/** 账号名长度上限。与 `users.username` 的 VarChar(64) 一致。 */
export const USERNAME_MAX_LENGTH = 64

/**
 * 账号名允许的字符，首字符必须是字母或数字。
 *
 * 限定字符集的收益不在输入环节，而在它出现过的所有地方：日志、URL、导出的文件、
 * 命令行参数。放开字符集意味着这些地方都要处理转义与编码问题，换来的只是「可以用
 * 中文当账号名」这一点便利。中文更适合放在 displayName 里，那里没有标识语义。
 */
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

/**
 * 把账号名归一到存储形式。
 *
 * PostgreSQL 的 text 等值比较区分大小写。不做归一时，`Admin` 与 `admin` 会是两个
 * 不同的账号：用户以为自己只注册了一个名字，实际存在两个，而且登错那一个得到的
 * 提示是「密码错误」，把人引向完全错误的方向。
 *
 * 归一放在应用层而不是数据库侧（例如 citext 类型或 lower() 表达式索引），因为
 * 归一规则将来可能变化，而索引表达式一旦建成就很难改。库侧只保留唯一约束。
 *
 * 用 `toLowerCase` 而不是 `toLocaleLowerCase`。后者在土耳其语环境下会把 `I` 变成
 * `ı`，而账号名是标识，它的归一结果必须与运行环境的区域设置无关。
 */
export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase()
}

/**
 * 判断一个账号名是否合法。传入的应当是 `normalizeUsername` 的结果。
 *
 * 分开成两个函数而不是合成一个「归一并校验」，是因为调用方对失败的处理不同：登录
 * 时账号名不合法只需按「认证失败」处理，不必告诉调用方是格式问题；创建账号时要
 * 明确报出格式错误。合成一个会让登录路径也拿到一个它不需要的错误分支。
 */
export function isValidUsername(normalized: string): boolean {
  return (
    normalized.length >= USERNAME_MIN_LENGTH &&
    normalized.length <= USERNAME_MAX_LENGTH &&
    USERNAME_PATTERN.test(normalized)
  )
}

/**
 * 密码长度下限。
 *
 * 取 6 位是产品口径：初始密码由管理员当面转述给员工，门槛定得过高，现场就会
 * 退回「好记的短口令」或者被写在便签上。真正的强度交给「重置密码」里的随机生成
 * 按钮，那里给的是 16 位易混字符已剔除的随机串。
 *
 * 上限与登录接口一致，防止超长输入先被完整读进内存再交给 Argon2。
 */
export const PASSWORD_MIN_LENGTH = 6
export const PASSWORD_MAX_LENGTH = 512

/** 显示名长度上限。与 `users.display_name` 的 VarChar(64) 一致，允许中文。 */
export const DISPLAY_NAME_MAX_LENGTH = 64
