import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * 类名合并。
 *
 * `clsx` 处理条件与数组，`twMerge` 解决**后写的类要盖住先写的**——
 * 没有它的话 `cn('p-4', 'p-2')` 会同时留下两个类，实际生效的取决于
 * Tailwind 生成 CSS 的顺序而不是书写顺序，表现为「传了 props 但样式没变」。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
