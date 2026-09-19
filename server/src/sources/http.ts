/**
 * 抓国内站点要用的请求头。
 *
 * 百度热搜、搜狗微信、B站 这三个站点都会看 `User-Agent` 决定给不给你内容：
 * `ai-hot/0.1` 这种自报家门的 UA 会直接拿到验证码页或 403，而
 * `github-trending.ts` 里那个 `Mozilla/5.0 (compatible; ai-hot/0.1)` 也不行——
 * 它是给 GitHub 预备的。
 *
 * 用真实的 Chrome UA 不是为了伪装成浏览器去绕过什么，而是这几个站点的
 * **公开页面本来就只对浏览器渲染**，抓到的也是任何人打开网页都能看到的内容。
 * 仍然如实带上 `referer`，让对方的访问日志能看出这些请求来自哪里。
 */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** 浏览器风格的请求头。`referer` 缺省不带——凭空编一个来源比不带更糟。 */
export function browserHeaders(referer?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'user-agent': BROWSER_UA,
    // 中文站普遍按这个头做内容协商，不带的话可能拿到繁体或英文页
    'accept-language': 'zh-CN,zh;q=0.9',
  }
  if (referer !== undefined) headers['referer'] = referer
  return headers
}
