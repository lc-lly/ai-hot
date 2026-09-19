import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 后端固定端口，契约 §1：HTTP 与 WS 共用同一个 http.Server
const BACKEND = 'http://localhost:8787'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    /*
     * 代码分割。加这一段之前整个应用是**单个 327KB 的 chunk**——所有组件
     * 都是静态 import，连 `SearchPanel` 那个「延迟挂载」也只是条件渲染，
     * 模块照样在首屏包里。
     *
     * `motion` 是 Aceternity 组件的运行时，约 45KB gz。它是纯装饰性的，
     * 页面在它到达之前就应该已经可读，所以必须切出去、不能占首屏关键路径。
     *
     * **切块本身不会让它晚到，配套的 `React.lazy` 才会。** 这两件事经常被
     * 混为一谈：`manualChunks` 只决定产物怎么**分文件**，只要还有一条静态
     * `import` 链指向它，那个文件就仍然在首屏被请求。真正让它延后的是
     * `import()`。本仓库的两个边界在：
     * - `components/HotspotCard.tsx`（`CardSpotlight`，外加触屏/reduced-motion 的跳过）
     * - `components/StatCards.tsx`（`NumberTicker`）
     *
     * 全站只有这两个文件 import `motion/react`，所以堵住这两处，
     * `motion` chunk 就彻底不在关键路径上了。
     */
    rollupOptions: {
      output: {
        /*
         * `react` 留下，`motion` **刻意不列**——这一条是踩出来的。
         *
         * 直觉上「把 motion 单独切成一个 chunk」正是我们要的，但它会**反过来
         * 毁掉延迟**：一旦 `motion` 成了一个具名的顶层 chunk，Rollup 的
         * `hoistTransitiveImports`（默认开启）就把它当成入口的传递依赖，
         * **提升成 index chunk 里的一条静态 `import`**，Vite 随即在
         * index.html 里插一条 `<link rel="modulepreload">`。
         * 结果是这个 chunk 在首屏就被请求了——切得越干净，到得越早。
         *
         * 不列它，Rollup 的自动分包反而做得对：`motion` 只被
         * `NumberTicker` 和 `CardSpotlight` 两个**动态** chunk 引用，
         * 于是它自然成为一个只经动态路径到达的共享 chunk，不进 index.html。
         *
         * 判据不是「产物里有没有 motion-*.js」（两种情况都有），
         * 而是 **index.html 里有没有它的 modulepreload**。
         */
        manualChunks: {
          react: ['react', 'react-dom'],
        },
      },
    },
    // 默认 500KB 的警告线对分包后的产物没意义，调低到 300KB 好及时发现回退
    chunkSizeWarningLimit: 300,
  },
  server: {
    port: 5173,
    proxy: {
      // `ws: true` 让将来挂在 /api 下的 WS 端点也能穿过 dev server。
      // 契约 §2 的端点是 `ws://host/ws`（不在 /api 下），所以下面还要单开一条；
      // 少了那条，前端连不上 WS，会静默退化成轮询。
      '/api': {
        target: BACKEND,
        changeOrigin: true,
        ws: true,
      },
      '/ws': {
        target: BACKEND,
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
