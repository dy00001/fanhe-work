// 确认 os.tmpdir() 在这个环境里到底指向哪里。
//
// 工作区入口会把 TEMP / TMP 重定向到介质上的 .tmp\，所以 os.tmpdir() 不再等于
// 系统临时目录 —— 任何依赖它落盘的东西（构建产物、下载缓存）都会写到 U 盘上。
// 要让产物落到系统盘，得从 LOCALAPPDATA 自己推。
//
// 本文件由 .tmp 归档而来，原样保留：它本来就不含绝对路径。

import { tmpdir } from 'node:os'

console.log('tmpdir =', tmpdir())
console.log('TEMP   =', process.env.TEMP)
console.log('TMP    =', process.env.TMP)
