import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
/*
 * 字体**自托管**（@fontsource-variable），不走 Google Fonts：
 * 一是国内访问 fonts.googleapis.com 基本不通，二是多一个运行时外部依赖
 * 就多一种「字体没加载出来」的静默降级。这些包把 woff2 打进产物里，
 * 按 unicode-range 分片，浏览器只下用得上的那几片。
 *
 * - **DM Sans** —— 正文（--font-sans）
 * - **Space Grotesk** —— 标题与数字（--font-display）
 *
 * 两者都**不含汉字**，所以中文一律回落到系统字体（雅黑/苹方）。这是有意的：
 * 引一套 CJK 可变字体要多几 MB，而系统那套本来就更好看。
 *
 * 必须在 styles.css 之前 import：styles.css 里的 `--font-sans` /
 * `--font-display` 引用的家族名（`DM Sans Variable` / `Space Grotesk Variable`）
 * 由它们注册。名字写错的话浏览器会一声不响地跳过，整页回落——不报错。
 */
import '@fontsource-variable/dm-sans'
import '@fontsource-variable/space-grotesk'
import App from './App.js'
import './styles.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root 不存在')

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
